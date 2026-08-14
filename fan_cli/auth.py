"""Model-provider credential persistence and runtime resolution."""

from __future__ import annotations

import json
import logging
import os
import stat
import hashlib
import threading
import time
import uuid
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, List, Optional, overload

from fan_cli.config import (
    atomic_config_write,
    clear_model_endpoint_credentials,
    get_fan_home,
    get_config_path,
    read_raw_config,
    require_readable_config_before_write,
)
from fan_cli.providers import (
    DEEPSEEK_API_BASE,
    DEEPSEEK_API_KEY_ENV,
    DEEPSEEK_PROVIDER_ID,
    normalize_provider,
)
from fan_constants import secure_parent_dir
from agent.credential_persistence import sanitize_borrowed_credential_payload
from utils import atomic_replace

logger = logging.getLogger(__name__)

try:
    import fcntl
except Exception:
    fcntl = None
try:
    import msvcrt
except Exception:
    msvcrt = None

# =============================================================================
# Constants
# =============================================================================

AUTH_STORE_VERSION = 1
AUTH_LOCK_TIMEOUT_SECONDS = 15.0

# Legacy no-auth placeholder kept for setup/main import compatibility.
LMSTUDIO_NOAUTH_PLACEHOLDER = "dummy-lm-api-key"

# =============================================================================
# Provider Registry
# =============================================================================

@dataclass
class ProviderConfig:
    """Describes a known inference provider."""
    id: str
    name: str
    auth_type: str  # currently only "api_key" is supported
    portal_base_url: str = ""
    inference_base_url: str = ""
    client_id: str = ""
    scope: str = ""
    extra: Dict[str, Any] = field(default_factory=dict)
    # For API-key providers: env vars to check (in priority order)
    api_key_env_vars: tuple = ()
    # Optional env var for base URL override
    base_url_env_var: str = ""


PROVIDER_REGISTRY: Dict[str, ProviderConfig] = {
    "alibaba": ProviderConfig(
        id="alibaba",
        name="Alibaba Bailian / DashScope",
        auth_type="api_key",
        inference_base_url="https://dashscope.aliyuncs.com/compatible-mode/v1",
        api_key_env_vars=("DASHSCOPE_API_KEY",),
        base_url_env_var="DASHSCOPE_BASE_URL",
    ),
    "alibaba-coding-plan": ProviderConfig(
        id="alibaba-coding-plan",
        name="Alibaba Cloud (Coding Plan)",
        auth_type="api_key",
        inference_base_url="https://coding-intl.dashscope.aliyuncs.com/v1",
        api_key_env_vars=("ALIBABA_CODING_PLAN_API_KEY", "DASHSCOPE_API_KEY"),
        base_url_env_var="ALIBABA_CODING_PLAN_BASE_URL",
    ),
    "ollama-cloud": ProviderConfig(
        id="ollama-cloud",
        name="Ollama Cloud",
        auth_type="api_key",
        inference_base_url="https://ollama.com/v1",
        api_key_env_vars=("OLLAMA_API_KEY",),
    ),
    DEEPSEEK_PROVIDER_ID: ProviderConfig(
        id=DEEPSEEK_PROVIDER_ID,
        name="DeepSeek",
        auth_type="api_key",
        inference_base_url=DEEPSEEK_API_BASE,
        api_key_env_vars=(DEEPSEEK_API_KEY_ENV,),
        base_url_env_var="DEEPSEEK_BASE_URL",
    ),
}

_PLACEHOLDER_SECRET_VALUES = {
    "*",
    "**",
    "***",
    "changeme",
    "your_api_key",
    "your_api_key_here",
    "your-api-key",
    "placeholder",
    "example",
    "dummy",
    "null",
    "none",
}


def has_usable_secret(value: Any, *, min_length: int = 4) -> bool:
    """Return True when a configured secret looks usable, not empty/placeholder."""
    if not isinstance(value, str):
        return False
    cleaned = value.strip()
    if len(cleaned) < min_length:
        return False
    if cleaned.lower() in _PLACEHOLDER_SECRET_VALUES:
        return False
    return True


