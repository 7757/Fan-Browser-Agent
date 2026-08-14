"""Shared file safety rules used by both tools and ACP shims."""

from __future__ import annotations

import os
import platform
import re
import stat
from pathlib import Path
from typing import Optional, Sequence


# Fan files whose contents influence authentication or execution authority.
# Agent-facing file tools must never mutate these files. Keep this centralized
# so new recovery/cache files do not silently miss one of the write guards.
FAN_AUTHORITY_STATE_FILENAMES = frozenset(
    {
        "auth.json",
        "config.yaml",
        "config.validated.yaml",
    }
)


def _fan_home_path() -> Path:
    """Resolve FAN_HOME without circular imports."""
    try:
        from fan_constants import get_fan_home  # local import to avoid cycles
        return get_fan_home()
    except Exception:
        return Path(os.path.expanduser("~/.fan"))


def _fan_root_path() -> Path:
    """Resolve the Fan root dir."""
    try:
        from fan_constants import get_default_fan_root  # local import to avoid cycles
        return get_default_fan_root()
    except Exception:
        return Path(os.path.expanduser("~/.fan"))


def build_write_denied_paths(home: str) -> set[str]:
    """Return exact sensitive paths that must never be written."""
    fan_home = _fan_home_path()
    fan_root = _fan_root_path()
    return {
        os.path.realpath(p)
        for p in [
            os.path.join(home, ".ssh", "authorized_keys"),
            os.path.join(home, ".ssh", "id_rsa"),
            os.path.join(home, ".ssh", "id_ed25519"),
            os.path.join(home, ".ssh", "config"),
            # Fan .env.
            str(fan_home / ".env"),
            # Fan configuration authority and its durable/cache layers.
            *(str(fan_home / name) for name in FAN_AUTHORITY_STATE_FILENAMES),
            # Root .env remains sensitive when FAN_HOME is customized.
            str(fan_root / ".env"),
            *(str(fan_root / name) for name in FAN_AUTHORITY_STATE_FILENAMES),
            # Retired credential stores remain denied so an old installation
            # cannot expose tokens through agent file tools.
            str(fan_home / ".anthropic_oauth.json"),
            str(fan_root / ".anthropic_oauth.json"),
            os.path.join(home, ".bashrc"),
            os.path.join(home, ".zshrc"),
            os.path.join(home, ".profile"),
            os.path.join(home, ".bash_profile"),
            os.path.join(home, ".zprofile"),
            os.path.join(home, ".netrc"),
            os.path.join(home, ".pgpass"),
            os.path.join(home, ".npmrc"),
            os.path.join(home, ".pypirc"),
            os.path.join(home, ".git-credentials"),
            "/etc/sudoers",
            "/etc/passwd",
            "/etc/shadow",
        ]
    }


def build_write_denied_prefixes(home: str) -> list[str]:
    """Return sensitive directory prefixes that must never be written."""
    return [
        os.path.realpath(p) + os.sep
        for p in [
            os.path.join(home, ".ssh"),
            os.path.join(home, ".aws"),
            os.path.join(home, ".gnupg"),
            os.path.join(home, ".kube"),
            "/etc/sudoers.d",
            "/etc/systemd",
            os.path.join(home, ".docker"),
            os.path.join(home, ".azure"),
            os.path.join(home, ".config", "gh"),
            os.path.join(home, ".config", "gcloud"),
        ]
    ]


def get_safe_write_roots() -> set[str]:
    """Return resolved roots from ``FAN_WRITE_SAFE_ROOT``.

    Multiple roots use the platform path separator (``:`` on POSIX, ``;`` on
    Windows), so a single policy can safely cover more than one workspace.
    """
    configured = os.getenv("FAN_WRITE_SAFE_ROOT", "")
    if not configured:
        return set()
    roots: set[str] = set()
    for path in configured.split(os.pathsep):
        if not path:
            continue
        try:
            roots.add(os.path.realpath(os.path.expanduser(path)))
        except (OSError, ValueError):
            continue
    return roots


