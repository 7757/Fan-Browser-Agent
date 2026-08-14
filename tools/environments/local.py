"""Local execution environment — spawn-per-call with session snapshot."""

import logging
import os
import platform
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time
from pathlib import Path

from tools.environments.base import BaseEnvironment, _pipe_stdin
from fan_cli._subprocess_compat import windows_hide_flags

_IS_WINDOWS = platform.system() == "Windows"

logger = logging.getLogger(__name__)


def _msys_to_windows_path(cwd: str) -> str:
    """Translate a Git Bash / MSYS-style POSIX path (``/c/Users/x``) to the
    native Windows form (``C:\\Users\\x``) so ``os.path.isdir`` and
    ``subprocess.Popen(..., cwd=...)`` can find it.

    Also accepts Cygwin (``/cygdrive/c/...``) and WSL mount
    (``/mnt/c/...``) drive spellings.  No-ops on non-Windows hosts or for
    paths that are not a drive-root form.
    Returns the input unchanged when no translation applies. This is
    idempotent — calling it on an already-Windows path returns it as-is.
    """
    if not _IS_WINDOWS or not cwd:
        return cwd
    # Match /c/... (MSYS), /cygdrive/c/... (Cygwin), and /mnt/c/... (WSL),
    # including a bare drive root.  Multi-segment POSIX paths such as /home
    # and /tmp deliberately do not match.
    m = re.match(r'^/(?:(?:cygdrive|mnt)/)?([a-zA-Z])(/.*)?$', cwd)
    if not m:
        return cwd
    drive = m.group(1).upper()
    tail = (m.group(2) or "").replace('/', '\\')
    return f"{drive}:{tail or chr(92)}"  # chr(92) = backslash, avoid raw-string escape


def _windows_to_msys_path(cwd: str) -> str:
    """Translate a drive-qualified Windows path for Git Bash's ``cd``.

    Python subprocesses keep native paths, but the login-shell bootstrap runs
    in Git Bash, which reliably resolves ``/c/Users/...`` rather than a native
    drive spelling.
    """
    if not _IS_WINDOWS or not cwd:
        return cwd
    match = re.match(r"^([a-zA-Z]):[\\/]*(.*)$", cwd)
    if not match:
        return cwd
    drive = match.group(1).lower()
    tail = (match.group(2) or "").replace("\\", "/").lstrip("/")
    return f"/{drive}/{tail}" if tail else f"/{drive}/"


def _resolve_safe_cwd(cwd: str) -> str:
    """Return ``cwd`` if it exists as a directory, else the nearest existing
    ancestor.  Falls back to ``tempfile.gettempdir()`` only if walking up the
    path can't find any existing directory (effectively never on a healthy
    filesystem, but cheap belt-and-braces).

    On Windows, also normalizes Git Bash / MSYS-style POSIX paths
    (``/c/Users/x``) to native Windows form before the isdir check so a
    perfectly valid ``pwd -P`` result from bash doesn't get rejected as
    "missing" (see ``_msys_to_windows_path``).

    Used by ``_run_bash`` to recover when the configured cwd is gone — most
    commonly because a previous tool call deleted its own working directory
    (issue #17558).  Without this guard, ``subprocess.Popen(..., cwd=...)``
    raises ``FileNotFoundError`` before bash starts, wedging every subsequent
    terminal call until the gateway restarts.
    """
    cwd = _msys_to_windows_path(cwd) if _IS_WINDOWS else cwd
    if cwd and os.path.isdir(cwd):
        return cwd
    parent = os.path.dirname(cwd) if cwd else ""
    while parent:
        if os.path.isdir(parent):
            return parent
        next_parent = os.path.dirname(parent)
        if next_parent == parent:
            # Reached the filesystem root and it doesn't exist either —
            # genuinely nothing to fall back to except the temp dir.
            break
        parent = next_parent
    return tempfile.gettempdir()


# Fan-internal env vars that should NOT leak into terminal subprocesses.
_FAN_PROVIDER_ENV_FORCE_PREFIX = "_FAN_FORCE_"

# Per-process desktop capabilities are a stricter boundary than ordinary
# provider credentials.  They must never cross into agent-controlled child
# processes, even when an operator has configured env_passthrough or a caller
# uses the private provider-force prefix.  The Python dashboard consumes both
# values at startup; this set protects every explicit subprocess environment
# assembled elsewhere in the process as defense in depth.
_FAN_NEVER_INHERIT_ENV = frozenset({
    "FAN_DESKTOP_SESSION_TOKEN",
    "ELECTRON_BROWSER_RUNTIME_URL",
    "ELECTRON_BROWSER_RUNTIME_TOKEN",
    "BWS_ACCESS_TOKEN",
    "FAN_API_KEY",
    "API_SERVER_KEY",
})


def _is_never_inherit_env(name: object) -> bool:
    """Case-insensitive check because Windows environment names are so."""
    return isinstance(name, str) and name.upper() in _FAN_NEVER_INHERIT_ENV

# Fan-managed AWS *inference* credentials for ``auth_type="aws_sdk"``
# providers (Bedrock).  Scoped DELIBERATELY NARROW: this lists only the
# Bedrock-specific bearer token, which is a Fan inference secret exactly
# analogous to ``OPENAI_API_KEY`` — nobody drives the ``aws``/``terraform``/
# ``boto3`` toolchain off it, so stripping it from terminal/execute_code
# subprocesses costs no user capability.
#
# The GENERAL AWS credential chain (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY,
# AWS_SESSION_TOKEN, AWS_PROFILE, and the config/role pointers) is INTENTIONALLY
# left inheritable.  Per SECURITY.md §3.2 the local terminal is the user's
# trusted operator shell; the agent having the same general AWS access the
# user's own shell has is the intended posture, not a leak.  Hard-blocklisting
# those vars would (a) regress every user who runs aws/terraform/cdk/boto3 in
# the agent terminal — not just Bedrock users, since the registry is iterated
# unconditionally — and (b) be unrecoverable, because env_passthrough.py
# refuses to re-allow anything in this blocklist (GHSA-rhgp-j443-p4rf).  See
# issue #32314 discussion.
_AWS_SDK_CREDENTIAL_ENV_VARS = frozenset({
    "AWS_BEARER_TOKEN_BEDROCK",
})