def _resolve_api_key_provider_secret(
    provider_id: str, pconfig: ProviderConfig
) -> tuple[str, str]:
    """Resolve an API-key provider's token and indicate where it came from."""
    from fan_cli.config import get_env_value_prefer_dotenv
    for env_var in pconfig.api_key_env_vars:
        # Prefer the managed .env so a deliberate key rotation is not
        # shadowed by a stale export inherited from a launcher process.
        val = (get_env_value_prefer_dotenv(env_var) or "").strip()
        if has_usable_secret(val):
            return val, env_var

    # Fallback: try entries persisted in the provider credential pool.
    try:
        from agent.credential_pool import load_pool
        pool = load_pool(provider_id)
        if pool and pool.has_credentials():
            entry = pool.peek()
            if entry:
                key = getattr(entry, "access_token", "") or getattr(entry, "runtime_api_key", "")
                key = str(key).strip()
                if has_usable_secret(key):
                    return key, f"credential_pool:{provider_id}"
    except Exception:
        pass

    return "", ""


# =============================================================================
# Error Types
# =============================================================================

# Error code marking upstream rate-limit / usage-quota exhaustion (HTTP 429).
# Such failures are transient and re-authenticating cannot resolve them, so
# they must be kept distinct from missing/expired-credential errors.
CODEX_RATE_LIMITED_CODE = "codex_rate_limited"


class AuthError(RuntimeError):
    """Structured auth error with UX mapping hints."""

    def __init__(
        self,
        message: str,
        *,
        provider: str = "",
        code: Optional[str] = None,
    ) -> None:
        super().__init__(message)
        self.provider = provider
        # Missing provider and missing provider-key are one actionable setup
        # state. Normalize both so the desktop can open its provider picker
        # before constructing an agent.
        self.code = (
            "provider_not_configured"
            if code in {"no_provider_configured", "missing_api_key"}
            else code
        )


def is_rate_limited_auth_error(error: Exception) -> bool:
    """True when an :class:`AuthError` represents upstream rate-limiting / quota
    exhaustion rather than missing or invalid credentials.

    These failures are transient and cannot be fixed by replacing a credential,
    so callers should surface a "retry later" notice and prefer a fallback chain.
    """
    return (
        isinstance(error, AuthError)
        and error.code == CODEX_RATE_LIMITED_CODE
    )


def format_auth_error(error: Exception) -> str:
    """Map auth failures to concise user-facing guidance."""
    if not isinstance(error, AuthError):
        return str(error)

    # Rate-limit / quota errors are not credential problems — never append the
    # "re-authenticate" remediation, which would mislead the operator.
    if is_rate_limited_auth_error(error):
        return str(error)

    if error.code == "temporarily_unavailable":
        return f"{error} Please retry in a few seconds."

    if error.code == "provider_not_configured":
        return "模型提供商尚未配置。请先选择提供商并填写所需凭据，再启动会话。"

    return str(error)


# =============================================================================
# Auth Store — persistence layer for ~/.fan/auth.json
# =============================================================================

def _auth_file_path() -> Path:
    path = get_fan_home() / "auth.json"
    # Seat belt: if pytest is running and FAN_HOME resolves to the real
    # user's auth store, refuse rather than silently corrupt it. This catches
    # tests that forgot to monkeypatch FAN_HOME, tests invoked without the
    # hermetic conftest, or sandbox escapes via threads/subprocesses. In
    # production (no PYTEST_CURRENT_TEST) this is a single dict lookup.
    if os.environ.get("PYTEST_CURRENT_TEST"):
        real_home_auth = (Path.home() / ".fan" / "auth.json").resolve(strict=False)
        try:
            resolved = path.resolve(strict=False)
        except Exception:
            resolved = path
        if resolved == real_home_auth:
            raise RuntimeError(
                f"Refusing to touch real user auth store during test run: {path}. "
                "Set FAN_HOME to a tmp_path in your test fixture, or run "
                "via scripts/run_tests.sh for hermetic CI-parity env."
            )
    return path


