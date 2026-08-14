"""Shared constants for Fan Agent.

Import-safe module with no dependencies — can be imported from anywhere
without risk of circular imports.
"""

import os
import stat
import sys
import sysconfig
from contextvars import ContextVar, Token
from pathlib import Path


_UNSET = object()
_FAN_HOME_OVERRIDE: ContextVar[str | object] = ContextVar(
    "_FAN_HOME_OVERRIDE", default=_UNSET
)


def set_fan_home_override(path: str | Path | None) -> Token:
    """Set a context-local Fan home override and return its reset token.

    This is for in-process, per-task scoping.  It deliberately does not mutate
    ``os.environ`` because that is shared by every thread in the process.
    """
    value: str | object = _UNSET if path is None else str(path)
    return _FAN_HOME_OVERRIDE.set(value)


def reset_fan_home_override(token: Token) -> None:
    """Restore the previous context-local Fan home override."""
    _FAN_HOME_OVERRIDE.reset(token)


def get_fan_home_override() -> str | None:
    """Return the active context-local Fan home override, if any."""
    override = _FAN_HOME_OVERRIDE.get()
    if override is _UNSET or not override:
        return None
    return str(override)


def _get_platform_default_fan_home() -> Path:
    """Return the platform-native default Fan home path."""
    if sys.platform == "win32":
        local_appdata = os.environ.get("LOCALAPPDATA", "").strip()
        base = Path(local_appdata) if local_appdata else Path.home() / "AppData" / "Local"
        return base / "fan"
    return Path.home() / ".fan"


def get_fan_home() -> Path:
    """Return the Fan home directory (default: platform-native path).

    Reads FAN_HOME env var, falls back to the platform-native default.
    This is the single source of truth; all other copies should import this.
    """
    override = get_fan_home_override()
    if override:
        return Path(override)

    val = os.environ.get("FAN_HOME", "").strip()
    if val:
        return Path(val)

    return _get_platform_default_fan_home()


def get_default_fan_root() -> Path:
    """Return the root Fan directory.

    In standard deployments this is the platform-native Fan home
    (``~/.fan`` on POSIX, ``%LOCALAPPDATA%\\fan`` on native Windows).

    In Docker or custom deployments where ``FAN_HOME`` points outside
    ``~/.fan`` (e.g. ``/opt/data``), returns ``FAN_HOME`` directly
    because that is the root.

    Import-safe; no dependencies beyond stdlib.
    """
    native_home = _get_platform_default_fan_home()
    env_home = os.environ.get("FAN_HOME", "")
    if not env_home:
        return native_home
    env_path = Path(env_home)
    try:
        env_path.resolve().relative_to(native_home.resolve())
        return native_home
    except ValueError:
        return env_path



def _get_packaged_data_dir(name: str) -> Path | None:
    """Return an installed data-files directory if one exists.

    Used to discover bundled skills and MCP definitions when Fan is installed
    from a wheel that emitted them via setuptools data_files.
    """
    candidates = []
    for scheme in ("data", "purelib", "platlib"):
        raw = sysconfig.get_path(scheme)
        if raw:
            candidates.append(Path(raw) / name)
    for candidate in candidates:
        if candidate.exists():
            return candidate
    return None


def get_optional_mcps_dir(default: Path | None = None) -> Path:
    """Return the optional-mcps directory, honoring package-manager wrappers.

    Resolves Model Context Protocol definitions shipped with the repo but
    disabled by default. Packaged installs may ship ``optional-mcps`` outside the Python
    package tree and expose it via ``FAN_OPTIONAL_MCPS``.
    """
    override = os.getenv("FAN_OPTIONAL_MCPS", "").strip()
    if override:
        return Path(override)
    packaged = _get_packaged_data_dir("optional-mcps")
    if packaged is not None:
        return packaged
    if default is not None:
        return default
    return get_fan_home() / "optional-mcps"


def get_bundled_skills_dir(default: Path | None = None) -> Path:
    """Return the bundled skills directory for source and packaged installs.

    Resolution order:
        1. ``FAN_BUNDLED_SKILLS`` env var (Nix wrapper / explicit override)
        2. Wheel-installed ``<sysconfig data>/skills`` (pip install path)
        3. Caller-supplied ``default`` (typically the source-checkout path)
        4. ``<FAN_HOME>/skills`` last-resort
    """
    override = os.getenv("FAN_BUNDLED_SKILLS", "").strip()
    if override:
        return Path(override)
    packaged = _get_packaged_data_dir("skills")
    if packaged is not None:
        return packaged
    if default is not None:
        return default
    return get_fan_home() / "skills"