def _build_provider_env_blocklist() -> frozenset:
    """Derive the blocklist from provider and tool configuration."""
    blocked: set[str] = set()

    try:
        from fan_cli.auth import PROVIDER_REGISTRY
        for pconfig in PROVIDER_REGISTRY.values():
            blocked.update(pconfig.api_key_env_vars)
            if pconfig.auth_type == "aws_sdk":
                blocked.update(_AWS_SDK_CREDENTIAL_ENV_VARS)
            if pconfig.base_url_env_var:
                blocked.add(pconfig.base_url_env_var)
    except ImportError:
        pass

    try:
        from fan_cli.config import OPTIONAL_ENV_VARS
        for name, metadata in OPTIONAL_ENV_VARS.items():
            category = metadata.get("category")
            if category == "tool":
                blocked.add(name)
            elif category == "setting" and metadata.get("password"):
                blocked.add(name)
    except ImportError:
        pass

    # Retired image-provider secrets may still exist in a historical .env;
    # keep them out of arbitrary child-process environments.
    blocked.update({
        "FAL_KEY", "KREA_API_KEY",
    })

    blocked.update({
        "OPENAI_BASE_URL",
        "OPENAI_API_KEY",
        "OPENAI_API_BASE",
        "OPENAI_ORG_ID",
        "OPENAI_ORGANIZATION",
        "OPENROUTER_API_KEY",
        # Retired provider credentials remain quarantined because existing
        # installations may still carry them in a historical .env file.
        "ANTHROPIC_BASE_URL",
        "ANTHROPIC_TOKEN",
        "ANTHROPIC_API_KEY",
        "CLAUDE_CODE_OAUTH_TOKEN",
        "LLM_MODEL",
        "GOOGLE_API_KEY",
        "DEEPSEEK_API_KEY",
        "MISTRAL_API_KEY",
        "GROQ_API_KEY",
        "TOGETHER_API_KEY",
        "PERPLEXITY_API_KEY",
        "COHERE_API_KEY",
        "FIREWORKS_API_KEY",
        "XAI_API_KEY",
        "HELICONE_API_KEY",
        "FAN_DESKTOP_SESSION_TOKEN",
        "GH_TOKEN",
        "GITHUB_APP_ID",
        "GITHUB_APP_PRIVATE_KEY_PATH",
        "GITHUB_APP_INSTALLATION_ID",
        "MODAL_TOKEN_ID",
        "MODAL_TOKEN_SECRET",
        "DAYTONA_API_KEY",
    })
    return frozenset(blocked)


_FAN_PROVIDER_ENV_BLOCKLIST = _build_provider_env_blocklist()

# The desktop/backend may itself run inside a virtual environment.  These
# markers must not cross into arbitrary terminal commands: uv/poetry treat an
# inherited active environment as their install target and could otherwise
# modify Fan's own runtime while working in another project.
_ACTIVE_VENV_MARKER_VARS = ("VIRTUAL_ENV", "CONDA_PREFIX")


def _build_model_provider_env_allowlist() -> frozenset[str]:
    """Return provider variables a model-driving child may legitimately need.

    This is intentionally narrower than ``_FAN_PROVIDER_ENV_BLOCKLIST``: that
    blocklist also contains tool and user-skill credentials. A model worker may
    need the active LLM endpoint, but never needs Notion, ElevenLabs, sudo, or
    Bitwarden credentials.
    """
    allowed: set[str] = set()
    try:
        from fan_cli.auth import PROVIDER_REGISTRY

        for provider in PROVIDER_REGISTRY.values():
            allowed.update(str(name).upper() for name in provider.api_key_env_vars)
            if provider.base_url_env_var:
                allowed.add(str(provider.base_url_env_var).upper())
            if provider.auth_type == "aws_sdk":
                # Bedrock may use the standard AWS chain instead of the
                # provider-specific bearer token.
                allowed.update({
                    "AWS_ACCESS_KEY_ID",
                    "AWS_SECRET_ACCESS_KEY",
                    "AWS_SESSION_TOKEN",
                    "AWS_PROFILE",
                    "AWS_WEB_IDENTITY_TOKEN_FILE",
                    "AWS_ROLE_ARN",
                })
    except Exception:
        # Provider import failure must not broaden child access. Callers still
        # receive ordinary non-secret environment variables.
        pass

    # Fan deliberately has a much smaller built-in provider registry than
    #, but it still supports an explicit OpenAI-compatible custom
    # endpoint.  Those credentials are resolved directly by cli.py and
    # auxiliary_client.py rather than appearing in PROVIDER_REGISTRY.  Keep
    # this narrow, product-owned compatibility set so model-driving children
    # continue to work without reviving removed removed providers.
    allowed.update({
        "OPENAI_API_KEY",
        "OPENAI_BASE_URL",
        "OPENAI_API_BASE",
        "OPENROUTER_API_KEY",
        "OPENROUTER_BASE_URL",
        "CUSTOM_BASE_URL",
        "OLLAMA_API_KEY",
    })

    # Vertex/Google SDK authentication is file-backed rather than represented
    # in every provider registry entry. Fan no longer exposes Vertex as a
    # built-in provider, so do not implicitly pass those legacy variables.
    return frozenset(allowed)