def _global_auth_file_path() -> Optional[Path]:
    """Return the global-root auth.json when the process is in profile mode.

    Returns ``None`` when the profile and global root resolve to the same
    directory (classic mode, or custom FAN_HOME that is not a profile).
    Used by read-only fallback paths so providers authed at the root are
    visible to profile processes that haven't configured them locally.

    See issue #18594 follow-up (credential_pool shadowing).
    """
    try:
        from fan_constants import get_default_fan_root
        global_root = get_default_fan_root()
    except Exception:
        return None
    profile_home = get_fan_home()
    try:
        if profile_home.resolve(strict=False) == global_root.resolve(strict=False):
            return None
    except Exception:
        if profile_home == global_root:
            return None
    # No pytest seat belt here: this is a pure read-only path, and
    # ``_load_global_auth_store()`` wraps the read in a try/except so an
    # unreadable global file can never break the profile process.  The
    # write-side seat belt still lives on ``_auth_file_path()`` where it
    # belongs (that's what protects the real user's auth store from being
    # corrupted by a mis-configured test).
    return global_root / "auth.json"


def _load_global_auth_store() -> Dict[str, Any]:
    """Load the global-root auth store (read-only fallback).

    Returns an empty dict when no global fallback exists (classic mode,
    or the global auth.json is absent). Never raises on missing file.

    Seat belt: under pytest, refuses to read the real user's
    ``~/.fan/auth.json`` even when FAN_HOME is set to a profile
    path. The hermetic conftest does not redirect ``HOME``, so
    ``get_default_fan_root()`` for a profile-shaped FAN_HOME can
    still resolve to the real user's home on a dev machine. That would
    leak real credentials into tests. This guard uses the unmodified
    ``HOME`` env var (what ``os.path.expanduser('~')`` would resolve to),
    not ``Path.home()``, because ``Path.home`` is sometimes monkeypatched
    by fixtures that want to relocate the global root to a tmp path.
    """
    global_path = _global_auth_file_path()
    if global_path is None or not global_path.exists():
        return {}
    if os.environ.get("PYTEST_CURRENT_TEST"):
        real_home_env = os.environ.get("HOME", "")
        if real_home_env:
            real_root = Path(real_home_env) / ".fan" / "auth.json"
            try:
                if global_path.resolve(strict=False) == real_root.resolve(strict=False):
                    return {}
            except Exception:
                pass
    try:
        return _load_auth_store(global_path)
    except Exception:
        # A malformed global store must not break profile reads. The
        # profile's own auth store is still authoritative.
        return {}


def _auth_lock_path() -> Path:
    return _auth_file_path().with_suffix(".lock")


_auth_lock_holder = threading.local()
_auth_process_lock = threading.RLock()


@contextmanager
def _file_lock(
    lock_path: Path,
    holder: threading.local,
    timeout_seconds: float,
    timeout_message: str,
):
    """Cross-process advisory flock helper.

    Reentrant per-thread via ``holder.depth``. Falls back to a depth-only
    guard when neither ``fcntl`` nor ``msvcrt`` is available (rare).
    Callers supply their own ``threading.local`` so independent stores do not
    share reentrancy state; otherwise one lock's reentrant acquisition could
    silently skip another store's kernel-level lock.
    """
    if getattr(holder, "depth", 0) > 0:
        holder.depth += 1
        try:
            yield
        finally:
            holder.depth -= 1
        return

    lock_path.parent.mkdir(parents=True, exist_ok=True)

    if fcntl is None and msvcrt is None:
        holder.depth = 1
        try:
            yield
        finally:
            holder.depth = 0
        return

    # On Windows, msvcrt.locking needs the file to have content and the
    # file pointer at position 0. Ensure the lock file has at least 1 byte.
    if msvcrt and (not lock_path.exists() or lock_path.stat().st_size == 0):
        lock_path.write_text(" ", encoding="utf-8")

    with lock_path.open("r+" if msvcrt else "a+", encoding="utf-8") as lock_file:
        deadline = time.monotonic() + max(1.0, timeout_seconds)
        while True:
            try:
                if fcntl:
                    fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                else:
                    lock_file.seek(0)
                    msvcrt.locking(lock_file.fileno(), msvcrt.LK_NBLCK, 1)
                break
            except (BlockingIOError, OSError, PermissionError):
                if time.monotonic() >= deadline:
                    raise TimeoutError(timeout_message)
                time.sleep(0.05)

        holder.depth = 1
        try:
            yield
        finally:
            holder.depth = 0
            if fcntl:
                try:
                    fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)
                except (OSError, IOError):
                    pass
            elif msvcrt:
                try:
                    lock_file.seek(0)
                    msvcrt.locking(lock_file.fileno(), msvcrt.LK_UNLCK, 1)
                except (OSError, IOError):
                    pass