def is_write_denied(path: str) -> bool:
    """Return True if path is blocked by the write denylist or safe root."""
    home = os.path.realpath(os.path.expanduser("~"))
    resolved = os.path.realpath(os.path.expanduser(str(path)))

    if resolved in build_write_denied_paths(home):
        return True
    for prefix in build_write_denied_prefixes(home):
        if resolved.startswith(prefix):
            return True

    # Fan control-plane files: block both the FAN_HOME view and the root view.
    # This protects credentials/config even when FAN_HOME is customized.
    control_file_names = FAN_AUTHORITY_STATE_FILENAMES
    mcp_tokens_dir_name = "mcp-tokens"

    fan_dirs = []
    for base in (_fan_home_path(), _fan_root_path()):
        try:
            real = os.path.realpath(base)
            if real not in fan_dirs:
                fan_dirs.append(real)
        except Exception:
            continue

    for base_real in fan_dirs:
        for name in control_file_names:
            try:
                if resolved == os.path.realpath(os.path.join(base_real, name)):
                    return True
            except Exception:
                continue
        try:
            mcp_real = os.path.realpath(os.path.join(base_real, mcp_tokens_dir_name))
            if resolved == mcp_real or resolved.startswith(mcp_real + os.sep):
                return True
        except Exception:
            pass
        try:
            pairing_real = os.path.realpath(os.path.join(base_real, "pairing"))
            if resolved == pairing_real or resolved.startswith(pairing_real + os.sep):
                return True
        except Exception:
            pass

    safe_roots = get_safe_write_roots()
    if safe_roots and not any(
        resolved == safe_root or resolved.startswith(safe_root + os.sep)
        for safe_root in safe_roots
    ):
        return True

    return False


# ---------------------------------------------------------------------------
# Agent-owned subprocess write sandbox
# ---------------------------------------------------------------------------
# Static command inspection is useful for a clear model-facing refusal, but it
# cannot be a filesystem security boundary: ``python -c``, a generated script,
# or a hard link can perform the same write without exposing a shell target.
# Fan currently ships the desktop client for macOS, whose Seatbelt sandbox can
# impose a kernel-enforced deny on the entire Agent subprocess tree.  Every
# Agent-owned terminal / execute_code launch goes through the helpers below.

_MACOS_SANDBOX_EXEC = "/usr/bin/sandbox-exec"


def _trusted_macos_sandbox_exec() -> Optional[str]:
    """Return the immutable system Seatbelt launcher when trustworthy.

    Never resolve this executable through ``PATH``. Agent subprocesses may
    write ordinary user-owned bin directories (Homebrew, ``~/.local/bin`` and
    project toolchains); a PATH lookup would let one command plant a fake
    launcher and make the next command run without a sandbox.
    """
    if platform.system() != "Darwin":
        return None
    try:
        info = os.stat(_MACOS_SANDBOX_EXEC, follow_symlinks=False)
    except OSError:
        return None
    if not stat.S_ISREG(info.st_mode):
        return None
    if info.st_uid != 0 or info.st_mode & (stat.S_IWGRP | stat.S_IWOTH):
        return None
    if not os.access(_MACOS_SANDBOX_EXEC, os.X_OK):
        return None
    return _MACOS_SANDBOX_EXEC


def _relocatable_path_entries(path: str) -> set[str]:
    """Return writable path entries that could relocate a protected root.

    Seatbelt literal rules follow pathnames. Protecting only ``FAN_HOME`` is
    insufficient for a custom location under a user-writable parent: moving
    that parent gives every authority file a new, unprotected pathname.

    Climb only while the current entry's parent is writable/searchable. Once
    the parent cannot be mutated, it is a stable anchor and broader ancestor
    rules would only risk surprising ordinary workspace operations. Literal
    ``file-write-unlink`` rules do not prevent normal writes inside a directory.
    """
    entries: set[str] = set()
    current = os.path.realpath(path)
    while current and current != os.path.dirname(current):
        parent = os.path.dirname(current)
        if not os.access(parent, os.W_OK | os.X_OK):
            break
        entries.add(current)
        current = parent
    return entries


def _sandbox_scheme_string(value: str) -> str:
    """Quote a path as one Scheme string in a sandbox-exec profile."""
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'