_FAN_MODEL_PROVIDER_ENV_ALLOWLIST = _build_model_provider_env_allowlist()

# Fan-owned Browser Agent workers are the sole non-terminal child allowed to
# reuse the desktop's loopback browser capability. Generic CLIs, installers,
# LSP/MCP servers, and third-party tools must never receive it.
_FAN_BROWSER_RUNTIME_ENV_ALLOWLIST = frozenset({
    "ELECTRON_BROWSER_RUNTIME_URL",
    "ELECTRON_BROWSER_RUNTIME_TOKEN",
})


def _build_nonterminal_protected_env() -> frozenset[str]:
    """Return Fan-managed credentials hidden from generic child processes."""
    protected = {str(name).upper() for name in _FAN_PROVIDER_ENV_BLOCKLIST}
    protected.update(str(name).upper() for name in _FAN_NEVER_INHERIT_ENV)
    protected.update(_FAN_MODEL_PROVIDER_ENV_ALLOWLIST)
    try:
        from fan_cli.config import OPTIONAL_ENV_VARS

        # Skill credentials are deliberately available to the terminal only
        # after an explicit skill/config passthrough. They are not implicit
        # input to model CLIs, installers, or helper binaries.
        for name, metadata in OPTIONAL_ENV_VARS.items():
            if metadata.get("password"):
                protected.add(str(name).upper())
    except Exception:
        pass
    return frozenset(protected)


_FAN_NONTERMINAL_PROTECTED_ENV = _build_nonterminal_protected_env()


def _is_fan_internal_secret(name: object) -> bool:
    """True for internal capabilities that no spawned child may inherit.

    Dynamic auxiliary keys are populated from ``config.yaml`` at runtime and
    therefore cannot be covered by a static provider registry. Base URLs are
    included because auxiliary endpoints may be private network addresses.
    """
    if not isinstance(name, str):
        return False
    upper = name.upper()
    if upper in _FAN_NEVER_INHERIT_ENV:
        return True
    if upper.startswith(_FAN_PROVIDER_ENV_FORCE_PREFIX):
        return True
    return upper.startswith("AUXILIARY_") and upper.endswith(
        ("_API_KEY", "_BASE_URL", "_TOKEN", "_SECRET")
    )


def fan_subprocess_env(
    *,
    inherit_provider_credentials: bool = False,
    inherit_browser_runtime_capability: bool = False,
    extra_env: dict | None = None,
) -> dict[str, str]:
    """Build the environment for a non-terminal Fan subprocess.

    Ordinary locale, proxy, PATH, profile and feature settings are preserved.
    Fan-managed credentials are stripped by default. A model-driving Fan child
    may opt into the narrow provider allowlist. A Fan-owned Browser Agent child
    may separately opt into the Electron loopback browser capability; this is
    intentionally grep-able and does not expose any other internal credential.
    ``extra_env`` is an explicit caller override, but cannot restore protected
    capabilities unless the corresponding narrow opt-in is enabled.

    User terminal/background commands intentionally keep their existing
    ``env_passthrough`` policy and do not use this helper.
    """
    merged = dict(os.environ)
    if extra_env:
        merged.update(extra_env)

    sanitized: dict[str, str] = {}
    for key, value in merged.items():
        upper = str(key).upper()
        if _is_fan_internal_secret(key):
            if not (
                inherit_browser_runtime_capability
                and upper in _FAN_BROWSER_RUNTIME_ENV_ALLOWLIST
            ):
                continue
        if upper in _FAN_NONTERMINAL_PROTECTED_ENV:
            if not (
                (
                    inherit_provider_credentials
                    and upper in _FAN_MODEL_PROVIDER_ENV_ALLOWLIST
                )
                or (
                    inherit_browser_runtime_capability
                    and upper in _FAN_BROWSER_RUNTIME_ENV_ALLOWLIST
                )
            ):
                continue
        sanitized[str(key)] = str(value)

    sanitized.setdefault("PYTHONUTF8", "1")
    _inject_context_fan_home(sanitized)
    from fan_constants import get_subprocess_home

    profile_home = get_subprocess_home()
    if profile_home:
        sanitized["HOME"] = profile_home
    for marker in _ACTIVE_VENV_MARKER_VARS:
        sanitized.pop(marker, None)
    return sanitized


def _inject_context_fan_home(env: dict) -> None:
    """Bridge the context-local Fan home override into subprocess env."""
    try:
        from fan_constants import get_fan_home_override

        value = get_fan_home_override()
        if value:
            env["FAN_HOME"] = value
    except Exception:
        pass


