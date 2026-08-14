"""Thread-safe lifecycle for user interactions that pause an agent turn.

The gateway raises several blocking prompts (collect, approval-like browser
handoff, sudo, and secret capture). Historically they were spread across three
global dictionaries, which made reconnect replay and idempotent responses
impossible. This module owns the common state machine without knowing anything
about JSON-RPC or the desktop renderer.
"""

from __future__ import annotations

from dataclasses import dataclass, field
import threading
import time
import uuid
from typing import Any, Callable


WAITING = "waiting"
TERMINAL_STATUSES = frozenset(
    {"submitted", "skipped", "cancelled", "expired", "interrupted"}
)


@dataclass
class PendingInteraction:
    request_id: str
    session_id: str
    event: str
    payload: dict[str, Any]
    status: str = WAITING
    created_at: float = field(default_factory=time.time)
    finished_at: float | None = None
    response: str = ""
    revision: int = 0
    signal: threading.Event = field(default_factory=threading.Event, repr=False)

    @property
    def kind(self) -> str:
        return self.event.removesuffix(".request")

    def public_payload(self) -> dict[str, Any]:
        """Return renderer-safe request metadata, never the submitted answer."""
        return {
            **self.payload,
            "request_id": self.request_id,
            "session_id": self.session_id,
            "event": self.event,
            "kind": self.kind,
            "status": self.status,
            "created_at": self.created_at,
            "interaction_revision": self.revision,
        }


@dataclass(frozen=True)
class InteractionResult:
    status: str
    response: str = ""


class PendingInteractionRegistry:
    """Own pending interaction state for one gateway process."""

    def __init__(self, *, completed_ttl_seconds: float = 600.0) -> None:
        self._completed_ttl_seconds = max(0.0, float(completed_ttl_seconds))
        self._items: dict[str, PendingInteraction] = {}
        self._lock = threading.RLock()
        # A renderer can stay alive while the gateway process restarts.  Pair
        # the monotonic revision with a process-local epoch so a fresh registry
        # is never mistaken for an older snapshot from the previous process.
        self._epoch = uuid.uuid4().hex
        self._revision = 0

    def _advance_locked(self) -> int:
        self._revision += 1
        return self._revision

    @property
    def epoch(self) -> str:
        return self._epoch

    def create(
        self,
        session_id: str,
        event: str,
        payload: dict[str, Any] | None = None,
        *,
        request_id: str | None = None,
    ) -> PendingInteraction:
        self.cleanup()
        item = PendingInteraction(
            request_id=request_id or uuid.uuid4().hex,
            session_id=str(session_id or ""),
            event=str(event or "input.request"),
            payload=dict(payload or {}),
        )
        item.payload.pop("request_id", None)
        with self._lock:
            if item.request_id in self._items:
                raise ValueError(f"duplicate interaction id: {item.request_id}")
            item.revision = self._advance_locked()
            self._items[item.request_id] = item
        return item

    def get(self, request_id: str) -> PendingInteraction | None:
        with self._lock:
            return self._items.get(str(request_id or ""))

    def pending_for_session(self, session_id: str) -> list[dict[str, Any]]:
        return self.pending_snapshot(session_id)[2]

    def pending_snapshot(
        self, session_id: str
    ) -> tuple[str, int, list[dict[str, Any]]]:
        """Return one atomic replay snapshot and its ordering watermark."""
        sid = str(session_id or "")
        with self._lock:
            rows = [
                item.public_payload()
                for item in self._items.values()
                if item.session_id == sid and item.status == WAITING
            ]
            epoch = self._epoch
            revision = self._revision
        return (
            epoch,
            revision,
            sorted(rows, key=lambda row: (row["created_at"], row["request_id"])),
        )

    def pending_kind(self, session_id: str) -> str:
        rows = self.pending_for_session(session_id)
        return str(rows[0]["kind"]) if rows else ""

    def respond(
        self,
        request_id: str,
        response: Any,
        *,
        status: str = "submitted",
    ) -> tuple[str, bool]:
        """Resolve once; duplicate/late responses return the recorded status."""
        if status not in TERMINAL_STATUSES:
            raise ValueError(f"invalid interaction status: {status}")
        with self._lock:
            item = self._items.get(str(request_id or ""))
            if item is None:
                return "missing", False
            if item.status != WAITING:
                return item.status, False
            # Cancel/skip/expire payloads are not useful to the waiting tool.
            # Dropping them here prevents a malformed renderer from parking
            # personal values in memory under a non-submitted status.
            item.response = (
                ""
                if status != "submitted" or response is None
                else str(response)
            )
            item.status = status
            item.finished_at = time.time()
            item.revision = self._advance_locked()
            item.signal.set()
            return item.status, True

    def wait(
        self,
        request_id: str,
        *,
        timeout: float | None,
        heartbeat: Callable[[], None] | None = None,
        poll_interval: float = 1.0,
    ) -> InteractionResult:
        item = self.get(request_id)
        if item is None:
            return InteractionResult("cancelled")

        interval = max(0.05, float(poll_interval))
        deadline = (
            None
            if timeout is None
            else time.monotonic() + max(0.0, float(timeout))
        )
        while True:
            with self._lock:
                current = self._items.get(item.request_id)
                if current is None:
                    return InteractionResult("cancelled")
                if current.status != WAITING:
                    break

            if deadline is not None:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    with self._lock:
                        current = self._items.get(item.request_id)
                        if current is not None and current.status == WAITING:
                            current.status = "expired"
                            current.finished_at = time.time()
                            current.revision = self._advance_locked()
                            current.signal.set()
                    break
                wait_for = min(interval, remaining)
            else:
                wait_for = interval

            if item.signal.wait(timeout=wait_for):
                break
            if heartbeat is not None:
                try:
                    heartbeat()
                except Exception:
                    pass

        with self._lock:
            current = self._items.get(item.request_id)
            if current is None:
                return InteractionResult("cancelled")
            response = current.response
            current.response = ""
            return InteractionResult(current.status, response)

    def cancel_session(self, session_id: str | None = None) -> int:
        sid = None if session_id is None else str(session_id)
        with self._lock:
            targets = [
                item
                for item in self._items.values()
                if item.status == WAITING and (sid is None or item.session_id == sid)
            ]
            for item in targets:
                item.status = "interrupted"
                item.finished_at = time.time()
                item.response = ""
                item.revision = self._advance_locked()
                item.signal.set()
            return len(targets)

    def cleanup(self, *, now: float | None = None) -> int:
        timestamp = time.time() if now is None else float(now)
        with self._lock:
            expired_ids = [
                request_id
                for request_id, item in self._items.items()
                if item.status != WAITING
                and item.finished_at is not None
                and timestamp - item.finished_at >= self._completed_ttl_seconds
            ]
            for request_id in expired_ids:
                self._items.pop(request_id, None)
            return len(expired_ids)