def build_agent_write_sandbox_profile() -> Optional[str]:
    """Build the macOS profile that protects Fan authority state from Agents.

    ``None`` means this is not macOS or the trusted system Seatbelt launcher is
    unavailable. The subprocess wrapper fails closed for the latter case.

    Authority files and credential directories come from the same centralized
    builders used by file tools.  The Fan root itself remains writable because
    subprocess HOME isolation intentionally lives under ``{FAN_HOME}/home``;
    denying the whole tree would break npm/git/cache and ordinary automation.
    Narrow ``file-write-unlink`` denials on relocatable path entries prevent a
    custom root (or writable ancestor) moving out from under literal rules.
    """
    if platform.system() != "Darwin":
        return None
    if _trusted_macos_sandbox_exec() is None:
        return None

    home = os.path.realpath(os.path.expanduser("~"))
    exact_paths = set(build_write_denied_paths(home))
    denied_subpaths = {
        prefix.removesuffix(os.sep)
        for prefix in build_write_denied_prefixes(home)
    }
    fan_roots: set[str] = set()

    # Prefix-only Fan credential stores are part of is_write_denied(), but not
    # build_write_denied_prefixes() because that builder predates custom
    # FAN_HOME. Include them explicitly while leaving ordinary Fan caches and
    # the isolated subprocess home writable.
    for base in (_fan_home_path(), _fan_root_path()):
        try:
            base_real = os.path.realpath(base)
        except (OSError, ValueError):
            continue
        fan_roots.add(base_real)
        denied_subpaths.add(os.path.join(base_real, "mcp-tokens"))
        denied_subpaths.add(os.path.join(base_real, "pairing"))

    clauses = ["(version 1)", "(allow default)"]
    for path in sorted(exact_paths):
        clauses.append(
            f"(deny file-write* (literal {_sandbox_scheme_string(path)}))"
        )
    for path in sorted(denied_subpaths):
        clauses.append(
            f"(deny file-write* (subpath {_sandbox_scheme_string(path)}))"
        )
    protected_unlink_entries: set[str] = set()
    for path in fan_roots:
        protected_unlink_entries.update(_relocatable_path_entries(path))
    for path in sorted(protected_unlink_entries):
        clauses.append(
            f"(deny file-write-unlink (literal {_sandbox_scheme_string(path)}))"
        )
    return "\n".join(clauses)


def wrap_agent_subprocess_argv(argv: Sequence[str]) -> list[str]:
    """Wrap an Agent-owned process in the host write sandbox when available.

    Seatbelt restrictions are inherited by descendants, so this covers direct
    interpreters, temporary scripts, and any process they launch.  Calling
    ``sandbox-exec`` again inside the child cannot loosen the inherited policy.
    """
    args = [str(arg) for arg in argv]
    if platform.system() == "Darwin":
        sandbox_exec = _trusted_macos_sandbox_exec()
        if sandbox_exec is None:
            raise RuntimeError(
                "Agent subprocess blocked: trusted macOS sandbox launcher "
                f"is unavailable at {_MACOS_SANDBOX_EXEC}"
            )
    else:
        sandbox_exec = None
    profile = build_agent_write_sandbox_profile()
    if profile is None:
        return args
    assert sandbox_exec is not None
    return [sandbox_exec, "-p", profile, *args]


_SAFE_PROJECT_ENV_SUFFIXES: set[str] = {"dist", "example", "sample", "template"}
_SENSITIVE_READ_EXTENSIONS: set[str] = {".kdbx", ".p12", ".pem", ".pfx"}
_SSH_PRIVATE_KEY_BASENAME = re.compile(
    r"^id_(?:rsa|dsa|ecdsa|ed25519)(?:\..+)?$",
    re.IGNORECASE,
)


def _generic_sensitive_read_reason(path: Path) -> Optional[str]:
    """Mirror the desktop's generic local credential-file boundary."""

    normalized = path.as_posix().lower()
    basename = path.name.lower()
    suffix = path.suffix.lower()

    if "/.ssh/" in normalized:
        return "SSH key/config files are protected"
    if "/.gnupg/" in normalized:
        return "GPG key material is protected"
    if normalized.endswith("/.aws/credentials"):
        return "AWS credentials are protected"
    if basename in {".env", ".envrc"}:
        return "environment secrets are protected"
    if basename.startswith(".env."):
        env_suffix = basename[len(".env.") :]
        if env_suffix not in _SAFE_PROJECT_ENV_SUFFIXES:
            return "environment secrets are protected"
    if _SSH_PRIVATE_KEY_BASENAME.fullmatch(basename) and not basename.endswith(".pub"):
        return "SSH private keys are protected"
    if suffix in _SENSITIVE_READ_EXTENSIONS:
        return "private key or credential containers are protected"
    if basename in {".npmrc", ".netrc", ".pypirc"}:
        return f"{basename} may contain authentication credentials"
    return None