def _sanitize_subprocess_env(base_env: dict | None, extra_env: dict | None = None) -> dict:
    """Filter Fan-managed secrets from a subprocess environment."""
    try:
        from tools.env_passthrough import is_env_passthrough as _is_passthrough
    except Exception:
        _is_passthrough = lambda _: False  # noqa: E731

    sanitized: dict[str, str] = {}

    for key, value in (base_env or {}).items():
        if key.startswith(_FAN_PROVIDER_ENV_FORCE_PREFIX):
            continue
        if _is_fan_internal_secret(key):
            continue
        if key not in _FAN_PROVIDER_ENV_BLOCKLIST or _is_passthrough(key):
            sanitized[key] = value

    for key, value in (extra_env or {}).items():
        if key.startswith(_FAN_PROVIDER_ENV_FORCE_PREFIX):
            real_key = key[len(_FAN_PROVIDER_ENV_FORCE_PREFIX):]
            if _is_fan_internal_secret(real_key):
                continue
            sanitized[real_key] = value
        elif _is_fan_internal_secret(key):
            continue
        elif key not in _FAN_PROVIDER_ENV_BLOCKLIST or _is_passthrough(key):
            sanitized[key] = value

    _inject_context_fan_home(sanitized)

    # Per-profile HOME isolation for background processes (same as _make_run_env).
    from fan_constants import get_subprocess_home
    _profile_home = get_subprocess_home()
    if _profile_home:
        sanitized["HOME"] = _profile_home

    # Marks every process launched through an agent-owned terminal/background
    # channel. Fan's config CLI uses this as a trusted-call boundary: a real
    # user in an independent shell may edit configuration, while model-driven
    # subprocesses may not rewrite execution authority.
    sanitized["FAN_AGENT_TOOL_SESSION"] = "1"

    for marker in _ACTIVE_VENV_MARKER_VARS:
        sanitized.pop(marker, None)

    return sanitized


def _is_wsl_relay_bash(path: str) -> bool:
    """True when ``path`` is Windows' WSL relay shim (System32\\bash.exe).

    That binary is NOT a shell: it boots the default WSL distro and execs
    /bin/bash inside it. With docker-desktop (or no distro) as the default,
    every invocation dies with ``WSL (Relay) ERROR: execvpe(/bin/bash)
    failed`` — and even with a working distro it has WSL semantics, not the
    Git-Bash/MSYS semantics Fan's tools are written for. Never use it.
    """
    try:
        system_root = os.environ.get("SystemRoot", r"C:\Windows")
        return os.path.normcase(os.path.abspath(path)).startswith(
            os.path.normcase(os.path.abspath(system_root))
        )
    except Exception:
        return False


def _find_bash() -> str:
    """Find bash for command execution."""
    if not _IS_WINDOWS:
        return (
            shutil.which("bash")
            or ("/usr/bin/bash" if os.path.isfile("/usr/bin/bash") else None)
            or ("/bin/bash" if os.path.isfile("/bin/bash") else None)
            or os.environ.get("SHELL")
            or "/bin/sh"
        )

    custom = os.environ.get("FAN_GIT_BASH_PATH")
    if custom and os.path.isfile(custom):
        return custom

    # Prefer our own portable Git install first — this way a broken or
    # partially-uninstalled system Git can't hijack the bash lookup.  The
    # install.ps1 installer always drops portable Git here when the user
    # didn't already have a working system Git.
    #
    # Layouts (both checked so upgrades between MinGit and PortableGit
    # installs work transparently):
    #   PortableGit: %LOCALAPPDATA%\fan\git\bin\bash.exe   (primary)
    #   MinGit:      %LOCALAPPDATA%\fan\git\usr\bin\bash.exe (legacy/32-bit fallback)
    _local_appdata = os.environ.get("LOCALAPPDATA", "")
    _fan_portable_git = os.path.join(_local_appdata, "fan", "git") if _local_appdata else ""
    if _fan_portable_git:
        for candidate in (
            os.path.join(_fan_portable_git, "bin", "bash.exe"),        # PortableGit (primary)
            os.path.join(_fan_portable_git, "usr", "bin", "bash.exe"), # MinGit fallback
        ):
            if os.path.isfile(candidate):
                return candidate

    # Known Git-for-Windows locations BEFORE the PATH lookup: on stock
    # Windows, PATH's `bash` is often the System32 WSL relay shim, which
    # shadows a perfectly good Git Bash install (observed in the field:
    # write_file failing with "WSL (Relay) ERROR: execvpe(/bin/bash)"
    # because the default distro was docker-desktop).
    for candidate in (
        os.path.join(os.environ.get("ProgramFiles", r"C:\Program Files"), "Git", "bin", "bash.exe"),
        os.path.join(os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)"), "Git", "bin", "bash.exe"),
        os.path.join(_local_appdata, "Programs", "Git", "bin", "bash.exe"),
    ):
        if candidate and os.path.isfile(candidate):
            return candidate

    found = shutil.which("bash")
    if found and not _is_wsl_relay_bash(found):
        return found

    raise RuntimeError(
        "Git Bash not found. Fan Agent requires Git for Windows on Windows.\n"
        "Install it from: https://git-scm.com/download/win\n"
        "Or set FAN_GIT_BASH_PATH to your bash.exe location."
    )


_git_bash_bin_dirs_cache: list[str] | None = None


def _git_bash_bin_dirs() -> list[str]:
    """Return Git Bash binary directories in profile precedence order."""
    global _git_bash_bin_dirs_cache
    if _git_bash_bin_dirs_cache is not None:
        return _git_bash_bin_dirs_cache
    if not _IS_WINDOWS:
        _git_bash_bin_dirs_cache = []
        return _git_bash_bin_dirs_cache

    try:
        bash = _find_bash()
    except Exception:
        _git_bash_bin_dirs_cache = []
        return _git_bash_bin_dirs_cache

    bin_dir = os.path.dirname(bash)
    parent = os.path.dirname(bin_dir)
    root = (
        os.path.dirname(parent)
        if os.path.basename(parent).lower() == "usr"
        else parent
    )

    directories: list[str] = []
    for candidate in (
        os.path.join(root, "mingw64", "bin"),
        os.path.join(root, "mingw32", "bin"),
        os.path.join(root, "usr", "local", "bin"),
        os.path.join(root, "usr", "bin"),
        os.path.join(root, "bin"),
    ):
        if os.path.isdir(candidate) and candidate not in directories:
            directories.append(candidate)

    _git_bash_bin_dirs_cache = directories
    return _git_bash_bin_dirs_cache