def get_fan_dir(new_subpath: str, old_name: str) -> Path:
    """Resolve a Fan subdirectory with backward compatibility.

    New installs get the consolidated layout (e.g. ``cache/images``).
    Existing installs that already have the old path (e.g. ``image_cache``)
    keep using it — no migration required.

    Args:
        new_subpath: Preferred path relative to FAN_HOME (e.g. ``"cache/images"``).
        old_name: Legacy path relative to FAN_HOME (e.g. ``"image_cache"``).

    Returns:
        Absolute ``Path`` — legacy location when it has content, otherwise the
        preferred new location. Empty legacy scaffold directories must not
        shadow populated data in the consolidated layout.
    """
    home = get_fan_home()
    old_path = home / old_name
    if _legacy_path_has_content(old_path):
        return old_path
    return home / new_subpath


def _legacy_path_has_content(path: Path) -> bool:
    """Return whether a legacy path contains data worth preserving.

    Empty directories and dangling symlinks are treated as absent; inaccessible
    paths are treated as occupied to avoid silently abandoning user data.
    """
    try:
        metadata = path.lstat()
    except FileNotFoundError:
        return False
    except OSError:
        return True

    if stat.S_ISLNK(metadata.st_mode):
        try:
            target = path.stat()
        except FileNotFoundError:
            return False
        except OSError:
            return True
        if not stat.S_ISDIR(target.st_mode):
            return True
    elif not stat.S_ISDIR(metadata.st_mode):
        return True

    try:
        next(path.iterdir())
    except StopIteration:
        return False
    except OSError:
        return True
    return True


def display_fan_home() -> str:
    """Return a user-friendly display string for the current FAN_HOME.

    Uses ``~/`` shorthand for readability::

        default:  ``~/.fan``
        custom:   ``/opt/fan-custom``

    Use this in **user-facing** print/log messages instead of hardcoding
    ``~/.fan``.  For code that needs a real ``Path``, use
    :func:`get_fan_home` instead.
    """
    home = get_fan_home()
    try:
        return "~/" + str(home.relative_to(Path.home()))
    except ValueError:
        return str(home)


def secure_parent_dir(path: Path) -> None:
    """Chmod ``0o700`` on the parent directory of *path*, but only if safe.

    Refuses to chmod ``/`` or any top-level directory (resolved parent with
    fewer than 3 parts, i.e. ``/`` or any direct child like ``/usr``) to
    prevent catastrophic host bricking when ``FAN_HOME`` or other path
    env vars resolve to an unexpected location.

    This guard intentionally rejects both the filesystem root and its direct
    children before applying a restrictive mode.
    """
    parent = path.parent.resolve()
    # Refuse root and its direct children (/usr, /home, /var, /tmp, …).
    if parent == Path("/") or len(parent.parts) < 3:
        return
    try:
        os.chmod(parent, 0o700)
    except OSError:
        pass


def get_subprocess_home() -> str | None:
    """Return a Fan-managed HOME directory for subprocesses, or None.

    When ``{FAN_HOME}/home/`` exists on disk, subprocesses should use it
    as ``HOME`` so system tools (git, ssh, gh, npm, etc.) write their
    configs inside the Fan data directory instead of the OS-level ``/root``
    or ``~/``.  This keeps tool state persistent and contained.

    The Python process's own ``os.environ["HOME"]`` and ``Path.home()`` are
    never modified; only subprocess environments should inject this value.
    Activation is directory-based: if the ``home/`` subdirectory does not
    exist, returns ``None`` and behavior is unchanged.
    """
    fan_home = get_fan_home_override() or os.getenv("FAN_HOME")
    if not fan_home:
        return None
    subprocess_home = os.path.join(fan_home, "home")
    if os.path.isdir(subprocess_home):
        return subprocess_home
    return None



VALID_REASONING_EFFORTS = (
    "minimal", "low", "medium", "high", "xhigh", "max", "ultra",
)


def parse_reasoning_effort(effort: str) -> dict | None:
    """Parse a reasoning effort level into a config dict.

    Valid levels: "none", "minimal", "low", "medium", "high", "xhigh",
    "max", "ultra".
    Returns None when the input is empty or unrecognized (caller uses default).
    Returns {"enabled": False} for "none".
    Returns {"enabled": True, "effort": <level>} for valid effort levels.
    """
    if not effort or not effort.strip():
        return None
    effort = effort.strip().lower()
    if effort == "none":
        return {"enabled": False}
    if effort in VALID_REASONING_EFFORTS:
        return {"enabled": True, "effort": effort}
    return None