def get_read_block_error(path: str) -> Optional[str]:
    """Return an error message when a read targets denied local state.

    The blocked categories include:

      * Credential / secret stores under FAN_HOME and the global Fan
        root: ``auth.json``, ``auth.lock``, retired provider credential stores,
        ``.env``, ``auth/google_oauth.json``,
        and anything under ``mcp-tokens/``. These hold plaintext provider keys,
        OAuth tokens, and HMAC secrets that the agent never needs to read
        directly — provider tools / gateway adapters consume them through
        internal channels.
      * Common local credential files anywhere on disk: SSH/GPG key material,
        AWS credentials, private-key containers, package-manager auth files,
        and secret-bearing ``.env*`` files. Safe documentation variants such
        as ``.env.example`` remain readable.

    **This is NOT a security boundary.** The terminal tool runs as the
    same OS user with shell access; the agent can still ``cat auth.json``
    or ``cat ~/.fan/.env`` and exfiltrate the file. The read-deny exists
    as defense-in-depth that:

      * Returns a clear error to models that respect tool denials, which
        empirically prompts most modern models to stop rather than reach
        for the shell.
      * Surfaces a visible audit trail when something tries to read
        credentials — easier to spot in logs than a generic ``cat``.

    Treat any user-visible framing around this as "may help" rather than
    "stops attackers." A determined model or malicious instruction can
    always shell out.

    Callers that resolve relative paths against a non-process cwd
    (e.g. ``TERMINAL_CWD`` in ``tools/file_tools.py``) MUST pre-resolve
    and pass the absolute path string.  This function's own ``resolve()``
    is anchored at the Python process cwd, so a relative input like
    ``"auth.json"`` would otherwise miss the denylist when the task's
    terminal cwd differs from the process cwd.
    """
    resolved = Path(path).expanduser().resolve()

    # Resolve BOTH FAN_HOME and the global Fan root so credential stores at
    # <root>/auth.json etc. are also blocked when FAN_HOME is customized.
    # Same shape as the write deny widening (#15981, #14157).
    fan_dirs: list[Path] = []
    for base in (_fan_home_path(), _fan_root_path()):
        try:
            real = base.resolve()
            if real not in fan_dirs:
                fan_dirs.append(real)
        except Exception:
            continue

    # Credential / secret stores. Exact-file matches under either
    # FAN_HOME or <root>.
    credential_file_names = (
        *FAN_AUTHORITY_STATE_FILENAMES,
        "auth.lock",
        ".anthropic_oauth.json",
        ".env",
        os.path.join("auth", "google_oauth.json"),
        # Bitwarden Secrets Manager disk cache: stores plaintext secret values
        # to avoid re-fetching across back-to-back CLI invocations. The file
        # was introduced by #31968 but not added to this guard.
        os.path.join("cache", "bws_cache.json"),
    )
    for hd in fan_dirs:
        for name in credential_file_names:
            try:
                blocked = (hd / name).resolve()
            except Exception:
                continue
            if resolved == blocked:
                return (
                    f"Access denied: {path} is a Fan credential store "
                    "and cannot be read directly. Provider tools consume "
                    "these credentials through internal channels. "
                    "(Defense-in-depth — not a security boundary; the "
                    "terminal tool can still bypass.)"
                )

    # mcp-tokens/: directory prefix match — anything inside is OAuth
    # token material.
    for hd in fan_dirs:
        try:
            mcp_tokens = (hd / "mcp-tokens").resolve()
        except Exception:
            continue
        if resolved == mcp_tokens:
            return (
                f"Access denied: {path} is the Fan MCP token directory "
                "and cannot be read directly. (Defense-in-depth — not a "
                "security boundary; the terminal tool can still bypass.)"
            )
        try:
            resolved.relative_to(mcp_tokens)
        except ValueError:
            continue
        return (
            f"Access denied: {path} is a Fan MCP token file "
            "and cannot be read directly. (Defense-in-depth — not a "
            "security boundary; the terminal tool can still bypass.)"
        )

    # pairing/: local device-pairing material and short-lived authorization
    # state. Treat the directory exactly like mcp-tokens so file://, file
    # tools, and any browser snapshot path cannot expose it.
    for hd in fan_dirs:
        try:
            pairing = (hd / "pairing").resolve()
        except Exception:
            continue
        if resolved == pairing:
            return (
                f"Access denied: {path} is the Fan pairing directory "
                "and cannot be read directly. (Defense-in-depth — not a "
                "security boundary; the terminal tool can still bypass.)"
            )
        try:
            resolved.relative_to(pairing)
        except ValueError:
            continue
        return (
            f"Access denied: {path} is a Fan pairing state file "
            "and cannot be read directly. (Defense-in-depth — not a "
            "security boundary; the terminal tool can still bypass.)"
        )

    # Block common secret-bearing project-local files anywhere on disk. Keep
    # this aligned with desktop/electron/hardening.cjs because file:// pages can
    # otherwise place them in a model-visible top-level page or subframe.
    generic_reason = _generic_sensitive_read_reason(resolved)
    if generic_reason:
        return (
            f"Access denied: {path} is a sensitive local file ({generic_reason}) "
            "and cannot be exposed to browser or file automation."
        )

    return None