def _prepend_git_bash_dirs(existing_path: str) -> str:
    """Prepend missing Git Bash coreutils directories to a Windows PATH."""
    git_dirs = _git_bash_bin_dirs()
    if not git_dirs:
        return existing_path
    entries = [entry for entry in existing_path.split(os.pathsep) if entry]
    missing = [directory for directory in git_dirs if directory not in entries]
    if not missing:
        return existing_path
    return os.pathsep.join([*missing, *entries])


_SPAWN_COMPATIBLE_SHELLS = frozenset({"bash", "zsh", "sh", "dash", "ksh", "mksh"})


def _find_shell() -> str:
    """Return a login shell compatible with Fan's ``-lic`` spawn contract.

    Background processes must use the user's configured POSIX shell where
    possible.  On macOS, falling back to bash can source a ``.bash_profile``
    that replaces itself with zsh and discards the command argument, making a
    seemingly successful background spawn do nothing.  Non-POSIX shells such
    as fish are deliberately ignored because they cannot interpret ``-lic``
    and ``set +m`` used by the process registry.
    """
    if not _IS_WINDOWS:
        user_shell = os.environ.get("SHELL")
        if (
            user_shell
            and os.path.isfile(user_shell)
            and os.access(user_shell, os.X_OK)
            and Path(user_shell).name in _SPAWN_COMPATIBLE_SHELLS
        ):
            return user_shell
    return _find_bash()


# Standard PATH entries for environments with minimal PATH.
_SANE_PATH = (
    "/opt/homebrew/bin:/opt/homebrew/sbin:"
    "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
)


# Cached directory containing the ``fan`` console script. ``_SENTINEL`` keeps
# an unresolved value distinct from a resolved-but-unavailable one.
_SENTINEL = object()
_FAN_BIN_DIR: object = _SENTINEL


def _resolve_fan_bin_dir() -> str | None:
    """Return the directory containing the installed ``fan`` command.

    A terminal child inherits the desktop/service process environment rather
    than an interactive shell. Those launch paths commonly omit the active
    venv/pipx/bin directory, leaving a usable Fan installation unreachable to
    a bare ``fan`` invocation inside terminal_tool.
    """
    global _FAN_BIN_DIR
    if _FAN_BIN_DIR is not _SENTINEL:
        return _FAN_BIN_DIR if isinstance(_FAN_BIN_DIR, str) else None

    candidate: str | None = None
    resolved = shutil.which("fan")
    if resolved:
        candidate = os.path.dirname(resolved)

    if candidate is None:
        argv0 = sys.argv[0] if sys.argv else ""
        executable_name = os.path.basename(argv0).lower()
        if (
            os.path.isabs(argv0)
            and (executable_name == "fan" or executable_name.startswith("fan."))
            and os.path.isfile(argv0)
        ):
            candidate = os.path.dirname(argv0)

    if candidate is None:
        executable_dir = os.path.dirname(sys.executable) if sys.executable else ""
        shim = "fan.exe" if _IS_WINDOWS else "fan"
        if executable_dir and os.path.isfile(os.path.join(executable_dir, shim)):
            candidate = executable_dir

    if candidate and not os.path.isdir(candidate):
        candidate = None
    _FAN_BIN_DIR = candidate
    return candidate


def _prepend_fan_bin_dir(existing_path: str) -> str:
    """Prepend Fan's install directory to PATH when it is not already present."""
    bin_dir = _resolve_fan_bin_dir()
    if not bin_dir:
        return existing_path
    entries = [entry for entry in existing_path.split(os.pathsep) if entry]
    if bin_dir in entries:
        return existing_path
    return os.pathsep.join([bin_dir, *entries])


def _append_missing_sane_path_entries(existing_path: str) -> str:
    """Return a normalised POSIX PATH with missing sane entries appended.

    On POSIX the caller-supplied PATH is rewritten (not merely appended to):
    empty entries and duplicate entries are dropped, preserving
    first-occurrence order, then each missing ``_SANE_PATH`` entry is appended
    once at the end so existing entries keep their precedence.

    Two intentional normalisations beyond the bare "add Homebrew dirs" fix:

    - **Empty entries are stripped.** A leading/trailing/double ``:`` encodes
      an empty PATH element, which POSIX shells interpret as the current
      working directory — a mild foot-gun in a default terminal environment.
      We drop these rather than carry them through.
    - **Duplicates are collapsed** (first occurrence wins), so a caller PATH
      that already contains repeats is not propagated verbatim.

    For a well-formed PATH (no empties, no duplicates) the leading segment is
    byte-identical to the input and ordering is preserved; only the missing
    sane entries are appended. On Windows this is a no-op passthrough (the
    separator is ``;`` and the native PATH must not be touched).
    """
    if _IS_WINDOWS:
        return existing_path

    sane_entries = [entry for entry in _SANE_PATH.split(":") if entry]
    if not existing_path:
        return ":".join(sane_entries)

    # De-duplicate the caller PATH (first occurrence wins) and drop empty
    # entries before merging in the sane fallbacks.
    seen: set[str] = set()
    ordered_entries: list[str] = []
    for entry in existing_path.split(":"):
        if not entry or entry in seen:
            continue
        seen.add(entry)
        ordered_entries.append(entry)

    # _SANE_PATH is a static, duplicate-free constant, so a membership check
    # against the caller entries is sufficient — no need to track `seen` here.
    for entry in sane_entries:
        if entry not in seen:
            ordered_entries.append(entry)

    return ":".join(ordered_entries)


