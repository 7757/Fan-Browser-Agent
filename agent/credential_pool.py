"""Persistent multi-credential pool for same-provider failover."""

from __future__ import annotations

import logging
import os
import random
import threading
import time
import uuid
import re
from dataclasses import dataclass, fields, replace
from datetime import datetime
from typing import Any, Dict, List, Optional, Set, Tuple

from fan_cli.config import load_env
from agent.credential_persistence import (
    is_borrowed_credential_source,
    sanitize_borrowed_credential_payload,
)
from fan_cli.auth import (
    PROVIDER_REGISTRY,
    read_credential_pool,
    write_credential_pool,
)

logger = logging.getLogger(__name__)


def _load_config_safe() -> Optional[dict]:
    """Load config.yaml, returning None on any error."""
    try:
        from fan_cli.config import load_config

        return load_config()
    except Exception:
        return None


# --- Status and type constants ---

STATUS_OK = "ok"
STATUS_EXHAUSTED = "exhausted"
# Terminal failure — the credential will never recover on its own.  Used for
# upstream-permanent OAuth states like ``token_invalidated`` / ``token_revoked``
# where retrying after a TTL cooldown is guaranteed to fail.  ``DEAD`` entries
# are excluded from rotation unconditionally and only clear when an explicit
# write-side sync (e.g. ``_save_codex_tokens`` after a fresh device-code
# login) rewrites the tokens.
STATUS_DEAD = "dead"

# OAuth error reasons that indicate the credential is permanently invalid
# server-side and cannot be recovered by retry/refresh.  Sourced from
# OpenAI Codex Responses API, xAI, and standard OAuth specifications.
_TERMINAL_AUTH_REASONS = frozenset({
    "token_invalidated",   # OpenAI Codex: "Your authentication token has been invalidated."
    "token_revoked",        # OAuth 2.0 RFC 7009: token explicitly revoked
    "invalid_token",        # RFC 6750: bearer token is malformed/expired/revoked
    "invalid_grant",        # RFC 6749: refresh_token rejected during refresh
    "unauthorized_client",  # RFC 6749: client no longer authorized
    "refresh_token_reused", # Single-use refresh token consumed by another process
})

# How long a DEAD manual credential is preserved before being pruned.
# Manual entries (``manual:*``) are independent credentials with no singleton
# to re-seed from, so pruning them after a quiet window cleans up dead state
# without losing recoverability — the user always has the option to re-add
# through provider configuration.
#
# Singleton-seeded entries (``device_code``, ``loopback_pkce``)
# are NOT pruned because ``_seed_from_singletons`` would just re-create them
# on the next ``load_pool()`` with the same stale singleton tokens, defeating
# the cleanup.  They remain in the pool marked DEAD until an explicit re-auth
# write-side sync (``_save_codex_tokens`` etc.) clears the status.
DEAD_MANUAL_PRUNE_TTL_SECONDS = 24 * 60 * 60  # 24 hours
# Refresh OAuth tokens this many seconds before expiry (proactive, avoids a
# mid-request 401). The 401 reactive-refresh path still covers surprises.
_OAUTH_REFRESH_MARGIN_SECONDS = 10 * 60  # 10 minutes

AUTH_TYPE_OAUTH = "oauth"
AUTH_TYPE_API_KEY = "api_key"

SOURCE_MANUAL = "manual"

STRATEGY_FILL_FIRST = "fill_first"
STRATEGY_ROUND_ROBIN = "round_robin"
STRATEGY_RANDOM = "random"
STRATEGY_LEAST_USED = "least_used"
SUPPORTED_POOL_STRATEGIES = {
    STRATEGY_FILL_FIRST,
    STRATEGY_ROUND_ROBIN,
    STRATEGY_RANDOM,
    STRATEGY_LEAST_USED,
}

# Cooldown before retrying an exhausted credential.
# Transient 401 auth failures cool down briefly so single-key setups can recover.
# 429 (rate-limited), 402 (billing/quota), and other failures cool down after 1 hour.
# Provider-supplied reset_at timestamps override these defaults.
EXHAUSTED_TTL_401_SECONDS = 5 * 60           # 5 minutes
EXHAUSTED_TTL_429_SECONDS = 60 * 60          # 1 hour
EXHAUSTED_TTL_DEFAULT_SECONDS = 60 * 60      # 1 hour

# Pool key prefix for custom OpenAI-compatible endpoints.
# Custom endpoints all share provider='custom' but are keyed by their
# custom_providers name: 'custom:<normalized_name>'.
CUSTOM_POOL_PREFIX = "custom:"


# Fields that are only round-tripped through JSON — never used for logic as attributes.
_EXTRA_KEYS = frozenset({
    "token_type", "scope", "client_id", "portal_base_url", "obtained_at",
    "expires_in", "tls", "secret_source", "secret_fingerprint",
})