def raise_if_read_blocked(path: str) -> None:
    """Raise ``PermissionError`` when local content must not reach a model.

    Binary/media tools need an exception-based guard because their normal
    success path continues by reading and encoding the file.  Keep the policy
    itself centralized in ``get_read_block_error`` so text, browser, and vision
    reads cannot drift onto different credential deny lists.
    """
    block_error = get_read_block_error(path)
    if block_error:
        raise PermissionError(block_error)


# ---------------------------------------------------------------------------
# Sandbox-mirror write guard (#32049)
#
# Non-local terminal backends (Docker, Daytona, etc.) bind a sandbox-local
# directory to the container's ``$HOME``. The on-disk layout looks like
#
#   <FAN_HOME>/sandboxes/<backend>/<task>/home/.fan/...
#
# When the agent (running host-side) speculates that authoritative Fan state
# lives at one of those sandbox-mirror paths, the write lands on the
# mirror — never read by the host process — while the host file is left
# untouched. The agent reports success, the user sees no change, and on
# disk two divergent copies accumulate. See #32049 for evidence.
#
# This guard is path-shape-only: it detects the
# ``…/sandboxes/<backend>/<task>/home/.fan/…`` segment and warns
# regardless of the active Fan home. It does NOT cover the
# inner-container case where the bind mount strips the ``sandboxes/`` prefix
# (the agent's view inside the container is plain ``/root/.fan/...``);
# that case needs a separate dispatch-layer or host-side state tool.
# ---------------------------------------------------------------------------


def _find_sandbox_mirror_segments(parts: tuple) -> Optional[int]:
    """Return the index of the inner ``.fan`` part in a sandbox-mirror path.

    Matches ``…/sandboxes/<backend>/<task>/home/.fan/…`` and returns the
    index where the inner Fan-state portion starts. Returns ``None`` for
    paths that do not contain the sandbox-mirror shape.
    """
    for i, part in enumerate(parts):
        if part != "sandboxes":
            continue
        # Need at least: sandboxes / <backend> / <task> / home / .fan / <thing>
        if i + 5 >= len(parts):
            continue
        if parts[i + 3] == "home" and parts[i + 4] == ".fan":
            return i + 4
    return None


def classify_sandbox_mirror_target(path: str) -> Optional[dict]:
    """Classify a write target as a sandbox-mirror of authoritative Fan state.

    Returns ``None`` when the path does not match the sandbox-mirror shape.
    Otherwise returns a dict with:

      * ``target_path``: the resolved path string
      * ``mirror_root``: the ``…/sandboxes/<backend>/<task>/home/.fan``
        prefix (so callers can show users which sandbox owns the mirror)
      * ``inner_path``: the portion under the mirror's ``.fan`` (what the
        agent likely meant to address on the host)

    Detection is path-shape-only — does not require any Fan resolver to
    succeed, so it works correctly even when called from contexts where
    FAN_HOME resolution would be ambiguous.
    """
    try:
        target = Path(os.path.expanduser(str(path))).resolve()
    except (OSError, RuntimeError):
        return None

    parts = target.parts
    inner_idx = _find_sandbox_mirror_segments(parts)
    if inner_idx is None:
        return None

    mirror_root = str(Path(*parts[: inner_idx + 1]))
    inner_path = str(Path(*parts[inner_idx + 1 :])) if inner_idx + 1 < len(parts) else ""

    return {
        "target_path": str(target),
        "mirror_root": mirror_root,
        "inner_path": inner_path,
    }