def _path_env_key(run_env: dict) -> str | None:
    """Return the PATH env key to update without altering Windows casing.

    Note: this is deliberately a *second* Windows guard, distinct from the
    early-return in ``_append_missing_sane_path_entries``. Its job is to pick
    the correctly-cased key (``Path`` vs ``PATH``) so completion writes back to
    the key the caller already used; the helper's guard makes that helper safe
    to call standalone (it is, e.g. in the Windows unit tests). Both are
    intentional.
    """
    if not _IS_WINDOWS:
        return "PATH"
    for key in run_env:
        if key.upper() == "PATH":
            return key
    return None


def _make_run_env(env: dict) -> dict:
    """Build a run environment with a sane PATH and provider-var stripping."""
    try:
        from tools.env_passthrough import is_env_passthrough as _is_passthrough
    except Exception:
        _is_passthrough = lambda _: False  # noqa: E731

    merged = dict(os.environ | env)
    run_env = {}
    for k, v in merged.items():
        if k.startswith(_FAN_PROVIDER_ENV_FORCE_PREFIX):
            real_key = k[len(_FAN_PROVIDER_ENV_FORCE_PREFIX):]
            if _is_fan_internal_secret(real_key):
                continue
            run_env[real_key] = v
        elif _is_fan_internal_secret(k):
            continue
        elif k not in _FAN_PROVIDER_ENV_BLOCKLIST or _is_passthrough(k):
            run_env[k] = v
    path_key = _path_env_key(run_env)
    if path_key is not None:
        path_value = _append_missing_sane_path_entries(run_env.get(path_key, ""))
        path_value = _prepend_git_bash_dirs(path_value)
        run_env[path_key] = _prepend_fan_bin_dir(path_value)

    _inject_context_fan_home(run_env)

    # Per-profile HOME isolation: redirect system tool configs (git, ssh, gh,
    # npm …) into {FAN_HOME}/home/ when that directory exists.  Only the
    # subprocess sees the override — the Python process keeps the real HOME.
    from fan_constants import get_subprocess_home
    _profile_home = get_subprocess_home()
    if _profile_home:
        run_env["HOME"] = _profile_home

    # Do not rely on gateway/cron-specific markers alone: CLI Agent sessions
    # also execute through LocalEnvironment and must not be able to invoke
    # ``fan config set`` as a policy-escalation primitive.
    run_env["FAN_AGENT_TOOL_SESSION"] = "1"

    # Session vars now live directly in os.environ (no ContextVar bridge),
    # so run_env (derived from os.environ) already carries them.

    for marker in _ACTIVE_VENV_MARKER_VARS:
        run_env.pop(marker, None)

    return run_env


def _read_terminal_shell_init_config() -> tuple[list[str], bool]:
    """Return (shell_init_files, auto_source_bashrc) from config.yaml.

    Best-effort — returns sensible defaults on any failure so terminal
    execution never breaks because the config file is unreadable.
    """
    try:
        from fan_cli.config import load_config

        cfg = load_config() or {}
        terminal_cfg = cfg.get("terminal") or {}
        files = terminal_cfg.get("shell_init_files") or []
        if not isinstance(files, list):
            files = []
        auto_bashrc = bool(terminal_cfg.get("auto_source_bashrc", True))
        return [str(f) for f in files if f], auto_bashrc
    except Exception:
        return [], True


def _resolve_shell_init_files() -> list[str]:
    """Resolve the list of files to source before the login-shell snapshot.

    Expands ``~`` and ``${VAR}`` references and drops anything that doesn't
    exist on disk, so a missing ``~/.bashrc`` never breaks the snapshot.
    The ``auto_source_bashrc`` path runs only when the user hasn't supplied
    an explicit list — once they have, Fan trusts them.
    """
    explicit, auto_bashrc = _read_terminal_shell_init_config()

    candidates: list[str] = []
    if explicit:
        candidates.extend(explicit)
    elif auto_bashrc and not _IS_WINDOWS:
        # Build a login-shell-ish source list so tools like n / nvm / asdf /
        # pyenv that self-install into the user's shell rc land on PATH in
        # the captured snapshot.
        #
        # ~/.profile and ~/.bash_profile run first because they have no
        # interactivity guard — installers like ``n`` and ``nvm`` append
        # their PATH export there on most distros, and a non-interactive
        # ``. ~/.profile`` picks that up.
        #
        # ~/.bashrc runs last. On Debian/Ubuntu the default bashrc starts
        # with ``case $- in *i*) ;; *) return;; esac`` and exits early
        # when sourced non-interactively, which is why sourcing bashrc
        # alone misses nvm/n PATH additions placed below that guard. We
        # still include it so users who put PATH logic in bashrc (and
        # stripped the guard, or never had one) keep working.
        candidates.extend(["~/.profile", "~/.bash_profile", "~/.bashrc"])

    resolved: list[str] = []
    for raw in candidates:
        try:
            path = os.path.expandvars(os.path.expanduser(raw))
        except Exception:
            continue
        if path and os.path.isfile(path):
            resolved.append(path)
    return resolved


def _prepend_shell_init(cmd_string: str, files: list[str]) -> str:
    """Prepend ``source <file>`` lines (guarded + silent) to a bash script.

    Each file is wrapped so a failing rc file doesn't abort the whole
    bootstrap: ``set +e`` keeps going on errors, ``2>/dev/null`` hides
    noisy prompts, and ``|| true`` neutralises the exit status.
    """
    if not files:
        return cmd_string

    prelude_parts = ["set +e"]
    for path in files:
        # shlex.quote isn't available here without an import; the files list
        # comes from os.path.expanduser output so it's a concrete absolute
        # path.  Escape single quotes defensively anyway.
        safe = path.replace("'", "'\\''")
        prelude_parts.append(f"[ -r '{safe}' ] && . '{safe}' 2>/dev/null || true")
    prelude = "\n".join(prelude_parts) + "\n"
    return prelude + cmd_string