@contextmanager
def _auth_store_lock(timeout_seconds: float = AUTH_LOCK_TIMEOUT_SECONDS):
    """Cross-process advisory lock for auth.json reads and writes."""
    with _auth_process_lock:
        with _file_lock(
            _auth_lock_path(),
            _auth_lock_holder,
            timeout_seconds,
            "Timed out waiting for auth store lock",
        ):
            yield


@contextmanager
def credential_store_lock(timeout_seconds: float = AUTH_LOCK_TIMEOUT_SECONDS):
    """Public cross-process transaction boundary for credential refreshers."""
    with _auth_store_lock(timeout_seconds):
        yield


def _load_auth_store(auth_file: Optional[Path] = None) -> Dict[str, Any]:
    auth_file = auth_file or _auth_file_path()
    if not auth_file.exists():
        return {"version": AUTH_STORE_VERSION, "providers": {}}

    try:
        raw = json.loads(auth_file.read_text())
    except Exception as exc:
        corrupt_path = auth_file.with_suffix(".json.corrupt")
        try:
            import shutil
            shutil.copy2(auth_file, corrupt_path)
        except Exception:
            pass
        logger.warning(
            "auth: failed to parse %s (%s) — starting with empty store. "
            "Corrupt file preserved at %s",
            auth_file, exc, corrupt_path,
        )
        return {"version": AUTH_STORE_VERSION, "providers": {}}

    if isinstance(raw, dict) and (
        isinstance(raw.get("providers"), dict)
        or isinstance(raw.get("credential_pool"), dict)
    ):
        raw.setdefault("providers", {})
        return raw

    return {"version": AUTH_STORE_VERSION, "providers": {}}


def _save_auth_store(auth_store: Dict[str, Any]) -> Path:
    auth_file = _auth_file_path()
    auth_file.parent.mkdir(parents=True, exist_ok=True)
    # Tighten parent dir to 0o700 so siblings can't traverse to creds.
    # No-op on Windows (POSIX mode bits not enforced); ignore failures.
    # secure_parent_dir refuses to chmod / or top-level dirs (#25821).
    secure_parent_dir(auth_file)
    auth_store["version"] = AUTH_STORE_VERSION
    auth_store["updated_at"] = datetime.now(timezone.utc).isoformat()
    payload = json.dumps(auth_store, indent=2) + "\n"
    tmp_path = auth_file.with_name(f"{auth_file.name}.tmp.{os.getpid()}.{uuid.uuid4().hex}")
    try:
        # Create with 0o600 atomically via os.open(O_EXCL) + fdopen to close
        # the TOCTOU window where default umask (often 0o644) briefly exposed
        # OAuth tokens to other local users between open() and chmod().
        fd = os.open(
            str(tmp_path),
            os.O_WRONLY | os.O_CREAT | os.O_EXCL,
            stat.S_IRUSR | stat.S_IWUSR,
        )
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        atomic_replace(tmp_path, auth_file)
        try:
            dir_fd = os.open(str(auth_file.parent), os.O_RDONLY)
        except OSError:
            dir_fd = None
        if dir_fd is not None:
            try:
                os.fsync(dir_fd)
            finally:
                os.close(dir_fd)
    finally:
        try:
            if tmp_path.exists():
                tmp_path.unlink()
        except OSError:
            pass
    # Restrict file permissions to owner only
    try:
        auth_file.chmod(stat.S_IRUSR | stat.S_IWUSR)
    except OSError:
        pass
    return auth_file



@overload
def read_credential_pool(provider_id: None = None) -> Dict[str, Any]: ...


@overload
def read_credential_pool(provider_id: str) -> List[Dict[str, Any]]: ...