def get_sandbox_mirror_warning(path: str) -> Optional[str]:
    """Return a model-facing warning when ``path`` lands in a sandbox mirror.

    Returns ``None`` when the path is not a sandbox-mirror target. Caller
    is expected to surface the warning to the agent as a tool-result
    error.

    Defense-in-depth, NOT a security boundary: the terminal tool runs as
    the same OS user and can write the mirror path directly. The guard
    exists to surface the misclassification before the silent-success +
    divergent-copy footgun in #32049 fires.
    """
    info = classify_sandbox_mirror_target(path)
    if info is None:
        return None
    return (
        f"Sandbox-mirror write blocked by soft guard: {info['target_path']} "
        f"sits under {info['mirror_root']!r}, which is a per-task mirror "
        f"created by a non-local terminal backend (docker/daytona/etc.). "
        f"Writes here land on a copy that the host Fan process never "
        f"reads — the authoritative file is likely {info['inner_path']!r} "
        f"under the real FAN_HOME. Use the host-side tool for "
        f"authoritative state (e.g. ``memory`` for memories), or address "
        f"the host path directly. "
        f"(Defense-in-depth — not a security boundary; the terminal tool "
        f"can still bypass.)"
    )


# ---------------------------------------------------------------------------
# Container-context mirror guard (inner-container case — #32049 follow-up)
#
# Brian's shape-based detector (#32213) catches paths that still carry the
# full ``…/sandboxes/<backend>/<task>/home/.fan/…`` prefix on the host.
# But when file tools execute *inside* the container the bind-mount strips
# that prefix: the agent sees plain ``/root/.fan/…``.  The root:root
# ownership on the divergent SOUL.md in #32049 confirms this is the primary
# failure mode.
#
# Fix: file_tools passes the active container mirror prefix when one exists.
# With the remote/container backends removed the prefix is always ``None``
# and this guard is a natural no-op — kept for the host-side shape detector.
# ---------------------------------------------------------------------------


def classify_container_mirror_target(
    path: str,
    mirror_prefix: str | None = None,
) -> Optional[dict]:
    """Classify a write target as a container-side sandbox mirror.

    ``mirror_prefix`` must be supplied by the caller after it has established
    that file tools are executing in a container whose home is a sandbox
    mirror. Returns ``None`` when no such context is active or the path is not
    under the mirror prefix. Otherwise returns:

      * ``target_path``: resolved path string
      * ``mirror_root``: the declared container mirror prefix
      * ``inner_path``: portion under the mirror root (what the agent
        likely meant to address in the host FAN_HOME)
    """
    if not mirror_prefix:
        return None
    try:
        target = Path(os.path.expanduser(str(path))).resolve()
        mirror = Path(os.path.expanduser(mirror_prefix)).resolve()
        inner = target.relative_to(mirror)
    except (OSError, RuntimeError, ValueError):
        return None
    return {
        "target_path": str(target),
        "mirror_root": str(mirror),
        "inner_path": inner.as_posix(),
    }


def get_container_mirror_warning(
    path: str,
    mirror_prefix: str | None = None,
) -> Optional[str]:
    """Return a model-facing warning when *path* lands in the container's
    sandbox mirror of authoritative Fan state.

    The caller supplies ``mirror_prefix`` only when the current file-tool
    backend is known to execute inside a Docker sandbox. Soft guard: returns
    ``None`` for non-mirror paths; caller surfaces warnings as tool-result
    errors.
    """
    info = classify_container_mirror_target(path, mirror_prefix)
    if info is None:
        return None
    return (
        f"Sandbox-mirror write blocked by soft guard: {info['target_path']} "
        f"sits under {info['mirror_root']!r}, which is the container's "
        f"bind-mounted home — a per-task mirror that the host Fan "
        f"process never reads. The authoritative file is "
        f"{info['inner_path']!r} under the real FAN_HOME. Use the "
        f"host-side tool for authoritative state (e.g. ``memory`` for "
        f"memories), or address the host path directly. "
        f"(Defense-in-depth — not a security boundary; the terminal tool "
        f"can still bypass.)"
    )