class LocalEnvironment(BaseEnvironment):
    """Run commands directly on the host machine.

    Spawn-per-call: every execute() spawns a fresh bash process.
    Session snapshot preserves env vars across calls.
    CWD persists via file-based read after each command.
    """

    def __init__(self, cwd: str = "", timeout: int = 60, env: dict = None):
        if cwd:
            cwd = os.path.expanduser(cwd)
        super().__init__(cwd=cwd or os.getcwd(), timeout=timeout, env=env)
        self.init_session()

    def get_temp_dir(self) -> str:
        """Return a shell-safe writable temp dir for local execution.

        Termux does not provide /tmp by default, but exposes a POSIX TMPDIR.
        Prefer POSIX-style env vars when available, keep using /tmp on regular
        Unix systems, and only fall back to tempfile.gettempdir() when it also
        resolves to a POSIX path.

        Check the environment configured for this backend first so callers can
        override the temp root explicitly (for example via terminal.env or a
        custom TMPDIR), then fall back to the host process environment.

        **Windows:** hardcoded ``/tmp`` is wrong in two ways — native Python
        can't open the path, and the Windows default temp (``%TEMP%``) often
        contains spaces (``C:\\Users\\Some Name\\AppData\\Local\\Temp``) that
        break unquoted bash interpolations.  Use a dedicated cache dir under
        ``FAN_HOME`` instead — single-word path, guaranteed to exist, same
        string resolves in both Git Bash and native Python.
        """
        if _IS_WINDOWS:
            # Derive a Windows-safe temp dir under FAN_HOME.  Using
            # forward slashes makes the same string work unchanged in bash
            # command interpolations AND in Python ``open()`` — Windows
            # accepts forward slashes in filesystem paths, and we control
            # the path so we can guarantee no spaces.
            try:
                from fan_constants import get_fan_home
                cache_dir = get_fan_home() / "cache" / "terminal"
            except Exception:
                cache_dir = Path(tempfile.gettempdir()) / "fan_terminal"
            cache_dir.mkdir(parents=True, exist_ok=True)
            # Force forward slashes so the same string serves both contexts.
            return str(cache_dir).replace("\\", "/")

        for env_var in ("TMPDIR", "TMP", "TEMP"):
            candidate = self.env.get(env_var) or os.environ.get(env_var)
            if candidate and candidate.startswith("/"):
                return candidate.rstrip("/") or "/"

        if os.path.isdir("/tmp") and os.access("/tmp", os.W_OK | os.X_OK):
            return "/tmp"

        candidate = tempfile.gettempdir()
        if candidate.startswith("/"):
            return candidate.rstrip("/") or "/"

        return "/tmp"

    @staticmethod
    def _quote_cwd_for_cd(cwd: str) -> str:
        """Use native paths for Python, but Git-Bash-compatible paths for cd."""
        return BaseEnvironment._quote_cwd_for_cd(_windows_to_msys_path(cwd))

    def _run_bash(self, cmd_string: str, *, login: bool = False,
                  timeout: int = 120,
                  stdin_data: str | None = None) -> subprocess.Popen:
        bash = _find_bash()
        # For login-shell invocations (used by init_session to build the
        # environment snapshot), prepend sources for the user's bashrc /
        # custom init files so tools registered outside bash_profile
        # (nvm, asdf, pyenv, …) end up on PATH in the captured snapshot.
        # Non-login invocations are already sourcing the snapshot and
        # don't need this.
        if login:
            init_files = _resolve_shell_init_files()
            if init_files:
                cmd_string = _prepend_shell_init(cmd_string, init_files)
        args = [bash, "-l", "-c", cmd_string] if login else [bash, "-c", cmd_string]
        # Agent terminal commands can invoke arbitrary interpreters or scripts,
        # so shell parsing alone cannot protect Fan authority state.  On the
        # shipped macOS client, Seatbelt applies the shared file-safety policy
        # to this process and every descendant.
        from agent.file_safety import wrap_agent_subprocess_argv

        args = wrap_agent_subprocess_argv(args)
        run_env = _make_run_env(self.env)

        # Recover when the cwd has been deleted out from under us — usually by
        # a previous tool call that ran ``rm -rf`` on its own working dir
        # (issue #17558).  Popen would otherwise raise FileNotFoundError on
        # the cwd before bash starts, wedging every subsequent call until the
        # gateway restarts.
        #
        # On Windows, ``_resolve_safe_cwd`` also normalises Git Bash-style
        # POSIX paths (``/c/Users/...``) to native form so a perfectly valid
        # ``pwd -P`` result from bash isn't mistakenly treated as "missing"
        # and spammed as a warning on every command.
        safe_cwd = _resolve_safe_cwd(self.cwd)
        if safe_cwd != self.cwd:
            # MSYS → Windows translation alone shouldn't surface as a warning
            # (it's a benign normalization, not a recovery). Only warn when
            # the directory really doesn't exist on disk.
            normalized = _msys_to_windows_path(self.cwd) if _IS_WINDOWS else self.cwd
            if safe_cwd != normalized:
                logger.warning(
                    "LocalEnvironment cwd %r is missing on disk; "
                    "falling back to %r so terminal commands keep working.",
                    self.cwd,
                    safe_cwd,
                )
            self.cwd = safe_cwd

        _popen_cwd = self.cwd

        _popen_kwargs = {"creationflags": windows_hide_flags()} if _IS_WINDOWS else {}

        proc = subprocess.Popen(
            args,
            text=True,
            env=run_env,
            encoding="utf-8",
            errors="replace",
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            stdin=subprocess.PIPE if stdin_data is not None else subprocess.DEVNULL,
            start_new_session=True,
            cwd=_popen_cwd,
            **_popen_kwargs,
        )
        if not _IS_WINDOWS:
            try:
                proc._fan_pgid = os.getpgid(proc.pid)
            except ProcessLookupError:
                pass

        if stdin_data is not None:
            _pipe_stdin(proc, stdin_data)

        return proc

    def _kill_process(self, proc):
        """Kill the entire process group (all children)."""

        def _group_alive(pgid: int) -> bool:
            try:
                # POSIX-only: _IS_WINDOWS is handled before this helper is used.
                os.killpg(pgid, 0)  # windows-footgun: ok — POSIX process-group alive probe
                return True
            except ProcessLookupError:
                return False
            except PermissionError:
                # The group exists, even if this process cannot signal it.
                return True

        def _wait_for_group_exit(pgid: int, timeout: float) -> bool:
            deadline = time.monotonic() + timeout
            while time.monotonic() < deadline:
                # Reap the wrapper promptly. A dead but unreaped group leader
                # still makes killpg(pgid, 0) report the group as alive.
                try:
                    proc.poll()
                except Exception:
                    pass
                if not _group_alive(pgid):
                    return True
                time.sleep(0.05)
            try:
                proc.poll()
            except Exception:
                pass
            return not _group_alive(pgid)

        try:
            if _IS_WINDOWS:
                proc.terminate()
            else:
                try:
                    pgid = os.getpgid(proc.pid)
                except ProcessLookupError:
                    pgid = getattr(proc, "_fan_pgid", None)
                    if pgid is None:
                        raise

                try:
                    os.killpg(pgid, signal.SIGTERM)  # windows-footgun: ok — POSIX process-group SIGTERM (guarded by _IS_WINDOWS above)
                except ProcessLookupError:
                    return

                # Wait on the process group, not just the shell wrapper. Under
                # load the wrapper can exit before grandchildren do; returning
                # at that point leaves orphaned process-group members behind.
                if _wait_for_group_exit(pgid, 1.0):
                    return

                try:
                    # POSIX-only: _IS_WINDOWS is handled by the outer branch.
                    os.killpg(pgid, signal.SIGKILL)  # windows-footgun: ok — POSIX process-group SIGKILL
                except ProcessLookupError:
                    return
                _wait_for_group_exit(pgid, 2.0)
                try:
                    proc.wait(timeout=0.2)
                except (subprocess.TimeoutExpired, OSError):
                    pass
        except (ProcessLookupError, PermissionError, OSError):
            try:
                proc.kill()
            except Exception:
                pass

    def _update_cwd(self, result: dict):
        """Read CWD from temp file (local-only, no round-trip needed).

        Skip the assignment when the path no longer exists as a directory —
        ``pwd -P`` on a deleted cwd can leave a stale value in the marker
        file, and propagating it would re-wedge the next ``Popen``.  The
        ``_run_bash`` recovery path will resolve a safe fallback if needed.

        On Windows, the value written by Git Bash's ``pwd -P`` is in
        MSYS form (``/c/Users/x``). Translate it to native Windows form
        before validating with ``os.path.isdir`` and before storing on
        ``self.cwd``; otherwise the isdir check rejects every valid
        result and ``_run_bash`` later prints a misleading "cwd is
        missing" warning on every command.
        """
        try:
            with open(self._cwd_file, encoding="utf-8") as f:
                cwd_path = f.read().strip()
            if _IS_WINDOWS:
                cwd_path = _msys_to_windows_path(cwd_path)
            if cwd_path and os.path.isdir(cwd_path):
                self.cwd = cwd_path
        except (OSError, FileNotFoundError):
            pass

        # Still strip the marker from output so it's not visible
        self._extract_cwd_from_output(result)

    def _extract_cwd_from_output(self, result: dict):
        """Same semantics as the base class, but on Windows the value
        emitted by ``pwd -P`` inside Git Bash is in MSYS form
        (``/c/Users/x``). Normalize to native Windows form and validate
        the directory exists before assigning to ``self.cwd`` — otherwise
        ``_run_bash``'s safe-cwd recovery would warn on every subsequent
        command.

        Always defers to the base class for stripping the marker text from
        ``result["output"]`` so output formatting is identical.
        """
        # Snapshot pre-existing cwd, defer to base for parsing + marker
        # stripping, then validate / normalize whatever it assigned.
        prev_cwd = self.cwd
        super()._extract_cwd_from_output(result)
        if self.cwd != prev_cwd:
            normalized = _msys_to_windows_path(self.cwd) if _IS_WINDOWS else self.cwd
            if normalized and os.path.isdir(normalized):
                self.cwd = normalized
            else:
                # Stale / non-existent path — keep previous cwd; _run_bash
                # will resolve a safe fallback on the next call if needed.
                self.cwd = prev_cwd

    def cleanup(self):
        """Clean up temp files."""
        for f in (self._snapshot_path, self._cwd_file):
            try:
                os.unlink(f)
            except OSError:
                pass
        # A process interrupted between snapshot assembly and mv can leave its
        # per-BASHPID temporary file behind.  It is safe to remove only this
        # session's namespaced files during cleanup.
        try:
            import glob

            for tmp in glob.glob(f"{self._snapshot_path}.tmp.*"):
                try:
                    os.unlink(tmp)
                except OSError:
                    pass
        except Exception:
            pass