def read_credential_pool(
    provider_id: Optional[str] = None,
) -> Dict[str, Any] | List[Dict[str, Any]]:
    """Return the persisted credential pool, or one provider slice.

    In profile mode, the profile's credential pool is authoritative. If a
    provider has no entries in the profile, entries from the global-root
    ``auth.json`` are used as a read-only fallback so workers spawned in a
    profile can see provider API keys configured at global scope.

    Profile entries always win: the global fallback only applies per-provider
    when the profile has zero entries for that provider. Once the profile has
    its own provider entry, it fully shadows global entries on the next read.

    Writes always go to the profile (``write_credential_pool`` is unchanged).
    See issue #18594 follow-up.
    """
    auth_store = _load_auth_store()
    pool = auth_store.get("credential_pool")
    if not isinstance(pool, dict):
        pool = {}

    global_pool: Dict[str, Any] = {}
    global_store = _load_global_auth_store()
    maybe_global_pool = global_store.get("credential_pool") if global_store else None
    if isinstance(maybe_global_pool, dict):
        global_pool = maybe_global_pool

    def visible_entries(key: object, entries: object) -> List[Dict[str, Any]]:
        if not isinstance(entries, list):
            return []
        return [
            entry
            for entry in entries
            if isinstance(entry, dict)
        ]

    if provider_id is None:
        merged = {
            key: cleaned
            for key, entries in pool.items()
            if (cleaned := visible_entries(key, entries))
        }
        for gp_key, gp_entries in global_pool.items():
            cleaned_global = visible_entries(gp_key, gp_entries)
            if not cleaned_global:
                continue
            # Per-provider shadowing: profile wins whenever it has ANY entries.
            existing = merged.get(gp_key)
            if isinstance(existing, list) and existing:
                continue
            merged[gp_key] = cleaned_global
        return merged

    provider_entries = visible_entries(provider_id, pool.get(provider_id))
    if provider_entries:
        return provider_entries
    # Profile has no entries for this provider — fall back to global.
    return visible_entries(provider_id, global_pool.get(provider_id))


def write_credential_pool(
    provider_id: str,
    entries: List[Dict[str, Any]],
    *,
    removed_ids: Optional[Iterable[str]] = None,
) -> Path:
    """Persist one provider's credential pool under auth.json.

    This is the final disk-boundary guard for borrowed/reference-only
    credentials. Callers may pass raw dictionaries, so sanitize here even when
    ``PooledCredential.to_dict()`` already did the same work upstream.
    """
    removed = {entry_id for entry_id in (removed_ids or ()) if entry_id}
    with _auth_store_lock():
        auth_store = _load_auth_store()
        pool = auth_store.get("credential_pool")
        if not isinstance(pool, dict):
            pool = {}
            auth_store["credential_pool"] = pool
        sanitized_entries = [
            sanitize_borrowed_credential_payload(entry, provider_id)
            if isinstance(entry, dict) else entry
            for entry in entries
        ]
        existing = pool.get(provider_id)
        existing_entries = existing if isinstance(existing, list) else []
        new_ids = {
            entry.get("id")
            for entry in sanitized_entries
            if isinstance(entry, dict) and entry.get("id")
        }
        merged = list(sanitized_entries)
        for disk_entry in existing_entries:
            if not isinstance(disk_entry, dict):
                continue
            disk_id = disk_entry.get("id")
            if not disk_id or disk_id in new_ids or disk_id in removed:
                continue
            merged.append(
                sanitize_borrowed_credential_payload(disk_entry, provider_id)
            )
        pool[provider_id] = merged
        return _save_auth_store(auth_store)



def is_source_suppressed(provider_id: str, source: str) -> bool:
    """Check if a credential source has been suppressed by the user."""
    try:
        auth_store = _load_auth_store()
        suppressed = auth_store.get("suppressed_sources", {})
        return source in suppressed.get(provider_id, [])
    except Exception:
        return False




def get_active_provider() -> Optional[str]:
    """Return the currently active provider ID from auth store."""
    auth_store = _load_auth_store()
    return str(auth_store.get("active_provider") or "").strip().lower() or None