@dataclass
class PooledCredential:
    provider: str
    id: str
    label: str
    auth_type: str
    priority: int
    source: str
    access_token: str
    refresh_token: Optional[str] = None
    last_status: Optional[str] = None
    last_status_at: Optional[float] = None
    last_error_code: Optional[int] = None
    last_error_reason: Optional[str] = None
    last_error_message: Optional[str] = None
    last_error_reset_at: Optional[float] = None
    base_url: Optional[str] = None
    expires_at: Optional[str] = None
    expires_at_ms: Optional[int] = None
    last_refresh: Optional[str] = None
    inference_base_url: Optional[str] = None
    request_count: int = 0
    extra: Dict[str, Any] = None  # type: ignore[assignment]

    def __post_init__(self):
        if self.extra is None:
            self.extra = {}

    def __getattr__(self, name: str):
        if name in _EXTRA_KEYS:
            return self.extra.get(name)
        raise AttributeError(f"'{type(self).__name__}' object has no attribute {name!r}")

    @classmethod
    def from_dict(cls, provider: str, payload: Dict[str, Any]) -> "PooledCredential":
        field_names = {f.name for f in fields(cls) if f.name != "provider"}
        data = {k: payload.get(k) for k in field_names if k in payload}
        # Rehydrated last_status_at may be an ISO string from to_dict() — normalize to float epoch
        if "last_status_at" in data and isinstance(data["last_status_at"], str):
            data["last_status_at"] = _parse_absolute_timestamp(data["last_status_at"])
        extra = {k: payload[k] for k in _EXTRA_KEYS if k in payload and payload[k] is not None}
        data["extra"] = extra
        data.setdefault("id", uuid.uuid4().hex[:6])
        data.setdefault("label", payload.get("source", provider))
        data.setdefault("auth_type", AUTH_TYPE_API_KEY)
        data.setdefault("priority", 0)
        data.setdefault("source", SOURCE_MANUAL)
        data.setdefault("access_token", "")
        return cls(provider=provider, **data)

    def to_dict(self) -> Dict[str, Any]:
        _ALWAYS_EMIT = {
            "last_status",
            "last_status_at",
            "last_error_code",
            "last_error_reason",
            "last_error_message",
            "last_error_reset_at",
        }
        result: Dict[str, Any] = {}
        for field_def in fields(self):
            if field_def.name in {"provider", "extra"}:
                continue
            value = getattr(self, field_def.name)
            if value is not None or field_def.name in _ALWAYS_EMIT:
                result[field_def.name] = value
        for k, v in self.extra.items():
            if v is not None:
                result[k] = v
        return sanitize_borrowed_credential_payload(result, self.provider)

    @property
    def runtime_api_key(self) -> str:
        return str(self.access_token or "")

    @property
    def runtime_base_url(self) -> Optional[str]:
        return self.base_url



def _next_priority(entries: List[PooledCredential]) -> int:
    return max((entry.priority for entry in entries), default=-1) + 1


def _is_manual_source(source: str) -> bool:
    normalized = (source or "").strip().lower()
    return normalized == SOURCE_MANUAL or normalized.startswith(f"{SOURCE_MANUAL}:")


def _exhausted_ttl(error_code: Optional[int]) -> int:
    """Return cooldown seconds based on the HTTP status that caused exhaustion."""
    if error_code == 401:
        return EXHAUSTED_TTL_401_SECONDS
    if error_code == 429:
        return EXHAUSTED_TTL_429_SECONDS
    return EXHAUSTED_TTL_DEFAULT_SECONDS


def _parse_absolute_timestamp(value: Any) -> Optional[float]:
    """Best-effort parse for provider reset timestamps.

    Accepts epoch seconds, epoch milliseconds, and ISO-8601 strings.
    Returns seconds since epoch.
    """
    if value is None or value == "":
        return None
    if isinstance(value, (int, float)):
        numeric = float(value)
        if numeric <= 0:
            return None
        return numeric / 1000.0 if numeric > 1_000_000_000_000 else numeric
    if isinstance(value, str):
        raw = value.strip()
        if not raw:
            return None
        try:
            numeric = float(raw)
        except ValueError:
            numeric = None
        if numeric is not None:
            return numeric / 1000.0 if numeric > 1_000_000_000_000 else numeric
        try:
            return datetime.fromisoformat(raw.replace("Z", "+00:00")).timestamp()
        except ValueError:
            return None
    return None


def _extract_retry_delay_seconds(message: str) -> Optional[float]:
    if not message:
        return None
    delay_match = re.search(r"quotaResetDelay[:\s\"]+(\d+(?:\.\d+)?)(ms|s)", message, re.IGNORECASE)
    if delay_match:
        value = float(delay_match.group(1))
        return value / 1000.0 if delay_match.group(2).lower() == "ms" else value
    sec_match = re.search(r"retry\s+(?:after\s+)?(\d+(?:\.\d+)?)\s*(?:sec|secs|seconds|s\b)", message, re.IGNORECASE)
    if sec_match:
        return float(sec_match.group(1))
    # "Resets in 4hr 5min" format used by OpenCode Go weekly usage limits
    hr_min_match = re.search(r"resets?\s+in\s+(\d+)\s*hr\s+(\d+)\s*min", message, re.IGNORECASE)
    if hr_min_match:
        return int(hr_min_match.group(1)) * 3600 + int(hr_min_match.group(2)) * 60
    hr_only_match = re.search(r"resets?\s+in\s+(\d+)\s*hr\b", message, re.IGNORECASE)
    if hr_only_match:
        return int(hr_only_match.group(1)) * 3600
    min_only_match = re.search(r"resets?\s+in\s+(\d+)\s*min\b", message, re.IGNORECASE)
    if min_only_match:
        return int(min_only_match.group(1)) * 60
    return None