def is_termux() -> bool:
    """Return True when running inside a Termux (Android) environment.

    Checks ``TERMUX_VERSION`` (set by Termux) or the Termux-specific
    ``PREFIX`` path.  Import-safe — no heavy deps.
    """
    prefix = os.getenv("PREFIX", "")
    return bool(os.getenv("TERMUX_VERSION") or "com.termux/files/usr" in prefix)


_wsl_detected: bool | None = None


def is_wsl() -> bool:
    """Return True when running inside WSL (Windows Subsystem for Linux).

    Checks ``/proc/version`` for the ``microsoft`` marker that both WSL1
    and WSL2 inject.  Result is cached for the process lifetime.
    Import-safe — no heavy deps.
    """
    global _wsl_detected
    if _wsl_detected is not None:
        return _wsl_detected
    try:
        with open("/proc/version", "r", encoding="utf-8") as f:
            _wsl_detected = "microsoft" in f.read().lower()
    except Exception:
        _wsl_detected = False
    return _wsl_detected


_container_detected: bool | None = None


def is_container() -> bool:
    """Return True when running inside a Docker/Podman container.

    Checks ``/.dockerenv`` (Docker), ``/run/.containerenv`` (Podman),
    and ``/proc/1/cgroup`` for container runtime markers.  Result is
    cached for the process lifetime.  Import-safe — no heavy deps.
    """
    global _container_detected
    if _container_detected is not None:
        return _container_detected
    if os.path.exists("/.dockerenv"):
        _container_detected = True
        return True
    if os.path.exists("/run/.containerenv"):
        _container_detected = True
        return True
    try:
        with open("/proc/1/cgroup", "r", encoding="utf-8") as f:
            cgroup = f.read()
            if "docker" in cgroup or "podman" in cgroup or "/lxc/" in cgroup:
                _container_detected = True
                return True
    except OSError:
        pass
    _container_detected = False
    return False


# ─── Well-Known Paths ─────────────────────────────────────────────────────────


def get_config_path() -> Path:
    """Return the path to ``config.yaml`` under FAN_HOME.

    Replaces the ``get_fan_home() / "config.yaml"`` pattern repeated
    in 7+ files (skill_utils.py, fan_logging.py, fan_time.py, etc.).
    """
    return get_fan_home() / "config.yaml"


def get_skills_dir() -> Path:
    """Return the path to the skills directory under FAN_HOME."""
    return get_fan_home() / "skills"



def get_env_path() -> Path:
    """Return the path to the ``.env`` file under FAN_HOME."""
    return get_fan_home() / ".env"


# ─── Network Preferences ─────────────────────────────────────────────────────


def apply_ipv4_preference(force: bool = False) -> None:
    """Monkey-patch ``socket.getaddrinfo`` to prefer IPv4 connections.

    On servers with broken or unreachable IPv6, Python tries AAAA records
    first and hangs for the full TCP timeout before falling back to IPv4.
    This affects httpx, requests, urllib, the OpenAI SDK — everything that
    uses ``socket.getaddrinfo``.

    When *force* is True, patches ``getaddrinfo`` so that calls with
    ``family=AF_UNSPEC`` (the default) resolve as ``AF_INET`` instead,
    skipping IPv6 entirely.  If no A record exists, falls back to the
    original unfiltered resolution so pure-IPv6 hosts still work.

    Safe to call multiple times — only patches once.
    Set ``network.force_ipv4: true`` in ``config.yaml`` to enable.
    """
    if not force:
        return

    import socket

    # Guard against double-patching
    if getattr(socket.getaddrinfo, "_fan_ipv4_patched", False):
        return

    _original_getaddrinfo = socket.getaddrinfo

    def _ipv4_getaddrinfo(host, port, family=0, type=0, proto=0, flags=0):
        if family == 0:  # AF_UNSPEC — caller didn't request a specific family
            try:
                return _original_getaddrinfo(
                    host, port, socket.AF_INET, type, proto, flags
                )
            except socket.gaierror:
                # No A record — fall back to full resolution (pure-IPv6 hosts)
                return _original_getaddrinfo(host, port, family, type, proto, flags)
        return _original_getaddrinfo(host, port, family, type, proto, flags)

    _ipv4_getaddrinfo._fan_ipv4_patched = True  # type: ignore[attr-defined]
    socket.getaddrinfo = _ipv4_getaddrinfo  # type: ignore[assignment]


# ─── Streaming Response Constants ────────────────────────────────────────────

# Response ID for partial stream stubs used during error recovery
PARTIAL_STREAM_STUB_ID = "partial-stream-stub"

FINISH_REASON_LENGTH = "length"


OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"
OPENROUTER_MODELS_URL = f"{OPENROUTER_BASE_URL}/models"