def clear_provider_auth(provider_id: Optional[str] = None) -> bool:
    """Clear generic stored credentials for a provider.

    If provider_id is None, clears the active provider.
    Returns True if something was cleared.
    """
    with _auth_store_lock():
        auth_store = _load_auth_store()
        target = provider_id or auth_store.get("active_provider")
        if not target:
            return False

        providers = auth_store.get("providers", {})
        if not isinstance(providers, dict):
            providers = {}
            auth_store["providers"] = providers

        pool = auth_store.get("credential_pool")
        if not isinstance(pool, dict):
            pool = {}
            auth_store["credential_pool"] = pool

        cleared = False
        if target in providers:
            del providers[target]
            cleared = True
        if target in pool:
            del pool[target]
            cleared = True

        if auth_store.get("active_provider") == target:
            auth_store["active_provider"] = None
            cleared = True

        if not cleared:
            return False
        _save_auth_store(auth_store)
    return True


def deactivate_provider() -> None:
    """
    Clear active_provider in auth.json without deleting credentials.
    Used when an explicit config selection supersedes a previously active
    credential source.
    """
    with _auth_store_lock():
        auth_store = _load_auth_store()
        auth_store["active_provider"] = None
        _save_auth_store(auth_store)


# =============================================================================
# Provider Resolution — picks which provider to use
# =============================================================================


def _get_config_hint_for_unknown_provider(provider_name: str) -> str:
    """Return a helpful hint string when provider resolution fails.

    Checks for common config.yaml mistakes (malformed custom_providers, etc.)
    and returns a human-readable diagnostic, or empty string if nothing found.
    """
    try:
        from fan_cli.config import validate_config_structure
        issues = validate_config_structure()
        if not issues:
            return ""

        lines = ["Config issue detected — run 'fan doctor' for full diagnostics:"]
        for ci in issues:
            prefix = "ERROR" if ci.severity == "error" else "WARNING"
            lines.append(f"  [{prefix}] {ci.message}")
            # Show first line of hint
            first_hint = ci.hint.splitlines()[0] if ci.hint else ""
            if first_hint:
                lines.append(f"    → {first_hint}")
        return "\n".join(lines)
    except Exception:
        return ""


def resolve_provider(
    requested: Optional[str] = None,
    *,
    explicit_api_key: Optional[str] = None,
    explicit_base_url: Optional[str] = None,
) -> str:
    """
    Determine which inference provider to use.

    Priority (when requested="auto" or None):
    1. Explicit CLI api_key/base_url -> "custom"
    2. Explicit config.yaml model.provider
    3. Direct-provider environment credentials
    4. Direct-provider credential-pool entries
    """
    normalized = (requested or "auto").strip().lower()

    normalized = normalize_provider(normalized)

    if normalized in PROVIDER_REGISTRY:
        return normalized
    if normalized == "custom":
        return "custom"
    if normalized != "auto":
        _config_hint = _get_config_hint_for_unknown_provider(normalized)
        msg = (
            f"Unsupported provider '{normalized}'. Configure a supported direct "
            "provider or a custom OpenAI-compatible endpoint."
        )
        if _config_hint:
            msg += f"\n\n{_config_hint}"
        raise AuthError(msg, code="invalid_provider")

    # A model provider explicitly configured by the user is authoritative.
    config_provider = _get_config_provider()
    if config_provider and config_provider != "auto":
        config_provider = normalize_provider(config_provider)
        if config_provider in PROVIDER_REGISTRY:
            return config_provider
        if config_provider == "custom" or config_provider.startswith("custom:"):
            return "custom"

    # Fall back to supported direct providers discovered from the environment.
    try:
        from fan_cli.config import get_env_value_prefer_dotenv

        for provider_id, pconfig in PROVIDER_REGISTRY.items():
            if pconfig.auth_type != "api_key":
                continue
            for env_var in pconfig.api_key_env_vars:
                value = (get_env_value_prefer_dotenv(env_var) or "").strip()
                if has_usable_secret(value):
                    return provider_id
    except Exception:
        pass

    # Then consider usable direct-provider pool entries. An exhausted pool
    # still has entries, but selecting its provider here would pin automatic
    # runtime resolution to a credential that cannot serve the next request.
    # Do not select the entry itself here; runtime resolution owns rotation
    # and refresh.
    try:
        from agent.credential_pool import load_pool

        for provider_id, pconfig in PROVIDER_REGISTRY.items():
            if pconfig.auth_type != "api_key":
                continue
            pool = load_pool(provider_id)
            if pool is not None and pool.has_available():
                return provider_id
    except Exception:
        pass

    # Preserve compatibility for third-party providers that maintain an active
    # credential selection in the generic auth store.
    try:
        auth_store = _load_auth_store()
        active = str(auth_store.get("active_provider") or "").strip().lower()
        if active and active in PROVIDER_REGISTRY:
            status = get_auth_status(active)
            if status.get("logged_in"):
                return active
    except Exception as exc:
        logger.debug("Could not detect active auth provider: %s", exc)

    raise AuthError(
        "No inference provider is configured. Select a provider and configure its credentials before starting a session.",
        code="provider_not_configured",
    )