def _normalize_error_context(error_context: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    if not isinstance(error_context, dict):
        return {}
    normalized: Dict[str, Any] = {}
    reason = error_context.get("reason")
    if isinstance(reason, str) and reason.strip():
        normalized["reason"] = reason.strip()
    message = error_context.get("message")
    if isinstance(message, str) and message.strip():
        normalized["message"] = message.strip()
    reset_at = (
        error_context.get("reset_at")
        or error_context.get("resets_at")
        or error_context.get("retry_until")
    )
    parsed_reset_at = _parse_absolute_timestamp(reset_at)
    if parsed_reset_at is None and isinstance(message, str):
        retry_delay_seconds = _extract_retry_delay_seconds(message)
        if retry_delay_seconds is not None:
            parsed_reset_at = time.time() + retry_delay_seconds
    if parsed_reset_at is not None:
        normalized["reset_at"] = parsed_reset_at
    return normalized


def _exhausted_until(entry: PooledCredential) -> Optional[float]:
    if entry.last_status != STATUS_EXHAUSTED:
        return None
    reset_at = _parse_absolute_timestamp(getattr(entry, "last_error_reset_at", None))
    if reset_at is not None:
        return reset_at
    if entry.last_status_at:
        return entry.last_status_at + _exhausted_ttl(entry.last_error_code)
    return None


def _normalize_custom_pool_name(name: str) -> str:
    """Normalize a custom provider name for use as a pool key suffix."""
    return name.strip().lower().replace(" ", "-")


def _iter_custom_providers(config: Optional[dict] = None):
    """Yield (normalized_name, entry_dict) for each valid custom_providers entry."""
    if config is None:
        config = _load_config_safe()
    if config is None:
        return
    custom_providers = config.get("custom_providers")
    if not isinstance(custom_providers, list):
        # Fall back to the v12+ providers dict via the compatibility layer
        try:
            from fan_cli.config import get_compatible_custom_providers

            custom_providers = get_compatible_custom_providers(config)
        except Exception:
            return
    if not custom_providers:
        return
    for entry in custom_providers:
        if not isinstance(entry, dict):
            continue
        name = entry.get("name")
        if not isinstance(name, str):
            continue
        yield _normalize_custom_pool_name(name), entry


def get_custom_provider_pool_key(base_url: str, provider_name: Optional[str] = None) -> Optional[str]:
    """Look up the custom_providers list in config.yaml and return 'custom:<name>' for a matching base_url.

    When provider_name is given, prefer matching by name first (solving the case where
    multiple custom providers share the same base_url but have different API keys).
    Falls back to base_url matching when no name match is found.

    Returns None if no match is found.
    """
    if not base_url:
        return None
    normalized_url = base_url.strip().rstrip("/")

    # When a provider name is given, try to match by name first.
    # This fixes the P1 bug where two custom providers sharing the same
    # base_url always resolve to the first one's credentials.
    if provider_name:
        normalized_name = _normalize_custom_pool_name(provider_name)
        for norm_name, entry in _iter_custom_providers():
            if norm_name == normalized_name:
                return f"{CUSTOM_POOL_PREFIX}{norm_name}"

    # Fall back to base_url matching (original behavior)
    for norm_name, entry in _iter_custom_providers():
        entry_url = str(entry.get("base_url") or "").strip().rstrip("/")
        if entry_url and entry_url == normalized_url:
            return f"{CUSTOM_POOL_PREFIX}{norm_name}"
    return None



def _get_custom_provider_config(pool_key: str) -> Optional[Dict[str, Any]]:
    """Return the custom_providers config entry matching a pool key like 'custom:together.ai'."""
    if not pool_key.startswith(CUSTOM_POOL_PREFIX):
        return None
    suffix = pool_key[len(CUSTOM_POOL_PREFIX):]
    for norm_name, entry in _iter_custom_providers():
        if norm_name == suffix:
            return entry
    return None


def get_pool_strategy(provider: str) -> str:
    """Return the configured selection strategy for a provider."""
    config = _load_config_safe()
    if config is None:
        return STRATEGY_FILL_FIRST

    strategies = config.get("credential_pool_strategies")
    if not isinstance(strategies, dict):
        return STRATEGY_FILL_FIRST

    strategy = str(strategies.get(provider, "") or "").strip().lower()
    if strategy in SUPPORTED_POOL_STRATEGIES:
        return strategy
    return STRATEGY_FILL_FIRST


def credential_pool_matches_provider(
    pool_or_provider: Any,
    provider: Optional[str],
    *,
    base_url: Optional[str] = None,
) -> bool:
    """Return whether a pool belongs to the requested runtime provider.

    Named custom endpoints run as ``custom`` but retain a pool key of
    ``custom:<name>``.  Accept that pairing only when the runtime endpoint
    maps back to the exact custom pool key; otherwise fail closed.  Lightweight
    legacy adapters without a provider identity remain compatible.
    """
    raw_pool_provider = getattr(pool_or_provider, "provider", None)
    if raw_pool_provider is None:
        if isinstance(pool_or_provider, str):
            raw_pool_provider = pool_or_provider
        else:
            return True

    pool_provider = str(raw_pool_provider or "").strip().lower()
    provider_norm = str(provider or "").strip().lower()
    if not pool_provider or not provider_norm:
        return False
    if pool_provider == provider_norm:
        return True
    if provider_norm != "custom" or not pool_provider.startswith(CUSTOM_POOL_PREFIX):
        return False
    try:
        matched_pool = get_custom_provider_pool_key(base_url or "")
    except Exception:
        return False
    return str(matched_pool or "").strip().lower() == pool_provider


DEFAULT_MAX_CONCURRENT_PER_CREDENTIAL = 1


class CredentialPool:
    def __init__(self, provider: str, entries: List[PooledCredential]):
        self.provider = provider
        self._entries = sorted(entries, key=lambda entry: entry.priority)
        self._current_id: Optional[str] = None
        self._strategy = get_pool_strategy(provider)
        self._lock = threading.Lock()
        self._active_leases: Dict[str, int] = {}
        self._max_concurrent = DEFAULT_MAX_CONCURRENT_PER_CREDENTIAL

    def has_credentials(self) -> bool:
        return bool(self._entries)

    def has_available(self) -> bool:
        """True if at least one entry is not currently in exhaustion cooldown."""
        return bool(self._available_entries())

    def entries(self) -> List[PooledCredential]:
        return list(self._entries)

    def current(self) -> Optional[PooledCredential]:
        if not self._current_id:
            return None
        return next((entry for entry in self._entries if entry.id == self._current_id), None)

    def _replace_entry(self, old: PooledCredential, new: PooledCredential) -> None:
        """Swap an entry in-place by id, preserving sort order."""
        for idx, entry in enumerate(self._entries):
            if entry.id == old.id:
                self._entries[idx] = new
                return

    def _persist(self, *, removed_ids: Optional[List[str]] = None) -> None:
        write_credential_pool(
            self.provider,
            [entry.to_dict() for entry in self._entries],
            removed_ids=removed_ids,
        )

    def _is_terminal_auth_failure(
        self,
        status_code: Optional[int],
        normalized_error: Dict[str, Any],
    ) -> bool:
        """Detect upstream-permanent OAuth failures that won't recover on TTL.

        Only fires for 401 responses whose error code/reason matches a known
        terminal OAuth state (token_invalidated, token_revoked, invalid_grant,
        etc.).  Distinguishes permanent failures from transient ones like
        token_expired (refreshable) or generic 401 without a specific reason
        (could be a server-side glitch worth retrying).

        Returns False for non-401 status codes — 429 rate limits and 402
        billing failures are transient by nature and should keep TTL semantics.
        """
        if status_code != 401:
            return False
        reason = normalized_error.get("reason")
        if not isinstance(reason, str):
            return False
        return reason.strip().lower() in _TERMINAL_AUTH_REASONS

    def _mark_exhausted(
        self,
        entry: PooledCredential,
        status_code: Optional[int],
        error_context: Optional[Dict[str, Any]] = None,
    ) -> PooledCredential:
        normalized_error = _normalize_error_context(error_context)
        # Permanent OAuth failures (token_invalidated, token_revoked, etc.)
        # transition to STATUS_DEAD instead of STATUS_EXHAUSTED.  Without this,
        # a revoked credential gets a 1-hour TTL cooldown and then re-enters
        # rotation, failing immediately every hour until the user manually
        # removes it (issue #32849).  DEAD entries are excluded from rotation
        # unconditionally and only clear via an explicit re-auth write-side
        # sync (``_save_codex_tokens`` after a fresh device-code login).
        if self._is_terminal_auth_failure(status_code, normalized_error):
            terminal_status = STATUS_DEAD
        else:
            terminal_status = STATUS_EXHAUSTED
        updated = replace(
            entry,
            last_status=terminal_status,
            last_status_at=time.time(),
            last_error_code=status_code,
            last_error_reason=normalized_error.get("reason"),
            last_error_message=normalized_error.get("message"),
            last_error_reset_at=normalized_error.get("reset_at"),
        )
        self._replace_entry(entry, updated)
        self._persist()
        return updated

    def _refresh_entry(self, entry: PooledCredential, *, force: bool) -> Optional[PooledCredential]:
        # OAuth providers may register refresh adapters independently.
        if entry.auth_type == AUTH_TYPE_OAUTH and entry.refresh_token:
            return self._refresh_oauth_entry(entry)
        # API-key entries do not need proactive refresh; failed keys are rotated
        # by exhaustion.
        if force:
            self._mark_exhausted(entry, None)
        return None

    def _refresh_oauth_entry(self, entry: PooledCredential) -> Optional[PooledCredential]:
        from agent.oauth_refresh import OAuthRefreshError, get_oauth_refresher

        refresher = get_oauth_refresher(self.provider)
        if refresher is None:
            logger.warning(
                "credential pool: no OAuth refresh adapter registered for %s",
                self.provider,
            )
            return None
        try:
            from fan_cli.auth import credential_store_lock, read_credential_pool

            # Refresh grants may be single-use. Hold the auth-store lock across
            # read -> network exchange -> write so independent desktop/CLI
            # processes cannot consume the same refresh token concurrently.
            with credential_store_lock():
                raw_entries = read_credential_pool(self.provider)
                latest_raw = next(
                    (
                        payload
                        for payload in raw_entries
                        if isinstance(payload, dict) and payload.get("id") == entry.id
                    ),
                    None,
                )
                if isinstance(latest_raw, dict):
                    latest = PooledCredential.from_dict(self.provider, latest_raw)
                    if (
                        latest.access_token != entry.access_token
                        or latest.refresh_token != entry.refresh_token
                    ):
                        self._replace_entry(entry, latest)
                        entry = latest
                        if latest.access_token and not self._entry_needs_refresh(latest):
                            return latest

                try:
                    payload = refresher(entry)
                except OAuthRefreshError as exc:
                    if exc.terminal:
                        logger.warning(
                            "credential pool: oauth refresh rejected (terminal) for %s: %s",
                            entry.id,
                            exc,
                        )
                        self._mark_exhausted(
                            entry,
                            401,
                            {"reason": exc.reason or "invalid_grant", "message": str(exc)},
                        )
                    else:
                        logger.info(
                            "credential pool: oauth refresh deferred (transient) for %s: %s",
                            entry.id,
                            exc,
                        )
                    return None
                updated = replace(
                    entry,
                    access_token=payload["access_token"],
                    refresh_token=payload.get("refresh_token") or entry.refresh_token,
                    expires_at=payload.get("expires_at"),
                    expires_at_ms=payload.get("expires_at_ms"),
                    last_refresh=payload.get("last_refresh"),
                    base_url=payload.get("base_url") or entry.base_url,
                    last_status=STATUS_OK,
                    last_status_at=time.time(),
                    last_error_code=None,
                    last_error_reason=None,
                    last_error_message=None,
                    last_error_reset_at=None,
                    extra={
                        **entry.extra,
                        **{
                            key: value
                            for key, value in payload.items()
                            if key in _EXTRA_KEYS and value is not None
                        },
                    },
                )
                self._replace_entry(entry, updated)
                self._persist()
                logger.info("credential pool: oauth token refreshed for %s", entry.id)
                return updated
        except Exception as exc:  # noqa: BLE001 — unexpected, treat as transient
            logger.info("credential pool: oauth refresh error (treated transient) for %s: %s", entry.id, exc)
            return None

    def _entry_needs_refresh(self, entry: PooledCredential) -> bool:
        # Proactively refresh OAuth tokens within a safety margin of expiry.
        if entry.auth_type != AUTH_TYPE_OAUTH or not entry.refresh_token:
            return False
        if not entry.expires_at:
            return False
        expires = _parse_absolute_timestamp(entry.expires_at)
        if expires is None:
            return False
        return (expires - time.time()) < _OAUTH_REFRESH_MARGIN_SECONDS

    def select(self) -> Optional[PooledCredential]:
        with self._lock:
            return self._select_unlocked()

    def select_by_source(self, source: str) -> Optional[PooledCredential]:
        """Select an available credential from one exact trusted source.

        Some protocol surfaces must not rotate into a generic manually-added
        API key merely because it shares the same provider id. Keep normal
        refresh/exhaustion handling while applying the source boundary before
        choosing by stable priority.
        """
        expected = str(source or "")
        with self._lock:
            available = self._available_entries(clear_expired=True, refresh=True)
            candidates = [entry for entry in available if entry.source == expected]
            if not candidates:
                return None
            entry = min(candidates, key=lambda candidate: candidate.priority)
            self._current_id = entry.id
            return entry

    def _available_entries(self, *, clear_expired: bool = False, refresh: bool = False) -> List[PooledCredential]:
        """Return entries not currently in exhaustion cooldown.

        When *clear_expired* is True, entries whose cooldown has elapsed are
        reset to STATUS_OK and persisted.  When *refresh* is True, entries
        that need a token refresh are refreshed (skipped on failure).
        """
        now = time.time()
        cleared_any = False
        entries_to_prune: List[str] = []
        available: List[PooledCredential] = []
        for entry in self._entries:
            if entry.last_status == STATUS_DEAD:
                # Manual DEAD credentials get pruned after a 24h quiet window
                # so the pool doesn't accumulate dead entries forever.  The
                # user can always re-add it through provider configuration. Singleton-
                # seeded DEAD entries are kept so the audit trail (label,
                # last_error_reason, timestamps) stays visible — pruning them
                # would just be undone by ``_seed_from_singletons`` on the
                # next load anyway.
                if _is_manual_source(entry.source):
                    dead_at = entry.last_status_at or 0
                    if dead_at and now - dead_at > DEAD_MANUAL_PRUNE_TTL_SECONDS:
                        _label = entry.label or entry.id[:8]
                        logger.warning(
                            "credential pool: pruning DEAD manual entry %s "
                            "(reason=%s, age=%.1fh) — reconfigure provider %s",
                            _label,
                            entry.last_error_reason or "unknown",
                            (now - dead_at) / 3600.0,
                            self.provider,
                        )
                        # Mark for removal after the loop completes; we can't
                        # mutate self._entries while iterating.
                        entries_to_prune.append(entry.id)
                        cleared_any = True
                # Permanently failed credentials never re-enter rotation via TTL.
                continue
            if entry.last_status == STATUS_EXHAUSTED:
                exhausted_until = _exhausted_until(entry)
                if exhausted_until is not None and now < exhausted_until:
                    continue
                if clear_expired:
                    cleared = replace(
                        entry,
                        last_status=STATUS_OK,
                        last_status_at=None,
                        last_error_code=None,
                        last_error_reason=None,
                        last_error_message=None,
                        last_error_reset_at=None,
                    )
                    self._replace_entry(entry, cleared)
                    entry = cleared
                    cleared_any = True
            if refresh and self._entry_needs_refresh(entry):
                refreshed = self._refresh_entry(entry, force=False)
                if refreshed is not None:
                    entry = refreshed
                else:
                    # Refresh returned nothing. A *terminal* failure marked the
                    # entry DEAD/exhausted in place — re-read and skip it. A
                    # *transient* failure left status untouched — keep using the
                    # current (possibly still-valid) token rather than locking out.
                    current = next((e for e in self._entries if e.id == entry.id), entry)
                    if current.last_status in (STATUS_DEAD, STATUS_EXHAUSTED):
                        continue
                    entry = current
            available.append(entry)
        if entries_to_prune:
            pruned_ids = set(entries_to_prune)
            self._entries = [e for e in self._entries if e.id not in pruned_ids]
        if cleared_any:
            self._persist(removed_ids=entries_to_prune)
        return available

    def _select_unlocked(self) -> Optional[PooledCredential]:
        available = self._available_entries(clear_expired=True, refresh=True)
        if not available:
            self._current_id = None
            logger.info("credential pool: no available entries (all exhausted or empty)")
            return None

        if self._strategy == STRATEGY_RANDOM:
            entry = random.choice(available)
            self._current_id = entry.id
            return entry

        if self._strategy == STRATEGY_LEAST_USED and len(available) > 1:
            entry = min(available, key=lambda e: e.request_count)
            # Increment usage counter so subsequent selections distribute load
            updated = replace(entry, request_count=entry.request_count + 1)
            self._replace_entry(entry, updated)
            self._current_id = entry.id
            return updated

        if self._strategy == STRATEGY_ROUND_ROBIN and len(available) > 1:
            entry = available[0]
            rotated = [candidate for candidate in self._entries if candidate.id != entry.id]
            rotated.append(replace(entry, priority=len(self._entries) - 1))
            self._entries = [replace(candidate, priority=idx) for idx, candidate in enumerate(rotated)]
            self._persist()
            self._current_id = entry.id
            return self.current() or entry

        entry = available[0]
        self._current_id = entry.id
        return entry

    def peek(self) -> Optional[PooledCredential]:
        current = self.current()
        if current is not None:
            return current
        available = self._available_entries()
        return available[0] if available else None

    def mark_exhausted_and_rotate(
        self,
        *,
        status_code: Optional[int],
        error_context: Optional[Dict[str, Any]] = None,
        api_key_hint: Optional[str] = None,
    ) -> Optional[PooledCredential]:
        with self._lock:
            entry = None
            if api_key_hint:
                # Prefer the specific entry whose API key matches the one that
                # actually failed.  When this pool was freshly loaded from disk
                # (another process already rotated), current() is None and
                # _select_unlocked() would return the NEXT key — the wrong one.
                entry = next(
                    (e for e in self._entries if e.runtime_api_key == api_key_hint),
                    None,
                )
            if entry is None:
                entry = self.current() or self._select_unlocked()
            if entry is None:
                return None
            _label = entry.label or entry.id[:8]
            self._mark_exhausted(entry, status_code, error_context)
            # Re-read the updated entry to log the correct terminal state.
            updated_entry = next(
                (e for e in self._entries if e.id == entry.id), entry,
            )
            if updated_entry.last_status == STATUS_DEAD:
                logger.warning(
                    "credential pool: marking %s DEAD (status=%s, reason=%s) — "
                    "permanently failed, will NOT re-enter rotation until re-auth",
                    _label, status_code, updated_entry.last_error_reason or "unknown",
                )
            else:
                logger.info(
                    "credential pool: marking %s exhausted (status=%s), rotating",
                    _label, status_code,
                )
            self._current_id = None
            next_entry = self._select_unlocked()
            if next_entry:
                _next_label = next_entry.label or next_entry.id[:8]
                logger.info("credential pool: rotated to %s", _next_label)
            return next_entry

    def acquire_lease(self, credential_id: Optional[str] = None) -> Optional[str]:
        """Acquire a soft lease on a credential.

        If a specific credential_id is provided, lease that entry directly.
        Otherwise prefer the least-leased available credential, using priority as
        a stable tie-breaker. When every credential is already at the soft cap,
        still return the least-leased one instead of blocking.
        """
        with self._lock:
            if credential_id:
                self._active_leases[credential_id] = self._active_leases.get(credential_id, 0) + 1
                self._current_id = credential_id
                return credential_id

            available = self._available_entries(clear_expired=True, refresh=True)
            if not available:
                return None

            below_cap = [
                entry for entry in available
                if self._active_leases.get(entry.id, 0) < self._max_concurrent
            ]
            candidates = below_cap if below_cap else available
            chosen = min(
                candidates,
                key=lambda entry: (self._active_leases.get(entry.id, 0), entry.priority),
            )
            self._active_leases[chosen.id] = self._active_leases.get(chosen.id, 0) + 1
            self._current_id = chosen.id
            return chosen.id

    def release_lease(self, credential_id: str) -> None:
        """Release a previously acquired credential lease."""
        with self._lock:
            count = self._active_leases.get(credential_id, 0)
            if count <= 1:
                self._active_leases.pop(credential_id, None)
            else:
                self._active_leases[credential_id] = count - 1

    def try_refresh_current(self) -> Optional[PooledCredential]:
        with self._lock:
            return self._try_refresh_current_unlocked()

    def _try_refresh_current_unlocked(self) -> Optional[PooledCredential]:
        entry = self.current()
        if entry is None:
            return None
        refreshed = self._refresh_entry(entry, force=True)
        if refreshed is not None:
            self._current_id = refreshed.id
        return refreshed

    def reset_statuses(self) -> int:
        count = 0
        new_entries = []
        for entry in self._entries:
            if entry.last_status or entry.last_status_at or entry.last_error_code:
                new_entries.append(
                    replace(
                        entry,
                        last_status=None,
                        last_status_at=None,
                        last_error_code=None,
                        last_error_reason=None,
                        last_error_message=None,
                        last_error_reset_at=None,
                    )
                )
                count += 1
            else:
                new_entries.append(entry)
        if count:
            self._entries = new_entries
            self._persist()
        return count

    def remove_index(self, index: int) -> Optional[PooledCredential]:
        if index < 1 or index > len(self._entries):
            return None
        removed = self._entries.pop(index - 1)
        self._entries = [
            replace(entry, priority=new_priority)
            for new_priority, entry in enumerate(self._entries)
        ]
        self._persist(removed_ids=[removed.id])
        if self._current_id == removed.id:
            self._current_id = None
        return removed

    def resolve_target(self, target: Any) -> Tuple[Optional[int], Optional[PooledCredential], Optional[str]]:
        raw = str(target or "").strip()
        if not raw:
            return None, None, "No credential target provided."

        for idx, entry in enumerate(self._entries, start=1):
            if entry.id == raw:
                return idx, entry, None

        label_matches = [
            (idx, entry)
            for idx, entry in enumerate(self._entries, start=1)
            if entry.label.strip().lower() == raw.lower()
        ]
        if len(label_matches) == 1:
            return label_matches[0][0], label_matches[0][1], None
        if len(label_matches) > 1:
            return None, None, f'Ambiguous credential label "{raw}". Use the numeric index or entry id instead.'
        if raw.isdigit():
            index = int(raw)
            if 1 <= index <= len(self._entries):
                return index, self._entries[index - 1], None
            return None, None, f"No credential #{index}."
        return None, None, f'No credential matching "{raw}".'

    def add_entry(self, entry: PooledCredential) -> PooledCredential:
        entry = replace(entry, priority=_next_priority(self._entries))
        self._entries.append(entry)
        self._persist()
        return entry


def _upsert_entry(entries: List[PooledCredential], provider: str, source: str, payload: Dict[str, Any]) -> bool:
    existing_idx = None
    for idx, entry in enumerate(entries):
        if entry.source == source:
            existing_idx = idx
            break

    if existing_idx is None:
        payload.setdefault("id", uuid.uuid4().hex[:6])
        payload.setdefault("priority", _next_priority(entries))
        payload.setdefault("label", payload.get("label") or source)
        entries.append(PooledCredential.from_dict(provider, payload))
        return True

    existing = entries[existing_idx]
    field_updates = {}
    extra_updates = {}
    _field_names = {f.name for f in fields(existing)}
    for key, value in payload.items():
        if key in {"id", "priority"} or value is None:
            continue
        if key == "label" and existing.label:
            continue
        if key in _field_names:
            if getattr(existing, key) != value:
                field_updates[key] = value
        elif key in _EXTRA_KEYS:
            if existing.extra.get(key) != value:
                extra_updates[key] = value
    if field_updates or extra_updates:
        if extra_updates:
            field_updates["extra"] = {**existing.extra, **extra_updates}
        updated = replace(existing, **field_updates)
        entries[existing_idx] = updated
        # Runtime-only borrowed secret updates should refresh the in-memory
        # entry without forcing auth.json churn when the disk-safe payload is
        # unchanged (for example env keys with the same fingerprint).
        return existing.to_dict() != updated.to_dict()
    return False


def _seed_from_singletons(provider: str, entries: List[PooledCredential]) -> Tuple[bool, Set[str]]:
    """No-op: OAuth singleton-backed inference providers were removed."""
    return False, set()

def _seed_from_env(provider: str, entries: List[PooledCredential]) -> Tuple[bool, Set[str]]:
    changed = False
    active_sources: Set[str] = set()

    # Prefer ~/.fan/.env over os.environ — the user's config file is the
    # authoritative source for Fan credentials. Stale env vars from parent
    # processes (Codex CLI, test scripts, etc.) should not override deliberate
    # changes to the .env file.
    def _get_env_prefer_dotenv(key: str) -> str:
        env_file = load_env()
        val = env_file.get(key) or os.environ.get(key) or ""
        return val.strip()

    # Honour user suppression for a removed provider credential source.
    # env-seeded credential marks the env:<VAR> source as suppressed so it
    # won't be re-seeded from the user's shell environment or ~/.fan/.env.
    # Without this gate the removal is silently undone on the next
    # load_pool() call whenever the var is still exported by the shell.
    try:
        from fan_cli.auth import is_source_suppressed as _is_source_suppressed
    except ImportError:
        def _is_source_suppressed(_p, _s):  # type: ignore[misc]
            return False

    def _secret_source_for_env(env_var: str) -> Optional[str]:
        try:
            from fan_cli.env_loader import get_secret_source
            source_label = get_secret_source(env_var)
        except Exception:
            source_label = None
        return str(source_label).strip() if source_label else None

    def _env_payload(
        *,
        source: str,
        env_var: str,
        token: str,
        base_url: str,
        auth_type: str = AUTH_TYPE_API_KEY,
    ) -> Dict[str, Any]:
        payload: Dict[str, Any] = {
            "source": source,
            "auth_type": auth_type,
            "access_token": token,
            "base_url": base_url,
            "label": env_var,
        }
        secret_source = _secret_source_for_env(env_var)
        if secret_source:
            payload["secret_source"] = secret_source
        return payload

    pconfig = PROVIDER_REGISTRY.get(provider)
    if not pconfig or pconfig.auth_type != AUTH_TYPE_API_KEY:
        return changed, active_sources

    env_url = ""
    if pconfig.base_url_env_var:
        env_url = _get_env_prefer_dotenv(pconfig.base_url_env_var).rstrip("/")

    env_vars = list(pconfig.api_key_env_vars)

    for env_var in env_vars:
        # Prefer ~/.fan/.env over os.environ
        token = _get_env_prefer_dotenv(env_var)
        if not token:
            continue
        source = f"env:{env_var}"
        if _is_source_suppressed(provider, source):
            continue
        active_sources.add(source)
        auth_type = AUTH_TYPE_API_KEY
        base_url = env_url or pconfig.inference_base_url
        changed |= _upsert_entry(
            entries,
            provider,
            source,
            _env_payload(
                source=source,
                env_var=env_var,
                token=token,
                base_url=base_url,
                auth_type=auth_type,
            ),
        )
    return changed, active_sources


def _prune_stale_seeded_entries(
    entries: List[PooledCredential],
    active_sources: Set[str],
    *,
    prune_env_sources: bool = True,
) -> bool:
    def _is_prunable(entry: PooledCredential) -> bool:
        # env:* rows are durable references rehydrated per process. A process
        # that did not inherit one variable must not delete another process's
        # reference during an otherwise read-like load_pool() call.
        if str(entry.source or "").startswith("env:"):
            return prune_env_sources
        return (
            is_borrowed_credential_source(entry.source, entry.provider)
        )

    retained = [
        entry
        for entry in entries
        if _is_manual_source(entry.source)
        or entry.source in active_sources
        or not _is_prunable(entry)
    ]
    if len(retained) == len(entries):
        return False
    entries[:] = retained
    return True


def _seed_custom_pool(pool_key: str, entries: List[PooledCredential]) -> Tuple[bool, Set[str]]:
    """Seed a custom endpoint pool from custom_providers config and model config."""
    changed = False
    active_sources: Set[str] = set()

    # Shared suppression gate — same pattern as _seed_from_env/_seed_from_singletons.
    try:
        from fan_cli.auth import is_source_suppressed as _is_suppressed
    except ImportError:
        def _is_suppressed(_p, _s):  # type: ignore[misc]
            return False

    # Seed from the custom_providers config entry's api_key field
    cp_config = _get_custom_provider_config(pool_key)
    if cp_config:
        api_key = str(cp_config.get("api_key") or "").strip()
        base_url = str(cp_config.get("base_url") or "").strip().rstrip("/")
        name = str(cp_config.get("name") or "").strip()
        if api_key:
            source = f"config:{name}"
            if not _is_suppressed(pool_key, source):
                active_sources.add(source)
                changed |= _upsert_entry(
                    entries,
                    pool_key,
                    source,
                    {
                        "source": source,
                        "auth_type": AUTH_TYPE_API_KEY,
                        "access_token": api_key,
                        "base_url": base_url,
                        "label": name or source,
                    },
                )

    # Seed from model.api_key if model.provider=='custom' and model.base_url matches
    try:
        config = _load_config_safe()
        model_cfg = config.get("model") if config else None
        if isinstance(model_cfg, dict):
            model_provider = str(model_cfg.get("provider") or "").strip().lower()
            model_base_url = str(model_cfg.get("base_url") or "").strip().rstrip("/")
            model_api_key = ""
            for k in ("api_key", "api"):
                v = model_cfg.get(k)
                if isinstance(v, str) and v.strip():
                    model_api_key = v.strip()
                    break
            if model_provider == "custom" and model_base_url and model_api_key:
                # Check if this model's base_url matches our custom provider
                matched_key = get_custom_provider_pool_key(model_base_url)
                if matched_key == pool_key:
                    source = "model_config"
                    if not _is_suppressed(pool_key, source):
                        active_sources.add(source)
                        changed |= _upsert_entry(
                            entries,
                            pool_key,
                            source,
                            {
                                "source": source,
                                "auth_type": AUTH_TYPE_API_KEY,
                                "access_token": model_api_key,
                                "base_url": model_base_url,
                                "label": "model_config",
                            },
                        )
    except Exception:
        pass

    return changed, active_sources


def load_pool(provider: str) -> CredentialPool:
    provider = (provider or "").strip().lower()
    raw_entries = read_credential_pool(provider)
    disk_ids = {
        payload.get("id")
        for payload in raw_entries
        if isinstance(payload, dict) and payload.get("id")
    }
    raw_needs_sanitization = any(
        isinstance(payload, dict)
        and sanitize_borrowed_credential_payload(payload, provider) != payload
        for payload in raw_entries
    )
    entries = [PooledCredential.from_dict(provider, payload) for payload in raw_entries]

    if provider.startswith(CUSTOM_POOL_PREFIX):
        # Custom endpoint pool — seed from custom_providers config and model config
        custom_changed, custom_sources = _seed_custom_pool(provider, entries)
        changed = raw_needs_sanitization or custom_changed
        changed |= _prune_stale_seeded_entries(entries, custom_sources)
    else:
        singleton_changed, singleton_sources = _seed_from_singletons(provider, entries)
        env_changed, env_sources = _seed_from_env(provider, entries)
        changed = raw_needs_sanitization or singleton_changed or env_changed
        changed |= _prune_stale_seeded_entries(
            entries,
            singleton_sources | env_sources,
            prune_env_sources=False,
        )

    if changed:
        new_ids = {entry.id for entry in entries}
        write_credential_pool(
            provider,
            [entry.to_dict() for entry in sorted(entries, key=lambda item: item.priority)],
            removed_ids=disk_ids - new_ids,
        )
    return CredentialPool(provider, entries)
