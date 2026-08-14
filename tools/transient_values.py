"""Session-scoped, in-memory values collected for browser form actions.

The model receives only opaque ``fan-value://`` references. Raw values remain
inside this process and are resolved at the final local browser-tool boundary,
so they do not enter model context, session persistence, tool telemetry, or UI
history. References are unguessable, owner-bound, short-lived, and never
written to disk by this module.
"""

from __future__ import annotations

from dataclasses import dataclass
import re
import secrets
import threading
import time
from typing import Any
from urllib.parse import quote, quote_plus


VALUE_REF_PREFIX = "fan-value://"


@dataclass
class _TransientValue:
    owner: str
    value: str
    field_type: str
    label: str
    created_at: float
    expires_at: float
    uses: int = 0


class TransientValueStore:
    def __init__(self, *, ttl_seconds: float = 3600.0, max_items: int = 512) -> None:
        self._ttl_seconds = max(1.0, float(ttl_seconds))
        self._max_items = max(16, int(max_items))
        self._values: dict[str, _TransientValue] = {}
        self._lock = threading.RLock()

    def put(
        self,
        owner: str,
        value: Any,
        *,
        field_type: str = "text",
        label: str = "",
    ) -> str:
        raw = "" if value is None else str(value)
        if not raw:
            return ""
        now = time.time()
        token = secrets.token_urlsafe(24)
        reference = f"{VALUE_REF_PREFIX}{token}"
        with self._lock:
            self._cleanup_locked(now)
            if len(self._values) >= self._max_items:
                oldest = min(self._values, key=lambda key: self._values[key].created_at)
                self._values.pop(oldest, None)
            self._values[reference] = _TransientValue(
                owner=str(owner or "default"),
                value=raw,
                field_type=str(field_type or "text"),
                label=str(label or ""),
                created_at=now,
                expires_at=now + self._ttl_seconds,
            )
        return reference

    def resolve(self, owner: str, reference: str) -> str | None:
        if not is_value_ref(reference):
            return None
        now = time.time()
        with self._lock:
            self._cleanup_locked(now)
            item = self._values.get(reference)
            if item is None or item.owner != str(owner or "default"):
                return None
            item.uses += 1
            return item.value

    def clear_owner(self, owner: str) -> int:
        owner_key = str(owner or "default")
        with self._lock:
            references = [
                reference
                for reference, item in self._values.items()
                if item.owner == owner_key
            ]
            for reference in references:
                self._values.pop(reference, None)
            return len(references)

    def transfer_owner(self, source: str, target: str) -> int:
        """Move live references across a durable session-id rotation."""

        source_key = str(source or "default")
        target_key = str(target or "default")
        if source_key == target_key:
            return 0
        with self._lock:
            self._cleanup_locked(time.time())
            moved = 0
            for item in self._values.values():
                if item.owner == source_key:
                    item.owner = target_key
                    moved += 1
            return moved

    def redact(self, owner: str, value: Any) -> Any:
        """Return a copy with this owner's live raw values removed.

        Browser runtimes may echo a value back through DOM attributes, page
        text, URLs, or action results after it has been typed. Redacting at the
        Python/model boundary keeps those echoes out of prompt and persisted
        tool history without changing the browser's real page state.
        """

        owner_key = str(owner or "default")
        with self._lock:
            self._cleanup_locked(time.time())
            items = [
                (item.value, item.label or item.field_type or "value", item.field_type)
                for item in self._values.values()
                if item.owner == owner_key and item.value
            ]
        if not items:
            return value
        return _redact_value_tree(value, items)

    def cleanup(self, *, now: float | None = None) -> int:
        with self._lock:
            return self._cleanup_locked(time.time() if now is None else float(now))

    def _cleanup_locked(self, now: float) -> int:
        expired = [
            reference
            for reference, item in self._values.items()
            if item.expires_at <= now
        ]
        for reference in expired:
            self._values.pop(reference, None)
        return len(expired)


def is_value_ref(value: Any) -> bool:
    return isinstance(value, str) and value.startswith(VALUE_REF_PREFIX)


def _protected_label(label: str) -> str:
    clean = " ".join(str(label or "value").split())[:48]
    return f"[PROTECTED:{clean}]"


def _digit_echo_pattern(raw: str) -> re.Pattern[str] | None:
    digits = "".join(char for char in raw if char.isdigit())
    if len(digits) < 6:
        return None
    body = r"[\s().-]*".join(re.escape(digit) for digit in digits)
    return re.compile(rf"(?<!\d)\+?{body}(?!\d)")


def _redact_text(text: str, items: list[tuple[str, str, str]]) -> str:
    result = text
    for raw, label, field_type in items:
        marker = _protected_label(label)
        if result == raw:
            result = marker
            continue
        # Very short answers (for example a one-letter country code) are only
        # replaced on exact equality; substring replacement would destroy
        # unrelated page prose. Longer values are safe to remove everywhere.
        if len(raw) >= 3 and raw in result:
            result = result.replace(raw, marker)
        if len(raw) >= 3:
            for encoded in {quote(raw, safe=""), quote_plus(raw, safe="")}:
                if encoded and encoded != raw:
                    result = re.sub(
                        re.escape(encoded),
                        marker,
                        result,
                        flags=re.IGNORECASE,
                    )
        if field_type == "email" and len(raw) >= 3:
            result = re.sub(re.escape(raw), marker, result, flags=re.IGNORECASE)
        digit_pattern = _digit_echo_pattern(raw)
        if digit_pattern is not None:
            result = digit_pattern.sub(marker, result)
    return result


def _redact_value_tree(value: Any, items: list[tuple[str, str, str]]) -> Any:
    if isinstance(value, str):
        return _redact_text(value, items)
    if isinstance(value, dict):
        return {key: _redact_value_tree(item, items) for key, item in value.items()}
    if isinstance(value, list):
        return [_redact_value_tree(item, items) for item in value]
    if isinstance(value, tuple):
        return tuple(_redact_value_tree(item, items) for item in value)
    return value


store = TransientValueStore()


def current_value_owner() -> str:
    try:
        from tools.approval import get_current_session_key

        return get_current_session_key(default="default") or "default"
    except Exception:
        return "default"


def protect_value(
    value: Any,
    *,
    field_type: str = "text",
    label: str = "",
    owner: str | None = None,
) -> str:
    return store.put(
        owner or current_value_owner(),
        value,
        field_type=field_type,
        label=label,
    )


def resolve_value_ref(reference: str, *, owner: str | None = None) -> str | None:
    return store.resolve(owner or current_value_owner(), reference)


def clear_session_values(owner: str) -> int:
    return store.clear_owner(owner)


def transfer_session_values(source: str, target: str) -> int:
    return store.transfer_owner(source, target)


def redact_active_values(value: Any, *, owner: str | None = None) -> Any:
    return store.redact(owner or current_value_owner(), value)