def get_api_key_provider_status(provider_id: str) -> Dict[str, Any]:
    """Status snapshot for supported API-key providers."""
    pconfig = PROVIDER_REGISTRY.get(provider_id)
    if not pconfig or pconfig.auth_type != "api_key":
        return {"configured": False}

    api_key = ""
    key_source = ""
    api_key, key_source = _resolve_api_key_provider_secret(provider_id, pconfig)

    env_url = ""
    if pconfig.base_url_env_var:
        env_url = os.getenv(pconfig.base_url_env_var, "").strip()

    if env_url:
        base_url = env_url
    else:
        base_url = pconfig.inference_base_url

    return {
        "configured": bool(api_key),
        "provider": provider_id,
        "name": pconfig.name,
        "key_source": key_source,
        "base_url": base_url,
        "logged_in": bool(api_key),  # compat with OAuth status shape
    }



def get_auth_status(provider_id: Optional[str] = None) -> Dict[str, Any]:
    """Generic auth status dispatcher."""
    target = (provider_id or get_active_provider() or "").strip().lower()
    if not target:
        return {"logged_in": False}
    pconfig = PROVIDER_REGISTRY.get(target)
    if pconfig and pconfig.auth_type == "api_key":
        return get_api_key_provider_status(target)
    return {"logged_in": False}



def resolve_api_key_provider_credentials(provider_id: str) -> Dict[str, Any]:
    """Resolve API key and base URL for an API-key provider.

    Returns dict with: provider, api_key, base_url, source.
    """
    pconfig = PROVIDER_REGISTRY.get(provider_id)
    if not pconfig or pconfig.auth_type != "api_key":
        raise AuthError(
            f"Provider '{provider_id}' is not an API-key provider.",
            provider=provider_id,
            code="invalid_provider",
        )

    api_key = ""
    key_source = ""
    api_key, key_source = _resolve_api_key_provider_secret(provider_id, pconfig)

    env_url = ""
    if pconfig.base_url_env_var:
        env_url = os.getenv(pconfig.base_url_env_var, "").strip()

    if env_url:
        base_url = env_url.rstrip("/")
    else:
        base_url = pconfig.inference_base_url

    return {
        "provider": provider_id,
        "api_key": api_key,
        "base_url": base_url.rstrip("/"),
        "source": key_source or "default",
    }



def _update_config_for_provider(
    provider_id: str,
    inference_base_url: str,
    default_model: Optional[str] = None,
) -> Path:
    """Update config.yaml and auth.json to reflect the active provider.

    When *default_model* is provided the function also writes it as the
    ``model.default`` value.  This prevents a race condition where the
    gateway (which re-reads config per-message) picks up the new provider
    before the caller has finished model selection, resulting in a
    mismatched model/provider (for example an aggregator slug sent to a
    direct provider API).
    """
    # Validate config.yaml before mutating auth.json. Otherwise a broken or
    # unreadable config could make the config write fail after active_provider
    # already changed, leaving the two stores inconsistent.
    config_path = get_config_path()
    require_readable_config_before_write(config_path)

    # Update config.yaml model section
    config_path.parent.mkdir(parents=True, exist_ok=True)

    config = read_raw_config()

    # The canonical selection supersedes every historical spelling. Leaving a
    # root ``provider: fan`` behind would let legacy-aware callers shadow the
    # newly selected provider on the next session start.
    for legacy_key in ("provider", "active_provider", "model_provider"):
        config.pop(legacy_key, None)

    current_model = config.get("model")
    if isinstance(current_model, dict):
        model_cfg = dict(current_model)
    elif isinstance(current_model, str) and current_model.strip():
        model_cfg = {"default": current_model.strip()}
    else:
        model_cfg = {}

    model_cfg["provider"] = provider_id
    if inference_base_url and inference_base_url.strip():
        model_cfg["base_url"] = inference_base_url.rstrip("/")
    else:
        model_cfg.pop("base_url", None)

    # Built-in providers resolve credentials from their own auth state. Clear
    # every endpoint-bound field, including the legacy ``model.api`` spelling.
    clear_model_endpoint_credentials(model_cfg)

    # When switching to a direct provider, ensure model.default is valid for it.
    if default_model:
        model_cfg["default"] = default_model

    config["model"] = model_cfg

    atomic_config_write(config_path, config, sort_keys=False)

    # Only mark the provider active after its config has been written. This
    # avoids an auth/config split-brain if the YAML write fails.
    with _auth_store_lock():
        auth_store = _load_auth_store()
        auth_store["active_provider"] = provider_id
        _save_auth_store(auth_store)
    return config_path


def configure_api_key_provider(
    provider_id: str,
    *,
    api_key: str,
    model: str,
    base_url: Optional[str] = None,
) -> Path:
    """Persist one supported provider selection and its API key safely.

    Callers must validate connectivity before invoking this disk-boundary
    helper. If the YAML write fails after the key is written, restore the old
    ``.env`` value so the operation remains transaction-like.
    """
    canonical = normalize_provider(provider_id)
    pconfig = PROVIDER_REGISTRY.get(canonical)
    if not pconfig or pconfig.auth_type != "api_key":
        raise AuthError(
            f"Provider '{provider_id}' is not an API-key provider.",
            provider=provider_id,
            code="invalid_provider",
        )
    if not has_usable_secret(api_key):
        raise AuthError(
            f"Provider '{canonical}' requires a valid API key.",
            provider=canonical,
            code="missing_api_key",
        )
    env_var = pconfig.api_key_env_vars[0] if pconfig.api_key_env_vars else ""
    if not env_var:
        raise AuthError(
            f"Provider '{canonical}' does not declare an API-key environment variable.",
            provider=canonical,
            code="invalid_provider",
        )

    from fan_cli.config import (
        get_env_value,
        remove_env_value,
        save_env_value,
    )

    old_value = get_env_value(env_var)
    save_env_value(env_var, api_key.strip())
    try:
        return _update_config_for_provider(
            canonical,
            (base_url or pconfig.inference_base_url).strip(),
            model.strip(),
        )
    except BaseException:
        try:
            if old_value is None:
                remove_env_value(env_var)
            else:
                save_env_value(env_var, old_value)
        except Exception:
            logger.exception("Failed to roll back %s after provider config write failure", env_var)
        raise


def _get_config_provider() -> Optional[str]:
    """Return provider from canonical or stale config keys, normalized."""
    try:
        config = read_raw_config()
    except Exception:
        return None
    if not config:
        return None
    model = config.get("model")
    candidates: List[Any] = []
    if isinstance(model, dict):
        candidates.extend(
            (model.get("provider"), model.get("active_provider"), model.get("model_provider"))
        )
    candidates.extend(
        (config.get("provider"), config.get("active_provider"), config.get("model_provider"))
    )
    for provider in candidates:
        if isinstance(provider, str) and provider.strip():
            return normalize_provider(provider.strip().lower())
    return None


def _save_model_choice(model_id: str) -> None:
    """Save the selected model to config.yaml (single source of truth).

    The model is stored in config.yaml only — NOT in .env.  This avoids
    conflicts in multi-agent setups where env vars would stomp each other.
    """
    from fan_cli.config import save_config, load_config

    config = load_config()
    # Always use dict format so provider/base_url can be stored alongside
    if isinstance(config.get("model"), dict):
        config["model"]["default"] = model_id
    else:
        config["model"] = {"default": model_id}
    save_config(config)
    # Explicit one-off endpoint credentials mean a custom OpenAI-compatible
    # endpoint.
    if explicit_api_key or explicit_base_url:
        return "custom"
