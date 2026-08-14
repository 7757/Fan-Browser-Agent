#!/usr/bin/env python3
"""
Terminal Tool Module

A terminal tool that executes commands on the local host. Remote/container
backends (Docker, Modal, SSH, Singularity, Daytona) were removed — the
desktop agent runs everything locally.

Features:
- Local execution with per-task working directories
- Background task support
- Automatic cleanup after inactivity

Usage:
    from terminal_tool import terminal_tool

    # Execute a simple command
    result = terminal_tool("ls -la")

    # Execute in background
    result = terminal_tool("python server.py", background=True)
"""

import importlib.util
import json
import logging
import os
import platform
import re
import time
import threading
import atexit
import shutil
import subprocess
from pathlib import Path
from typing import Optional, Dict, Any, List

from utils import env_var_enabled

logger = logging.getLogger(__name__)


_EXTERNAL_BROWSER_URL_LAUNCH_RE = re.compile(
    r"""(?ix)
    (?:^|[;&|]\s*)
    (?:
        open(?:\s+-[a-z]\s+(?:"[^"]*"|'[^']*'|\S+))*
        | xdg-open
        | gio\s+open
        | start(?:\s+""\s+)?
        | start-process
        | python(?:3)?\s+-m\s+webbrowser
    )
    \b[^;&|\n]*https?://
    """
)


def _requests_external_browser_launch(command: str) -> bool:
    """Block OS browser launchers while the shared Electron browser is active."""
    return (
        os.getenv("FAN_BROWSER_RUNTIME", "").strip().lower() == "electron"
        and bool(_EXTERNAL_BROWSER_URL_LAUNCH_RE.search(command))
    )


# ---------------------------------------------------------------------------
# Global interrupt event: set by the agent when a user interrupt arrives.
# The terminal tool polls this during command execution so it can kill
# long-running subprocesses immediately instead of blocking until timeout.
# ---------------------------------------------------------------------------
from tools.interrupt import is_interrupted, _interrupt_event  # noqa: F401 — re-exported
# display_fan_home imported lazily at call site (stale-module safety during fan update)




def _get_scratch_dir() -> Path:
    """Scratch dir for disk-usage checks and orphan cleanup.

    Was a singularity helper; inlined here when the remote/container
    backends were removed. Honors TERMINAL_SCRATCH_DIR, else lives under
    the sandbox dir.
    """
    custom_scratch = os.getenv("TERMINAL_SCRATCH_DIR")
    if custom_scratch:
        scratch_path = Path(custom_scratch)
        scratch_path.mkdir(parents=True, exist_ok=True)
        return scratch_path
    from tools.environments.base import get_sandbox_dir

    sandbox = get_sandbox_dir() / "scratch"
    sandbox.mkdir(parents=True, exist_ok=True)
    return sandbox


def _safe_parse_import_env(
    name: str,
    default: Any,
    converter,
    type_label: str,
):
    """Parse module-level numeric env vars without breaking import.

    Terminal tool is imported by CLI, ACP, tests, and tool discovery. A single
    malformed env var must not make the whole module unloadable at import time.
    """
    raw = os.getenv(name)
    if raw is None or raw == "":
        return default
    try:
        return converter(raw)
    except (TypeError, ValueError):
        logger.warning(
            "Invalid value for %s: %r (expected %s). Falling back to %r.",
            name,
            raw,
            type_label,
            default,
        )
        return default


# Hard cap on foreground timeout; override via TERMINAL_MAX_FOREGROUND_TIMEOUT env var.
FOREGROUND_MAX_TIMEOUT = _safe_parse_import_env(
    "TERMINAL_MAX_FOREGROUND_TIMEOUT",
    600,
    int,
    "integer",
)



# Interactive sudo password cache.
#
# Scope the cache to the active session when a session key is available, then
# fall back to callback identity (ACP / CLI interactive callbacks), then the
# current thread. This prevents one interactive session from reusing another
# session's cached sudo password inside the same long-lived process.
_sudo_password_cache: dict[str, str] = {}
_sudo_password_cache_lock = threading.Lock()

# Optional UI callbacks for interactive prompts. When set, these are called
# instead of the default /dev/tty or input() readers. The CLI registers these
# so prompts route through prompt_toolkit's event loop.
# Callback slots used by the approval prompt and sudo password prompt
# routines. Stored in thread-local state so overlapping ACP sessions —
# each running in its own ThreadPoolExecutor thread — don't stomp on
# each other's callbacks. See GHSA-qg5c-hvr5-hjgr.
#
# CLI mode is single-threaded, so each thread (the only one) holds its
# own callback exactly like before. Gateway mode resolves approvals via
# the per-session queue in tools.approval, not through these callbacks,
# so it's unaffected.
_callback_tls = threading.local()


def _get_sudo_password_callback():
    return getattr(_callback_tls, "sudo_password", None)


def _get_approval_callback():
    return getattr(_callback_tls, "approval", None)


def set_sudo_password_callback(cb):
    """Register a callback for sudo password prompts (used by CLI).

    Per-thread scope — ACP sessions that run concurrently in a
    ThreadPoolExecutor each have their own callback slot.
    """
    _callback_tls.sudo_password = cb


def set_approval_callback(cb):
    """Register a callback for dangerous command approval prompts.

    Per-thread scope — ACP sessions that run concurrently in a
    ThreadPoolExecutor each have their own callback slot. See
    GHSA-qg5c-hvr5-hjgr.
    """
    _callback_tls.approval = cb


def _get_sudo_password_cache_scope() -> str:
    """Return the cache scope for interactive sudo passwords."""
    session_key = os.environ.get("FAN_SESSION_KEY", "")
    if session_key:
        return f"session:{session_key}"

    callback = _get_sudo_password_callback()
    if callback is not None:
        owner = getattr(callback, "__self__", None)
        func = getattr(callback, "__func__", None)
        if owner is not None and func is not None:
            return f"callback-owner:{id(owner)}:{id(func)}"
        return f"callback:{id(callback)}"

    return f"thread:{threading.get_ident()}"


def _get_cached_sudo_password() -> str:
    """Return the cached sudo password for the current scope."""
    scope = _get_sudo_password_cache_scope()
    with _sudo_password_cache_lock:
        return _sudo_password_cache.get(scope, "")


def _set_cached_sudo_password(password: str) -> None:
    """Persist a sudo password for the current scope."""
    scope = _get_sudo_password_cache_scope()
    with _sudo_password_cache_lock:
        if password:
            _sudo_password_cache[scope] = password
        else:
            _sudo_password_cache.pop(scope, None)



# Dangerous command detection + approval now consolidated in tools/approval.py
from tools.approval import (
    check_all_command_guards as _check_all_guards_impl,
)


def _check_all_guards(command: str, env_type: str) -> dict:
    """Delegate to consolidated guard (tirith + dangerous cmd) with CLI callback."""
    return _check_all_guards_impl(command, env_type,
                                  approval_callback=_get_approval_callback())


# Allowlist: characters that can legitimately appear in directory paths.
# Covers alphanumeric, path separators, Windows drive/UNC separators, tilde,
# dot, hyphen, underscore, space, plus, at, equals, and comma.  Everything
# else is rejected.
_WORKDIR_SAFE_RE = re.compile(r'^[A-Za-z0-9/\\:_\-.~ +@=,]+$')


def _validate_workdir(workdir: str) -> str | None:
    """Reject workdir values that don't look like a filesystem path.

    Uses an allowlist of safe characters rather than a deny-list, so novel
    shell metacharacters can't slip through.

    Returns None if safe, or an error message string if dangerous.
    """
    if not workdir:
        return None
    if not _WORKDIR_SAFE_RE.match(workdir):
        # Find the first offending character for a helpful message.
        for ch in workdir:
            if not _WORKDIR_SAFE_RE.match(ch):
                return (
                    f"Blocked: workdir contains disallowed character {repr(ch)}. "
                    "Use a simple filesystem path without shell metacharacters."
                )
        return "Blocked: workdir contains disallowed characters."
    return None


_SUDO_WRONG_PASSWORD_MARKERS = (
    "sudo: authentication failed",
    "sudo: incorrect password attempt",
    "sudo: maximum 3 incorrect authentication attempts",
    "sudo: 3 incorrect password attempts",
)


def _sudo_wrong_password_failure(output: str) -> bool:
    """Return whether sudo rejected a password read from stdin."""
    if not output:
        return False
    lowered = output.lower()
    return any(marker in lowered for marker in _SUDO_WRONG_PASSWORD_MARKERS)


def _invalidate_cached_sudo_on_auth_failure(
    command: str | None,
    output: str,
) -> bool:
    """Discard a session-cached password after sudo rejects it.

    An explicit ``SUDO_PASSWORD`` environment value remains operator-managed;
    only the interactive session cache is cleared.
    """
    if "SUDO_PASSWORD" in os.environ:
        return False
    if not _sudo_wrong_password_failure(output):
        return False
    if _count_real_sudo_invocations(command or "") == 0:
        return False
    if not _get_cached_sudo_password():
        return False
    _set_cached_sudo_password("")
    return True


def _prompt_for_sudo_password(timeout_seconds: int = 45) -> str:
    """
    Prompt user for sudo password with timeout.
    
    Returns the password if entered, or empty string if:
    - User presses Enter without input (skip)
    - Timeout expires (45s default)
    - Any error occurs
    
    Only works in interactive mode (FAN_INTERACTIVE=1).
    If a _sudo_password_callback is registered (by the CLI), delegates to it
    so the prompt integrates with prompt_toolkit's UI.  Otherwise reads
    directly from /dev/tty with echo disabled.
    """
    import sys
    
    # Use the registered callback when available (prompt_toolkit-compatible)
    _sudo_cb = _get_sudo_password_callback()
    if _sudo_cb is not None:
        try:
            return _sudo_cb() or ""
        except Exception:
            return ""

    result = {"password": None, "done": False}
    
    def read_password_thread():
        """Read password with echo disabled. Uses msvcrt on Windows, /dev/tty on Unix."""
        tty_fd = None
        old_attrs = None
        try:
            if platform.system() == "Windows":
                import msvcrt
                chars = []
                while True:
                    c = msvcrt.getwch()
                    if c in {"\r", "\n"}:
                        break
                    if c == "\x03":
                        raise KeyboardInterrupt
                    chars.append(c)
                result["password"] = "".join(chars)
            else:
                import termios
                tty_fd = os.open("/dev/tty", os.O_RDONLY)
                old_attrs = termios.tcgetattr(tty_fd)
                new_attrs = termios.tcgetattr(tty_fd)
                new_attrs[3] = new_attrs[3] & ~termios.ECHO
                termios.tcsetattr(tty_fd, termios.TCSAFLUSH, new_attrs)
                chars = []
                while True:
                    b = os.read(tty_fd, 1)
                    if not b or b in {b"\n", b"\r"}:
                        break
                    chars.append(b)
                result["password"] = b"".join(chars).decode("utf-8", errors="replace")
        except (EOFError, KeyboardInterrupt, OSError):
            result["password"] = ""
        except Exception:
            result["password"] = ""
        finally:
            if tty_fd is not None and old_attrs is not None:
                try:
                    import termios as _termios
                    _termios.tcsetattr(tty_fd, _termios.TCSAFLUSH, old_attrs)
                except Exception as e:
                    logger.debug("Failed to restore terminal attributes: %s", e)
            if tty_fd is not None:
                try:
                    os.close(tty_fd)
                except Exception as e:
                    logger.debug("Failed to close tty fd: %s", e)
            result["done"] = True
    
    try:
        os.environ["FAN_SPINNER_PAUSE"] = "1"
        time.sleep(0.2)
        
        print()
        print("┌" + "─" * 58 + "┐")
        print("│  🔐 SUDO PASSWORD REQUIRED" + " " * 30 + "│")
        print("├" + "─" * 58 + "┤")
        print("│  Enter password below (input is hidden), or:            │")
        print("│    • Press Enter to skip (command fails gracefully)     │")
        print(f"│    • Wait {timeout_seconds}s to auto-skip" + " " * 27 + "│")
        print("└" + "─" * 58 + "┘")
        print()
        print("  Password (hidden): ", end="", flush=True)
        
        password_thread = threading.Thread(target=read_password_thread, daemon=True)
        password_thread.start()
        password_thread.join(timeout=timeout_seconds)
        
        if result["done"]:
            password = result["password"] or ""
            print()  # newline after hidden input
            if password:
                print("  ✓ Password received (cached for this session)")
            else:
                print("  ⏭ Skipped - continuing without sudo")
            print()
            sys.stdout.flush()
            return password
        else:
            print("\n  ⏱ Timeout - continuing without sudo")
            print("    (Press Enter to dismiss)")
            print()
            sys.stdout.flush()
            return ""
            
    except (EOFError, KeyboardInterrupt):
        print()
        print("  ⏭ Cancelled - continuing without sudo")
        print()
        sys.stdout.flush()
        return ""
    except Exception as e:
        print(f"\n  [sudo prompt error: {e}] - continuing without sudo\n")
        sys.stdout.flush()
        return ""
    finally:
        if "FAN_SPINNER_PAUSE" in os.environ:
            del os.environ["FAN_SPINNER_PAUSE"]

def _safe_command_preview(command: Any, limit: int = 200) -> str:
    """Return a log-safe preview for possibly-invalid command values."""
    if command is None:
        return "<None>"
    if isinstance(command, str):
        return command[:limit]
    try:
        return repr(command)[:limit]
    except Exception:
        return f"<{type(command).__name__}>"

def _looks_like_env_assignment(token: str) -> bool:
    """Return True when *token* is a leading shell environment assignment."""
    if "=" not in token or token.startswith("="):
        return False
    name, _value = token.split("=", 1)
    return bool(re.match(r"^[A-Za-z_][A-Za-z0-9_]*$", name))


def _read_shell_token(command: str, start: int) -> tuple[str, int]:
    """Read one shell token, preserving quotes/escapes, starting at *start*."""
    i = start
    n = len(command)

    while i < n:
        ch = command[i]
        if ch.isspace() or ch in ";|&()":
            break
        if ch == "'":
            i += 1
            while i < n and command[i] != "'":
                i += 1
            if i < n:
                i += 1
            continue
        if ch == '"':
            i += 1
            while i < n:
                inner = command[i]
                if inner == "\\" and i + 1 < n:
                    i += 2
                    continue
                if inner == '"':
                    i += 1
                    break
                i += 1
            continue
        if ch == "\\" and i + 1 < n:
            i += 2
            continue
        i += 1

    return command[start:i], i


def _rewrite_real_sudo_invocations(command: str) -> tuple[str, int]:
    """Rewrite real sudo command words and return their count."""
    out: list[str] = []
    i = 0
    n = len(command)
    command_start = True
    sudo_count = 0

    while i < n:
        ch = command[i]

        if ch.isspace():
            out.append(ch)
            if ch == "\n":
                command_start = True
            i += 1
            continue

        if ch == "#" and command_start:
            comment_end = command.find("\n", i)
            if comment_end == -1:
                out.append(command[i:])
                break
            out.append(command[i:comment_end])
            i = comment_end
            continue

        if command.startswith("&&", i) or command.startswith("||", i) or command.startswith(";;", i):
            out.append(command[i:i + 2])
            i += 2
            command_start = True
            continue

        if ch in ";|&(":
            out.append(ch)
            i += 1
            command_start = True
            continue

        if ch == ")":
            out.append(ch)
            i += 1
            command_start = False
            continue

        token, next_i = _read_shell_token(command, i)
        if command_start and token == "sudo":
            out.append("sudo -S -p ''")
            sudo_count += 1
        else:
            out.append(token)

        if command_start and _looks_like_env_assignment(token):
            command_start = True
        else:
            command_start = False
        i = next_i

    return "".join(out), sudo_count


def _count_real_sudo_invocations(command: str) -> int:
    """Return the count of unquoted sudo command words in *command*."""
    _, sudo_count = _rewrite_real_sudo_invocations(command)
    return sudo_count


def _sudo_nopasswd_works() -> bool:
    """Return True when local sudo currently works without prompting.

    Only probes for the `local` terminal backend; Docker/SSH/Modal/etc. must
    not inherit the host's sudo state. Re-probes every call (no process-level
    cache) so an expired sudo timestamp cannot make a later command silently
    block waiting for a password.
    """
    try:
        probe = subprocess.run(
            ["sudo", "-n", "true"],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=3,
            check=False,
        )
        return probe.returncode == 0
    except Exception:
        return False


def _rewrite_compound_background(command: str) -> str:
    """Wrap `A && B &` (or `A || B &`) to `A && { B & }` at depth 0.

    Bash parses ``A && B &`` with `&&` tighter than `&`, so it forks a
    subshell for the whole `A && B` compound and backgrounds it. Inside
    the subshell, `B` runs foreground, so the subshell waits for `B` to
    finish. When `B` is a long-running process (`python3 -m http.server`,
    `yes > /dev/null`, anything that doesn't naturally exit), the subshell
    never exits. It leaks as a process stuck in ``wait4`` forever — and
    on the way, its open stdout pipe can prevent the terminal tool from
    returning promptly.

    Rewriting the tail to `A && { B & }` preserves `&&`'s error semantics
    (skip B if A fails) while replacing the subshell with a brace group.
    The brace group runs in the current shell (no fork), backgrounds B as
    a simple command (bash doesn't wait for it in non-interactive mode),
    and exits immediately. B runs as a normal backgrounded child, orphaned
    when the parent shell exits.

    Handles redirects (``&>``, ``2>&1``) and skips content inside quoted
    strings and parenthesised subshells. Leaves simple ``cmd &`` alone —
    that construct doesn't have the subshell-wait bug.
    """
    n = len(command)
    i = 0
    paren_depth = 0
    brace_depth = 0
    # Position in *command* just after the most recent `&&` / `||` at depth 0
    # in the current statement; -1 when no chain operator is active.
    last_chain_op_end = -1
    rewrites: list[tuple[int, int]] = []  # (chain_op_end, amp_pos)

    while i < n:
        ch = command[i]

        # Newline terminates a statement at depth 0 — reset chain state.
        # Checked before the whitespace skip so we don't miss it.
        if ch == "\n" and paren_depth == 0 and brace_depth == 0:
            last_chain_op_end = -1
            i += 1
            continue

        if ch.isspace():
            i += 1
            continue

        # Comments (only at statement start — conservative: any `#` not inside
        # a token ends the line). `_read_shell_token` handles quoted strings
        # below so `#` inside quotes is safe.
        if ch == "#":
            nl = command.find("\n", i)
            if nl == -1:
                break
            i = nl
            continue

        if ch == "\\" and i + 1 < n:
            i += 2
            continue

        # Quoted tokens — consume whole string via the shared tokenizer.
        if ch in {"'", '"'}:
            _, next_i = _read_shell_token(command, i)
            i = max(next_i, i + 1)
            continue

        if ch == "(":
            paren_depth += 1
            i += 1
            continue

        if ch == ")":
            paren_depth = max(0, paren_depth - 1)
            i += 1
            continue

        # Brace groups: `{ ... }` is a group (no subshell fork), and bash
        # requires whitespace after `{`. We track depth so already-rewritten
        # output (`A && { B & }`) is idempotent — the inner `&` is part of
        # the group, not a new compound to rewrite. Also skip content inside
        # the group since `A && B &` there is separately well-formed.
        if ch == "{" and i + 1 < n and (command[i + 1].isspace() or command[i + 1] == "\n"):
            brace_depth += 1
            i += 1
            continue
        if ch == "}" and brace_depth > 0:
            brace_depth -= 1
            # Closing a group completes a compound statement; reset chain.
            last_chain_op_end = -1
            i += 1
            continue

        # Inside parens or brace groups, skip operators — they parse in their
        # own scope. `(...)` subshells have the same bug class but are not the
        # common agent pattern; leave for a follow-up.
        if paren_depth > 0 or brace_depth > 0:
            i += 1
            continue

        # Chain operators at depth 0
        if command.startswith("&&", i) or command.startswith("||", i):
            last_chain_op_end = i + 2
            i += 2
            continue

        # Statement terminators reset the chain state
        if ch == ";":
            last_chain_op_end = -1
            i += 1
            continue

        # Single `|` (pipe) starts a new pipeline stage; don't rewrite
        # across it. `||` handled above.
        if ch == "|":
            last_chain_op_end = -1
            i += 1
            continue

        # `&` handling: distinguish `&&`, `&>`, fd redirect (`>&`, `<&`),
        # and a true backgrounding `&`.
        if ch == "&":
            # `&&` handled above; won't reach here
            if i + 1 < n and command[i + 1] == ">":
                # `&>` redirect — consume
                i += 2
                continue
            # `>&` / `<&` fd target — look back past whitespace
            j = i - 1
            while j >= 0 and command[j].isspace():
                j -= 1
            if j >= 0 and command[j] in "<>":
                i += 1
                continue
            # Real background operator
            if last_chain_op_end >= 0:
                rewrites.append((last_chain_op_end, i))
            last_chain_op_end = -1
            i += 1
            continue

        # Regular unquoted token — advance past it via the shared tokenizer
        _, next_i = _read_shell_token(command, i)
        i = max(next_i, i + 1)

    if not rewrites:
        return command

    # Apply rewrites back-to-front so earlier indices remain valid.
    result = command
    for chain_end, amp_pos in reversed(rewrites):
        # Skip whitespace right after the `&&`/`||` so the brace group
        # opens flush against the inner command.
        insert_pos = chain_end
        while insert_pos < amp_pos and result[insert_pos].isspace():
            insert_pos += 1
        prefix = result[:insert_pos]
        middle = result[insert_pos:amp_pos]  # inner command + trailing space
        suffix = result[amp_pos + 1 :]
        # `{` needs a trailing space in bash; the closing `}` needs to be
        # preceded by `;` or `&` — we're providing `&` from the backgrounding.
        result = prefix + "{ " + middle + "& }" + suffix

    return result


def _transform_sudo_command(command: str | None) -> tuple[str | None, str | None]:
    """
    Transform sudo commands to use -S flag if SUDO_PASSWORD is available.

    This is a shared helper used by all execution environments to provide
    consistent sudo handling across local, SSH, and container environments.

    Returns:
        (transformed_command, sudo_stdin) where:
        - transformed_command has every bare ``sudo`` replaced with
          ``sudo -S -p ''`` so sudo reads its password from stdin.
        - sudo_stdin is the password string with a trailing newline that the
          caller must prepend to the process's stdin stream.  sudo -S reads
          exactly one line (the password) and passes the rest of stdin to the
          child command, so prepending is safe even when the caller also has
          its own stdin_data to pipe.
        - If no password is available, sudo_stdin is None and the command is
          returned unchanged so it fails gracefully with
          "sudo: a password is required".

    Callers that drive a subprocess directly (local, ssh, docker, singularity)
    should prepend sudo_stdin to their stdin_data and pass the merged bytes to
    Popen's stdin pipe.

    Callers that cannot pipe subprocess stdin (modal, daytona) must embed
    the password in the command string themselves; see their execute()
    methods for how they handle the non-None sudo_stdin case.

    If SUDO_PASSWORD is not set and an interactive UI is available
    (FAN_INTERACTIVE=1 or a registered sudo password callback):
      Prompts user for password with 45s timeout, caches for session.

    If SUDO_PASSWORD is not set and NOT interactive:
      Command runs as-is (fails gracefully with "sudo: a password is required").
    """
    if command is None:
        return None, None
    transformed, sudo_count = _rewrite_real_sudo_invocations(command)
    if sudo_count == 0:
        return command, None

    has_configured_password = "SUDO_PASSWORD" in os.environ
    sudo_password = (
        os.environ.get("SUDO_PASSWORD", "")
        if has_configured_password
        else _get_cached_sudo_password()
    )

    # Local hosts with sudoers NOPASSWD should not be forced through the
    # interactive Fan password prompt or the sudo -S password-pipe path.
    # Scoped to the local terminal backend so Docker/SSH/Modal/etc. can't
    # inherit host sudo state. Re-probes every call (no process-lifetime
    # cache) so an expired sudo timestamp doesn't make a later command block
    # silently without Fan prompting.
    if not has_configured_password and not sudo_password and _sudo_nopasswd_works():
        return command, None

    has_sudo_prompt_callback = _get_sudo_password_callback() is not None
    should_prompt_for_sudo = (
        env_var_enabled("FAN_INTERACTIVE") or has_sudo_prompt_callback
    )
    if not has_configured_password and not sudo_password and should_prompt_for_sudo:
        sudo_password = _prompt_for_sudo_password(timeout_seconds=45)
        if sudo_password:
            _set_cached_sudo_password(sudo_password)

    if has_configured_password or sudo_password:
        # Each ``sudo -S`` consumes one password line. Compound commands need
        # one line per invocation rather than leaving later sudo calls empty.
        return transformed, (sudo_password + "\n") * sudo_count

    return command, None


# Environment classes now live in tools/environments/ (local only — the
# remote/container backends were removed).
from tools.environments.local import LocalEnvironment as _LocalEnvironment
import sys


# Tool description for LLM
TERMINAL_TOOL_DESCRIPTION = """Execute shell commands on a Linux environment. Filesystem usually persists between calls.

Do NOT use cat/head/tail to read files — use read_file instead.
Do NOT use grep/rg/find to search — use search_files instead.
Do NOT use ls to list directories — use search_files(target='files') instead.
Do NOT use sed/awk to edit files — use patch instead.
Do NOT use echo/cat heredoc to create files — use write_file instead.
Reserve terminal for: builds, installs, git, processes, scripts, network, package managers, and anything that needs a shell.

Foreground (default): Commands return INSTANTLY when done, even if the timeout is high. Set timeout=300 for long builds/scripts — you'll still get the result in seconds if it's fast. Prefer foreground for short commands.
Background: Set background=true to get a session_id. Almost always pair with notify_on_complete=true — bg without notify runs SILENTLY and you have no way to learn it finished short of calling process(action='poll') yourself. Two legitimate uses:
  (1) Long-lived processes that never exit (servers, watchers, daemons) — silent is correct, there's no exit to notify on.
  (2) Long-running bounded tasks (tests, builds, deploys, CI pollers, batch jobs) — MUST set notify_on_complete=true. Without it you'll either forget to poll or sit blocked waiting for the user to surface the result.
For servers/watchers, do NOT use shell-level background wrappers (nohup/disown/setsid/trailing '&') in foreground mode. Use background=true so Fan can track lifecycle and output.
After starting a server, verify readiness with a health check or log signal, then run tests in a separate terminal() call. Avoid blind sleep loops.
Use process(action="poll") for progress checks, process(action="wait") to block until done.
Working directory: Use 'workdir' for per-command cwd.
PTY mode: Set pty=true for interactive CLI tools (Codex, Claude Code, Python REPL).

Judge command success by exit_code, not by whether output contains an earlier fallback error. In shell chains, exit_code belongs to the final executed branch/pipeline: `A || B` can succeed even when A printed an error, while `A; B; C` reports only C's status and can hide useful output from A or B behind C's non-zero exit. When probing alternatives, structure the command so finding any usable result produces a final exit code of 0.

Do NOT use vim/nano/interactive tools without pty=true — they hang without a pseudo-terminal. Pipe git output to cat if it might page.
"""

# Global state for environment lifecycle management
_active_environments: Dict[str, Any] = {}
_last_activity: Dict[str, float] = {}
_env_lock = threading.Lock()
_creation_locks: Dict[str, threading.Lock] = {}  # Per-task locks for sandbox creation
_creation_locks_lock = threading.Lock()  # Protects _creation_locks dict itself
_cleanup_thread = None
_cleanup_running = False

# Per-task environment overrides registry.
# Allows environments (e.g., TerminalBench2Env) to specify a custom Docker/Modal
# image for a specific task_id BEFORE the agent loop starts. When the terminal or
# file tools create a new sandbox for that task_id, they check this registry first
# and fall back to the TERMINAL_MODAL_IMAGE (etc.) env var if no override is set.
#
# This is never exposed to the model -- only infrastructure code calls it.
# Thread-safe because each task_id is unique per rollout.
_task_env_overrides: Dict[str, Dict[str, Any]] = {}


def register_task_env_overrides(task_id: str, overrides: Dict[str, Any]):
    """
    Register environment overrides for a specific task/rollout.

    Supported override keys:
        - cwd: str -- Working directory for the task's environment

    Args:
        task_id: The rollout's unique task identifier
        overrides: Dict of config keys to override
    """
    _task_env_overrides[task_id] = overrides

    # If a live environment already exists for this task, a freshly registered
    # ``cwd`` override (e.g. the ACP client switching the editor's project root
    # mid-session via ``session/load`` / ``session/resume``) must take effect on
    # the cached env too. ``terminal_tool`` resolves the per-command cwd as
    # ``workdir > env.cwd > config/override cwd`` so that ordinary in-session
    # ``cd`` state is preserved; without syncing here the override would sit
    # below the (already-set) ``env.cwd`` and be silently ignored once any
    # command has run. Pushing it onto the live env keeps ``cd`` tracking intact
    # while letting an explicit ACP cwd change win, as the client expects.
    new_cwd = overrides.get("cwd")
    if isinstance(new_cwd, str) and new_cwd.strip():
        # The live env is cached under the raw task_id for per-session surfaces
        # (ACP/gateway/dashboard) and under the collapsed container id for
        # isolation-keyed rollouts. Try the raw id first, then the container id,
        # so a CWD-only override (which collapses to "default") still finds and
        # updates the originating session's env.
        container_id = _resolve_container_task_id(task_id)
        with _env_lock:
            env = _active_environments.get(task_id) or _active_environments.get(container_id)
        if env is not None and getattr(env, "cwd", None) is not None:
            env.cwd = new_cwd


def clear_task_env_overrides(task_id: str):
    """
    Clear environment overrides for a task after rollout completes.

    Called during cleanup to avoid stale entries accumulating.
    """
    _task_env_overrides.pop(task_id, None)


def _resolve_container_task_id(task_id: Optional[str]) -> str:
    """
    Map a tool-call ``task_id`` to the container/sandbox key used by
    ``_active_environments``.

    The top-level agent passes ``task_id=None`` and lands on ``"default"``.
    ``delegate_task`` children pass their own subagent ID so that
    file-state tracking, the active-subagents registry, and TUI events stay
    distinct per child -- but we deliberately collapse that ID back to
    ``"default"`` here so subagents share the parent's long-lived container
    (one bash, one /workspace, one set of installed packages).

    CWD-only overrides (registered by the ACP adapter for workspace
    tracking) are *not* isolation signals — they should not cause each
    session to spin up its own environment. Only an explicit ``env_type``
    override triggers isolation (the per-backend image keys went away
    with the remote backends).
    """
    _ISOLATION_KEYS = frozenset({"env_type"})
    if task_id and task_id in _task_env_overrides:
        overrides = _task_env_overrides[task_id]
        if set(overrides.keys()) & _ISOLATION_KEYS:
            return task_id
    return "default"


# Configuration from environment variables

def _parse_env_var(name: str, default: str, converter: Any = int, type_label: str = "integer"):
    """Parse an environment variable with *converter*, raising a clear error on bad values.

    Without this wrapper, a single malformed env var (e.g. TERMINAL_TIMEOUT=5m)
    causes an unhandled ValueError that kills every terminal command.
    """
    raw = os.getenv(name, default)
    try:
        return converter(raw)
    except (ValueError, json.JSONDecodeError):
        raise ValueError(
            f"Invalid value for {name}: {raw!r} (expected {type_label}). "
            f"Check ~/.fan/.env or environment variables."
        )


def _safe_getcwd() -> str:
    """Return the current working directory, tolerating a deleted CWD.

    ``os.getcwd()`` raises FileNotFoundError when the process's working
    directory has been removed out from under it (e.g. a scratch workspace
    that was cleaned up mid-session). Fall back to TERMINAL_CWD, then the
    user's home directory, so terminal setup never crashes on a stale CWD.
    """
    try:
        return os.getcwd()
    except FileNotFoundError:
        return os.getenv("TERMINAL_CWD") or os.path.expanduser("~")


def _get_env_config() -> Dict[str, Any]:
    """Get terminal environment configuration from environment variables.

    Local-only: the remote/container backends (Docker, Modal, SSH,
    Singularity, Daytona) were removed, so ``env_type`` is always
    ``"local"`` and only local knobs remain.
    """
    cwd = os.getenv("TERMINAL_CWD", _safe_getcwd())
    if cwd:
        cwd = os.path.expanduser(cwd)

    return {
        "env_type": "local",
        "cwd": cwd,
        "timeout": _parse_env_var("TERMINAL_TIMEOUT", "180"),
        "lifetime_seconds": _parse_env_var("TERMINAL_LIFETIME_SECONDS", "300"),
        "local_persistent": os.getenv("TERMINAL_LOCAL_PERSISTENT", "false").lower() in {"true", "1", "yes"},
    }


def _create_environment(env_type: str = "local", cwd: str = "", timeout: int = 180,
                        local_config: dict = None,
                        task_id: str = "default",
                        **_legacy_kwargs):
    """
    Create a local execution environment.

    The remote/container backends (Docker, Modal, SSH, Singularity, Daytona)
    were removed — every command runs on the host. ``env_type`` and the
    legacy keyword arguments are accepted for caller compatibility but the
    result is always a :class:`LocalEnvironment`.

    Args:
        cwd: Working directory
        timeout: Default command timeout
        task_id: Task identifier for environment reuse

    Returns:
        Environment instance with execute() method
    """
    return _LocalEnvironment(cwd=cwd, timeout=timeout)


def _cleanup_inactive_envs(lifetime_seconds: int = 300):
    """Clean up environments that have been inactive for longer than lifetime_seconds."""
    current_time = time.time()

    # Check the process registry -- skip cleanup for sandboxes with active
    # background processes (their _last_activity gets refreshed to keep them alive).
    try:
        from tools.process_registry import process_registry
        for task_id in list(_last_activity.keys()):
            if process_registry.has_active_processes(task_id):
                _last_activity[task_id] = current_time  # Keep sandbox alive
    except ImportError:
        pass

    # Phase 1: collect stale entries and remove them from tracking dicts while
    # holding the lock.  Do NOT call env.cleanup() inside the lock -- Modal and
    # Docker teardown can block for 10-15s, which would stall every concurrent
    # terminal/file tool call waiting on _env_lock.
    envs_to_stop = []  # list of (task_id, env) pairs

    with _env_lock:
        for task_id, last_time in list(_last_activity.items()):
            if current_time - last_time > lifetime_seconds:
                env = _active_environments.pop(task_id, None)
                _last_activity.pop(task_id, None)
                if env is not None:
                    envs_to_stop.append((task_id, env))

        # Also purge per-task creation locks for cleaned-up tasks
        with _creation_locks_lock:
            for task_id, _ in envs_to_stop:
                _creation_locks.pop(task_id, None)

    # Phase 2: stop the actual sandboxes OUTSIDE the lock so other tool calls
    # are not blocked while Modal/Docker sandboxes shut down.
    for task_id, env in envs_to_stop:
        # Invalidate stale file_ops cache entry (Bug fix: prevents
        # ShellFileOperations from referencing a dead sandbox)
        try:
            from tools.file_tools import clear_file_ops_cache
            clear_file_ops_cache(task_id)
        except ImportError:
            pass

        try:
            if hasattr(env, 'cleanup'):
                env.cleanup()
            elif hasattr(env, 'stop'):
                env.stop()
            elif hasattr(env, 'terminate'):
                env.terminate()

            logger.info("Cleaned up inactive environment for task: %s", task_id)

        except Exception as e:
            error_str = str(e)
            if "404" in error_str or "not found" in error_str.lower():
                logger.info("Environment for task %s already cleaned up", task_id)
            else:
                logger.warning("Error cleaning up environment for task %s: %s", task_id, e)


def _cleanup_thread_worker():
    """Background thread worker that periodically cleans up inactive environments."""
    while _cleanup_running:
        try:
            config = _get_env_config()
            _cleanup_inactive_envs(config["lifetime_seconds"])
        except Exception as e:
            logger.warning("Error in cleanup thread: %s", e, exc_info=True)

        for _ in range(60):
            if not _cleanup_running:
                break
            time.sleep(1)


def _start_cleanup_thread():
    """Start the background cleanup thread if not already running."""
    global _cleanup_thread, _cleanup_running

    with _env_lock:
        if _cleanup_thread is None or not _cleanup_thread.is_alive():
            _cleanup_running = True
            _cleanup_thread = threading.Thread(target=_cleanup_thread_worker, daemon=True)
            _cleanup_thread.start()


def _stop_cleanup_thread():
    """Stop the background cleanup thread."""
    global _cleanup_running
    _cleanup_running = False
    if _cleanup_thread is not None:
        try:
            _cleanup_thread.join(timeout=5)
        except (SystemExit, KeyboardInterrupt):
            pass


def get_active_env(task_id: str):
    """Return the active BaseEnvironment for *task_id*, or None."""
    lookup = _resolve_container_task_id(task_id)
    with _env_lock:
        return _active_environments.get(lookup) or _active_environments.get(task_id)


def is_persistent_env(task_id: str) -> bool:
    """Return True if the active environment for task_id is configured for
    cross-turn persistence (``persistent_filesystem=True``).

    Used by the agent loop to skip per-turn teardown for backends whose whole
    point is to survive between turns (docker with ``container_persistent``,
    daytona, modal, etc.). Non-persistent backends (e.g. Morph) still get torn
    down at end-of-turn to prevent leakage. The idle reaper
    (``_cleanup_inactive_envs``) handles persistent envs once they exceed
    ``terminal.lifetime_seconds``.
    """
    env = get_active_env(task_id)
    if env is None:
        return False
    return bool(getattr(env, "_persistent", False))




def cleanup_all_environments():
    """Clean up ALL active environments. Use with caution."""
    task_ids = list(_active_environments.keys())
    cleaned = 0
    
    for task_id in task_ids:
        try:
            cleanup_vm(task_id)
            cleaned += 1
        except Exception as e:
            logger.error("Error cleaning %s: %s", task_id, e, exc_info=True)
    
    # Also clean any orphaned directories
    scratch_dir = _get_scratch_dir()
    import glob
    for path in glob.glob(str(scratch_dir / "fan-*")):
        try:
            shutil.rmtree(path, ignore_errors=True)
            logger.info("Removed orphaned: %s", path)
        except OSError as e:
            logger.debug("Failed to remove orphaned path %s: %s", path, e)
    
    if cleaned > 0:
        logger.info("Cleaned %d environments", cleaned)
    return cleaned


def cleanup_vm(task_id: str, *, force_remove: bool = False):
    """Manually clean up a specific environment by task_id.

    *force_remove* (default False) is forwarded to environments whose
    ``cleanup()`` accepts it. The default of False matches
    session-lifecycle semantics: this function is called from
    ``AIAgent.close()`` (TUI session close, gateway session teardown) and the
    per-turn cleanup branch for non-persistent envs, both of which should
    honor the user's persist-mode preference. Stopping the container here
    would defeat the "ONE long-lived container shared across sessions"
    contract — exactly the bug Ben reported when the container was killed
    on every TUI session close.

    Pass ``force_remove=True`` for actual user-initiated teardown
    (e.g. ``/reset``-style flows that haven't been wired yet, or future
    "destroy my sandbox" commands).

    The idle reaper passes the env through ``env.cleanup()`` directly (not
    via this function), so persist-mode idle envs are similarly no-op'd —
    only the orphan reaper at next startup reclaims them.
    """
    # Remove from tracking dicts while holding the lock, but defer the
    # actual (potentially slow) env.cleanup() call to outside the lock
    # so other tool calls aren't blocked.
    env = None
    with _env_lock:
        env = _active_environments.pop(task_id, None)
        _last_activity.pop(task_id, None)

    # Clean up per-task creation lock
    with _creation_locks_lock:
        _creation_locks.pop(task_id, None)

    # Invalidate stale file_ops cache entry
    try:
        from tools.file_tools import clear_file_ops_cache
        clear_file_ops_cache(task_id)
    except ImportError:
        pass

    if env is None:
        return

    try:
        if hasattr(env, 'cleanup'):
            # Pass force_remove only if the env's cleanup() accepts it.
            import inspect
            sig = inspect.signature(env.cleanup)
            if "force_remove" in sig.parameters:
                env.cleanup(force_remove=force_remove)
            else:
                env.cleanup()
        elif hasattr(env, 'stop'):
            env.stop()
        elif hasattr(env, 'terminate'):
            env.terminate()

        logger.info("Manually cleaned up environment for task: %s", task_id)

    except Exception as e:
        error_str = str(e)
        if "404" in error_str or "not found" in error_str.lower():
            logger.info("Environment for task %s already cleaned up", task_id)
        else:
            logger.warning("Error cleaning up environment for task %s: %s", task_id, e)


def _atexit_cleanup():
    """Stop cleanup thread and shut down all remaining sandboxes on exit."""
    _stop_cleanup_thread()
    if _active_environments:
        count = len(_active_environments)
        logger.info("Shutting down %d remaining sandbox(es)...", count)
        # Snapshot the env objects BEFORE cleanup_all_environments empties
        # the dict; we need them to wait on docker cleanup threads after the
        # registry has been cleared.
        envs_to_wait = list(_active_environments.values())
        cleanup_all_environments()
        # Block briefly so docker stop/rm actually completes before the
        # interpreter exits. Issue #20561 — without this join, the daemon
        # cleanup threads were getting torn down mid-`docker stop`, leaving
        # Exited containers piled up on the host.
        for env in envs_to_wait:
            wait_fn = getattr(env, "wait_for_cleanup", None)
            if wait_fn is None:
                continue
            try:
                wait_fn(timeout=15.0)
            except Exception as e:  # never block shutdown on a bad backend
                logger.debug("wait_for_cleanup raised on exit: %s", e)

atexit.register(_atexit_cleanup)


# =============================================================================
# Exit Code Context for Common CLI Tools
# =============================================================================
# Many Unix commands use non-zero exit codes for informational purposes, not
# to indicate failure.  The model sees a raw exit_code=1 from `grep` and
# wastes a turn investigating something that just means "no matches".
# This lookup adds structured context so the agent and UI can distinguish an
# expected non-zero status from a genuine command failure.


def _last_shell_status_segment(command: str) -> str:
    r"""Return the final shell segment whose status becomes ``$?``.

    This is intentionally a small lexer rather than a regex split: shell
    operators inside quotes or escaped patterns (notably ``grep 'a\|b'``)
    are data, not control operators.  Full shell parsing is unnecessary here;
    we only need the final top-level segment for an explanatory hint.
    """
    segment_start = 0
    quote = ""
    escaped = False
    index = 0

    while index < len(command):
        char = command[index]

        if escaped:
            escaped = False
            index += 1
            continue

        if quote:
            if char == "\\" and quote == '"':
                escaped = True
            elif char == quote:
                quote = ""
            index += 1
            continue

        if char == "\\":
            escaped = True
            index += 1
            continue

        if char in {"'", '"'}:
            quote = char
            index += 1
            continue

        operator_length = 0
        if char in {";", "\n"}:
            operator_length = 1
        elif char == "|":
            operator_length = 2 if command[index : index + 2] in {"||", "|&"} else 1
        elif char == "&" and command[index : index + 2] == "&&":
            operator_length = 2

        if operator_length:
            segment_start = index + operator_length
            index += operator_length
            continue

        index += 1

    return command[segment_start:].strip()


def _exit_code_context(command: str, exit_code: int) -> tuple[str, bool] | None:
    """Return ``(meaning, expected)`` for a recognized non-zero exit code."""
    if exit_code == 0:
        return None

    last_segment = _last_shell_status_segment(command)

    # Get base command name (first word), stripping env var assignments
    # like  VAR=val cmd ...
    words = last_segment.split()
    base_cmd = ""
    for word in words:
        if "=" in word and not word.startswith("-"):
            continue  # skip VAR=val
        base_cmd = word.split("/")[-1]  # handle /usr/bin/grep -> grep
        break

    if not base_cmd:
        return None

    # The boolean indicates whether this status is an expected command outcome
    # that should remain truthful in exit_code without being painted as an
    # execution failure. Context-dependent/partial/error statuses stay false.
    semantics: dict[str, dict[int, tuple[str, bool]]] = {
        # grep/rg/ag/ack: 1=no matches found (normal), 2+=real error
        "grep": {1: ("No matches found (not an error)", True)},
        "egrep": {1: ("No matches found (not an error)", True)},
        "fgrep": {1: ("No matches found (not an error)", True)},
        "rg": {1: ("No matches found (not an error)", True)},
        "ag": {1: ("No matches found (not an error)", True)},
        "ack": {1: ("No matches found (not an error)", True)},
        # diff: 1=files differ (expected), 2+=real error
        "diff": {1: ("Files differ (expected, not an error)", True)},
        "colordiff": {1: ("Files differ (expected, not an error)", True)},
        # find: 1=some dirs inaccessible but results may still be valid
        "find": {1: ("Some directories were inaccessible (partial results may still be valid)", False)},
        # test/[: 1=condition is false (expected)
        "test": {1: ("Condition evaluated to false (expected, not an error)", True)},
        "[": {1: ("Condition evaluated to false (expected, not an error)", True)},
        # curl: common error codes
        "curl": {
            6: ("Could not resolve host", False),
            7: ("Failed to connect to host", False),
            22: ("HTTP response code indicated error (e.g. 404, 500)", False),
            28: ("Operation timed out", False),
        },
        # git: 1 is context-dependent, so keep failure classification intact.
        "git": {1: ("Non-zero exit (often normal — e.g. 'git diff' returns 1 when files differ)", False)},
    }

    return semantics.get(base_cmd, {}).get(exit_code)


def _interpret_exit_code(command: str, exit_code: int) -> str | None:
    """Return a human-readable note for a recognized non-zero exit code.

    The note is appended to the tool result so the model can distinguish an
    expected status from an error. Use ``_exit_code_context`` when the caller
    also needs the structured expected/error classification.
    """
    context = _exit_code_context(command, exit_code)
    return context[0] if context else None


def _command_requires_pipe_stdin(command: str) -> bool:
    """Return True when PTY mode would break stdin-driven commands.

    Some CLIs change behavior when stdin is a TTY. In particular,
    `gh auth login --with-token` expects the token to arrive via piped stdin and
    waits for EOF; when we launch it under a PTY, `process.submit()` only sends a
    newline, so the command appears to hang forever with no visible progress.
    """
    normalized = " ".join(command.lower().split())
    return (
        normalized.startswith("gh auth login")
        and "--with-token" in normalized
    )


_SHELL_LEVEL_BACKGROUND_RE = re.compile(
    r"(?:^|[;&|]\s*|&&\s*|\|\|\s*|\$\(\s*)(?:nohup|disown|setsid)\b", re.IGNORECASE | re.MULTILINE
)
_INLINE_BACKGROUND_AMP_RE = re.compile(r"\s&\s")
_TRAILING_BACKGROUND_AMP_RE = re.compile(r"\s&\s*(?:#.*)?$")


def _strip_quotes(command: str) -> str:
    """Remove single- and double-quoted content so regex checks don't match inside strings.

    This prevents false positives when keywords like 'nohup' or 'setsid' appear
    in commit messages, Python -c code, echo arguments, or PR body text.
    Also strips backtick-quoted content and heredoc-style inline text.
    """
    # Remove single-quoted strings (no escaping inside single quotes in shell)
    result = re.sub(r"'[^']*'", "''", command)
    # Remove double-quoted strings (handle escaped quotes)
    result = re.sub(r'"(?:[^"\\]|\\.)*"', '""', result)
    # Remove backtick-quoted strings
    result = re.sub(r"`[^`]*`", "``", result)
    return result


_LONG_LIVED_FOREGROUND_PATTERNS = (
    re.compile(r"\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:dev|start|serve|watch)\b", re.IGNORECASE),
    re.compile(r"\bdocker\s+compose\s+up\b", re.IGNORECASE),
    re.compile(r"\bnext\s+dev\b", re.IGNORECASE),
    re.compile(r"\bvite(?:\s|$)", re.IGNORECASE),
    re.compile(r"\bnodemon\b", re.IGNORECASE),
    re.compile(r"\buvicorn\b", re.IGNORECASE),
    re.compile(r"\bgunicorn\b", re.IGNORECASE),
    re.compile(r"\bpython(?:3)?\s+-m\s+http\.server\b", re.IGNORECASE),
)


def _looks_like_help_or_version_command(command: str) -> bool:
    """Return True for informational invocations that should never be blocked."""
    normalized = " ".join(command.lower().split())
    return (
        " --help" in normalized
        or normalized.endswith(" -h")
        or " --version" in normalized
        or normalized.endswith(" -v")
    )


def _foreground_background_guidance(command: str) -> str | None:
    """Suggest background mode when a foreground command looks long-lived.

    Prevents workflows that start a server/watch process and then stall before
    follow-up checks or test commands run.
    """
    if _looks_like_help_or_version_command(command):
        return None

    # Strip quoted content so keywords inside strings/arguments don't trigger
    # false positives (e.g., git commit -m "... setsid ...", python3 -c "os.setsid").
    unquoted = _strip_quotes(command)

    if _SHELL_LEVEL_BACKGROUND_RE.search(unquoted):
        return (
            "Foreground command uses shell-level background wrappers (nohup/disown/setsid). "
            "Use terminal(background=true) so Fan can track the process, then run "
            "readiness checks and tests in separate commands."
        )

    if _INLINE_BACKGROUND_AMP_RE.search(unquoted) or _TRAILING_BACKGROUND_AMP_RE.search(unquoted):
        return (
            "Foreground command uses '&' backgrounding. Use terminal(background=true) for long-lived "
            "processes, then run health checks and tests in follow-up terminal calls."
        )

    for pattern in _LONG_LIVED_FOREGROUND_PATTERNS:
        if pattern.search(unquoted):
            return (
                "This foreground command appears to start a long-lived server/watch process. "
                "Run it with background=true, verify readiness (health endpoint/log signal), "
                "then execute tests in a separate command."
            )

    return None


def _resolve_notification_flag_conflict(
    *,
    notify_on_complete: bool,
    watch_patterns,
    background: bool,
) -> tuple:
    """Decide what to do when both notify_on_complete and watch_patterns are set.

    These flags produce duplicate, delayed notifications when combined — one
    notification per watch-pattern match AND one on process exit, with async
    delivery that can spam the user long after the process ends. When both are
    set, we drop watch_patterns in favor of notify_on_complete (the more useful
    "let me know when it's done" signal) and return a human-readable note.

    Returns:
        (watch_patterns_to_use, conflict_note). conflict_note is "" when there
        is no conflict.
    """
    if background and notify_on_complete and watch_patterns:
        note = (
            "watch_patterns ignored because notify_on_complete=True; "
            "these two flags produce duplicate notifications when combined"
        )
        return None, note
    return watch_patterns, ""


def _resolve_command_cwd(
    *,
    workdir: Optional[str],
    env: Any,
    default_cwd: str,
    prev_owner: Optional[str] = None,
    current_owner: Optional[str] = None,
) -> str:
    """Return the cwd for a command, preferring the live session cwd.

    ``terminal_tool`` historically re-sent the init-time/config cwd on every
    call. That broke session-local ``cd`` state: the environment tracked the
    new directory in ``env.cwd``, but foreground/background calls kept forcing
    the old cwd back through ``env.execute(..., cwd=...)``. Explicit
    ``workdir=`` must still override everything.

    The local environment is shared across desktop sessions. If its previous
    owner differs from the current session, its live cwd belongs to another
    conversation and must not override this session's configured cwd.
    """
    if workdir:
        return workdir

    live_cwd = getattr(env, "cwd", None)
    if isinstance(live_cwd, str) and live_cwd.strip():
        if (
            prev_owner
            and prev_owner != "default"
            and current_owner is not None
            and prev_owner != current_owner
        ):
            return default_cwd
        return live_cwd

    return default_cwd


def terminal_tool(
    command: str,
    background: bool = False,
    timeout: Optional[int] = None,
    task_id: Optional[str] = None,
    force: bool = False,
    workdir: Optional[str] = None,
    pty: bool = False,
    notify_on_complete: bool = False,
    watch_patterns: Optional[List[str]] = None,
) -> str:
    """
    Execute a command in the configured terminal environment.

    Args:
        command: The command to execute
        background: Whether to run in background (default: False)
        timeout: Command timeout in seconds (default: from config)
        task_id: Unique identifier for environment isolation (optional)
        force: If True, skip dangerous command check (use after user confirms)
        workdir: Working directory for this command (optional, uses session cwd if not set)
        pty: If True, use pseudo-terminal for interactive CLI tools (local backend only)
        notify_on_complete: If True and background=True, you'll be notified exactly once when the process exits. The right choice for almost every long task. MUTUALLY EXCLUSIVE with watch_patterns.
        watch_patterns: List of strings to watch for in background output. HARD rate limit: 1 notification per 15s per process. After 3 strike windows in a row, watch_patterns is disabled and the session is auto-promoted to notify_on_complete. Use ONLY for rare, one-shot mid-process signals on long-lived processes (server readiness, migration-done markers). NEVER use in loops/batch jobs — error patterns there will hit the strike limit and get disabled. MUTUALLY EXCLUSIVE with notify_on_complete — set one, not both.

    Returns:
        str: JSON string with output, exit_code, and error fields

    Examples:
        # Execute a simple command
        >>> result = terminal_tool(command="ls -la /tmp")

        # Run a background task
        >>> result = terminal_tool(command="python server.py", background=True)

        # With custom timeout
        >>> result = terminal_tool(command="long_task.sh", timeout=300)
        
        # Force run after user confirmation
        # Note: force parameter is internal only, not exposed to model API
    """
    try:
        if not isinstance(command, str):
            logger.warning(
                "Rejected invalid terminal command value: %s",
                type(command).__name__,
            )
            return json.dumps({
                "output": "",
                "exit_code": -1,
                "error": f"Invalid command: expected string, got {type(command).__name__}",
                "status": "error",
            }, ensure_ascii=False)

        if _requests_external_browser_launch(command):
            return json.dumps(
                {
                    "output": "",
                    "exit_code": -1,
                    "error": (
                        "BROWSER_ROUTE_REQUIRED: HTTP(S) pages must be opened in Fan's "
                        "built-in browser with browser_navigate or browser_search; launching the "
                        "operating system browser is disabled for desktop sessions."
                    ),
                    "status": "blocked",
                },
                ensure_ascii=False,
            )

        # Get configuration
        config = _get_env_config()
        env_type = config["env_type"]

        # Use task_id for environment isolation. By default all subagent
        # task_ids collapse back to "default" so the top-level agent and
        # every delegate_task child share one container; only task_ids with
        # a registered env override (RL benchmarks) get isolated sandboxes.
        effective_task_id = _resolve_container_task_id(task_id)

        # Check per-task overrides (set by environments like TerminalBench2Env)
        # before falling back to global env var config.
        #
        # Overrides are keyed by the *raw* task_id (that's the key
        # ``register_task_env_overrides`` writes under), NOT by the collapsed
        # container id. A CWD-only override collapses ``effective_task_id`` to
        # ``"default"`` for container sharing, but its cwd must still be read
        # back here under the originating task_id, or the override is silently
        # dropped. Fall back to the collapsed id so isolation-keyed RL/benchmark
        # overrides (registered under an id that equals their container id) keep
        # resolving as before.
        overrides = (
            (_task_env_overrides.get(task_id) if task_id else None)
            or _task_env_overrides.get(effective_task_id, {})
        )

        cwd = overrides.get("cwd") or config["cwd"]
        default_timeout = config["timeout"]
        effective_timeout = timeout or default_timeout

        # Reject foreground commands where the model explicitly requests
        # a timeout above FOREGROUND_MAX_TIMEOUT — nudge it toward background.
        if not background and timeout and timeout > FOREGROUND_MAX_TIMEOUT:
            return json.dumps({
                "error": (
                    f"Foreground timeout {timeout}s exceeds the maximum of "
                    f"{FOREGROUND_MAX_TIMEOUT}s. Use background=true with "
                    f"notify_on_complete=true for long-running commands."
                ),
            }, ensure_ascii=False)

        # Guardrail: long-lived server/watch commands should run as managed
        # background sessions, not foreground shell hacks.
        if not background:
            guidance = _foreground_background_guidance(command)
            if guidance:
                return json.dumps({
                    "output": "",
                    "exit_code": -1,
                    "error": guidance,
                    "status": "error",
                }, ensure_ascii=False)

        # Start cleanup thread
        _start_cleanup_thread()

        # Get or create environment.
        # Use a per-task creation lock so concurrent tool calls for the same
        # task_id wait for the first one to finish creating the sandbox,
        # instead of each creating their own (wasting Modal resources).
        with _env_lock:
            # Prefer the collapsed container id, but fall back to an env cached
            # under the raw task_id. Per-session surfaces (ACP/gateway/dashboard)
            # with a CWD-only override collapse to "default" for container
            # sharing, yet an env may already be cached under the originating
            # task_id; honor it instead of spawning a duplicate.
            _existing_key = (
                effective_task_id if effective_task_id in _active_environments
                else (task_id if task_id and task_id in _active_environments else None)
            )
            if _existing_key is not None:
                _last_activity[_existing_key] = time.time()
                env = _active_environments[_existing_key]
                needs_creation = False
            else:
                needs_creation = True

        if needs_creation:
            # Per-task lock: only one thread creates the sandbox, others wait
            with _creation_locks_lock:
                if effective_task_id not in _creation_locks:
                    _creation_locks[effective_task_id] = threading.Lock()
                task_lock = _creation_locks[effective_task_id]

            with task_lock:
                # Double-check after acquiring the per-task lock
                with _env_lock:
                    _existing_key = (
                        effective_task_id if effective_task_id in _active_environments
                        else (task_id if task_id and task_id in _active_environments else None)
                    )
                    if _existing_key is not None:
                        _last_activity[_existing_key] = time.time()
                        env = _active_environments[_existing_key]
                        needs_creation = False

                if needs_creation:
                    logger.info("Creating new %s environment for task %s...", env_type, effective_task_id[:8])
                    try:
                        # Local-only execution: remote/container backends removed.
                        local_config = {
                            "persistent": config.get("local_persistent", False),
                        }

                        new_env = _create_environment(
                            env_type=env_type,
                            cwd=cwd,
                            timeout=effective_timeout,
                            local_config=local_config,
                            task_id=effective_task_id,
                        )
                    except ImportError as e:
                        return json.dumps({
                            "output": "",
                            "exit_code": -1,
                            "error": f"Terminal tool disabled: environment creation failed ({e})",
                            "status": "disabled"
                        }, ensure_ascii=False)

                    with _env_lock:
                        _active_environments[effective_task_id] = new_env
                        _last_activity[effective_task_id] = time.time()
                        env = new_env
                    logger.info("%s environment ready for task %s", env_type, effective_task_id[:8])

        # Hard boundary shared with file tools: terminal commands must not
        # mutate Fan authentication / execution-authority state (or any path
        # denied by FAN_WRITE_SAFE_ROOT).  This check runs before the ordinary
        # approval flow and therefore cannot be bypassed by force, yolo mode,
        # disabled approvals, or a remembered approval.
        from tools.approval import (
            detect_protected_write_command,
            get_current_session_key,
        )

        session_key = get_current_session_key(default="") or (task_id or "")
        prev_cwd_owner = getattr(env, "cwd_owner", "") or ""

        protected_cwd = _resolve_command_cwd(
            workdir=workdir,
            env=env,
            default_cwd=cwd,
            prev_owner=prev_cwd_owner,
            current_owner=session_key,
        )
        protected, operation, protected_target = detect_protected_write_command(
            command,
            cwd=protected_cwd,
        )
        if protected:
            logger.warning(
                "Blocked terminal %s targeting protected path: %s",
                operation,
                protected_target,
            )
            return json.dumps(
                {
                    "output": "",
                    "exit_code": -1,
                    "error": (
                        f"Write denied: terminal {operation} targets protected path "
                        f"'{protected_target}'. Use Fan's trusted settings or "
                        "administration interface to change this state."
                    ),
                    "status": "blocked",
                },
                ensure_ascii=False,
            )

        # Pre-exec security checks (tirith + dangerous command detection)
        # Skip check if force=True (user has confirmed they want to run it)
        approval_note = None
        _approved_run = bool(force)
        if not force:
            approval = _check_all_guards(command, env_type)
            if not approval["approved"]:
                # Check if this is an approval_required (gateway ask mode)
                if approval.get("status") == "pending_approval":
                    return json.dumps({
                        "output": "",
                        "exit_code": -1,
                        "error": "",
                        "status": "pending_approval",
                        "approval_pending": True,
                        "command": approval.get("command", command),
                        "description": approval.get("description", "command flagged"),
                        "pattern_key": approval.get("pattern_key", ""),
                    }, ensure_ascii=False)
                # Command was blocked
                desc = approval.get("description", "command flagged")
                fallback_msg = (
                    f"Command denied: {desc}. "
                    "Use the approval prompt to allow it, or rephrase the command."
                )
                return json.dumps({
                    "output": "",
                    "exit_code": -1,
                    "error": approval.get("message", fallback_msg),
                    "status": "blocked"
                }, ensure_ascii=False)
            # Track whether approval was explicitly granted by the user
            if approval.get("user_approved"):
                desc = approval.get("description", "flagged as dangerous")
                approval_note = f"Command required approval ({desc}) and was approved by the user."
                _approved_run = True
            elif approval.get("smart_approved"):
                desc = approval.get("description", "flagged as dangerous")
                approval_note = f"Command was flagged ({desc}) and auto-approved by smart approval."

        # Validate workdir against shell injection
        if workdir:
            workdir_error = _validate_workdir(workdir)
            if workdir_error:
                logger.warning("Blocked dangerous workdir: %s (command: %s)",
                               workdir[:200], _safe_command_preview(command))
                return json.dumps({
                    "output": "",
                    "exit_code": -1,
                    "error": workdir_error,
                    "status": "blocked"
                }, ensure_ascii=False)

        # Prepare command for execution
        pty_disabled_reason = None
        effective_pty = pty
        if pty and _command_requires_pipe_stdin(command):
            effective_pty = False
            pty_disabled_reason = (
                "PTY disabled for this command because it expects piped stdin/EOF "
                "(for example gh auth login --with-token). For local background "
                "processes, call process(action='close') after writing so it receives "
                "EOF."
            )

        # The local terminal environment is intentionally shared by desktop
        # sessions, but its live cwd is not.  Stamp the session currently
        # driving it so file tools never reuse another workspace's last `cd`.
        # Context variables do not cross every tool-worker boundary, so the raw
        # task id remains the stable fallback for top-level sessions.
        try:
            env.cwd_owner = session_key
        except Exception:
            pass

        if background:
            # Spawn a tracked background process via the process registry.
            # For local backends: uses subprocess.Popen with output buffering.
            # For non-local backends: runs inside the sandbox via env.execute().
            from tools.process_registry import process_registry

            effective_cwd = _resolve_command_cwd(
                workdir=workdir,
                env=env,
                default_cwd=cwd,
                prev_owner=prev_cwd_owner,
                current_owner=session_key,
            )
            try:
                proc_session = process_registry.spawn_local(
                    command=command,
                    cwd=effective_cwd,
                    task_id=effective_task_id,
                    session_key=session_key,
                    env_vars=env.env if hasattr(env, 'env') else None,
                    use_pty=effective_pty,
                )

                result_data = {
                    "output": "Background process started",
                    "session_id": proc_session.id,
                    "pid": proc_session.pid,
                    "exit_code": 0,
                    "error": None,
                }
                if approval_note:
                    result_data["approval"] = approval_note
                if pty_disabled_reason:
                    result_data["pty_note"] = pty_disabled_reason

                # Nudge: background=True without notify_on_complete=True OR
                # watch_patterns is a silent process. The agent has NO way to
                # learn it finished short of calling process(action="poll"/"wait")
                # explicitly. That's correct only for genuine long-lived
                # processes that never exit (servers, watchers). For every
                # bounded task (tests, builds, CI pollers, deploys, batch
                # jobs) the agent almost certainly wanted notification and
                # forgot the flag. May 2026 PR #31231 incident: bg CI poller
                # ran fine, exited green, agent never noticed — user had to
                # surface the result. Cheap nudge here costs ~one read for
                # server cases (false positive) and prevents silent
                # blindness for bounded-task cases (false negative).
                if background and not notify_on_complete and not watch_patterns:
                    result_data["hint"] = (
                        "background=true without notify_on_complete=true means "
                        "this process runs SILENTLY — you will not be told when "
                        "it exits. If this is a bounded task (test suite, build, "
                        "CI poller, deploy, anything with a defined end), you "
                        "almost certainly wanted notify_on_complete=true so the "
                        "system pings you on exit. Re-launch with "
                        "notify_on_complete=true, or call process(action='poll') "
                        "/ process(action='wait') yourself to learn the outcome. "
                        "Only ignore this hint for genuine long-lived processes "
                        "that never exit (servers, watchers, daemons)."
                    )

                # Nudge: homebrewed CI watcher built from `gh pr view`
                # `--json statusCheckRollup` or `gh pr checks` piped through
                # `jq` is the #1 cause of silent CI-watcher failures in
                # fan-agent dev work. May 2026 PRs that surfaced this
                # exact failure mode: #31329, #31448, #31695, #31709, #31745,
                # #32264, #33131. Failure modes seen:
                #   * `gh pr view --json statusCheckRollup --jq ...` with
                #     `from_entries` choking on null `conclusion` keys, loop
                #     silently exits with empty status, never terminates.
                #   * `for i in $(seq 1 60); do ... 2>&1` block-buffered stdout
                #     never flushed to background-process capture; SIGTERM
                #     cuts the buffer before flush; `process(action='log')`
                #     returns total_lines=0 forever.
                #   * conclusion vs. status field confusion: filtering for
                #     `PENDING` in `.conclusion` while in-progress checks have
                #     empty conclusion → poller declares all-green while 18/23
                #     checks still IN_PROGRESS.
                #   * grepping for TTY-only banners ("All checks were
                #     successful") that never appear when stdout is piped.
                # The canonical patterns in the green-ci-policy skill avoid
                # every one of these — drive the loop off exit codes or on
                # tab-separated `awk -F"\t" "$2==\"pending\""` (column 2).
                # The detector here is deliberately narrow: it flags the
                # statusCheckRollup JSON-API path and the `gh pr checks` +
                # jq combination, but NOT the canonical column-2 awk
                # poller (which uses awk on tabs, not as a generic
                # stdout parser). When we detect the homebrew shape, point
                # the agent at the canonical snippet rather than letting
                # it ship another broken poller.
                if background and command:
                    _gh = ("gh pr view" in command or "gh pr checks" in command)
                    _has_jq = (
                        " jq " in command or "| jq" in command or "$(jq" in command
                    )
                    _bad_shape = (
                        # The JSON-API anti-pattern. Even without jq, going
                        # through `--json statusCheckRollup` + parsing puts
                        # you in conclusion-vs-status field hell.
                        "statusCheckRollup" in command
                        # gh pr checks piped to jq is also wrong — `gh pr
                        # checks` doesn't emit JSON, so any `| jq` here is
                        # confused intent. The canonical column-2 poller
                        # uses awk-on-tabs, not jq.
                        or (_gh and _has_jq)
                    )
                    if _bad_shape:
                        existing = result_data.get("hint", "")
                        canonical_hint = (
                            "This looks like a homebrewed CI poller built from "
                            "`gh pr view --json statusCheckRollup` and/or "
                            "`gh pr checks | jq`. That shape has burned us "
                            "repeatedly in fan-agent dev work (PRs #31329, "
                            "#31448, #31695, #31709, #31745, #32264, #33131) — "
                            "stdout buffering kills output capture, jq null-key "
                            "edge cases silently exit the loop, conclusion-vs-"
                            "status field confusion exits early with bogus "
                            "all-green verdicts, TTY-only summary banners "
                            "never appear when piped. Use the canonical "
                            "snippets in the green-ci-policy skill instead: "
                            "the exit-code-driven `gh pr checks $PR >/dev/null` "
                            "(rc 0 = green, 8 = pending, else fail) for "
                            "exit-on-first-fail behavior, or the column-2 "
                            "awk-on-tabs poller "
                            "(`awk -F\"\\t\" \"$2==\\\"pending\\\"\"`) for "
                            "sharded matrices. Load skill_view("
                            "name='github/fan-agent-dev', "
                            "file_path='references/green-ci-policy.md') for "
                            "the verbatim snippets. If you must roll a custom "
                            "loop with rich structured output, write each tick "
                            "to a known file (`tee -a /tmp/ci.log`) and rely "
                            "on `process(action='log')` to read THAT file — "
                            "do not rely on background-process stdout capture "
                            "for line-buffered shell loops."
                        )
                        result_data["hint"] = (
                            existing + "\n\n" + canonical_hint if existing
                            else canonical_hint
                        )

                # Mutual exclusion: if both notify_on_complete and watch_patterns
                # are set, drop watch_patterns. The combination produces duplicate
                # notifications (one per match + one on exit) that deliver
                # asynchronously and can spam the user long after the process ends.
                # notify_on_complete is the more useful signal for "let me know
                # when the task finishes"; watch_patterns should be reserved for
                # standalone mid-process signals on long-lived processes.
                watch_patterns, conflict_note = _resolve_notification_flag_conflict(
                    notify_on_complete=bool(notify_on_complete),
                    watch_patterns=watch_patterns,
                    background=bool(background),
                )
                if conflict_note:
                    logger.warning("background proc %s: %s", proc_session.id, conflict_note)
                    result_data["watch_patterns_ignored"] = conflict_note

                # Mark for agent notification on completion
                if notify_on_complete and background:
                    proc_session.notify_on_complete = True
                    result_data["notify_on_complete"] = True

                # Set watch patterns for output monitoring
                if watch_patterns and background:
                    proc_session.watch_patterns = list(watch_patterns)
                    result_data["watch_patterns"] = proc_session.watch_patterns

                return json.dumps(result_data, ensure_ascii=False)
            except Exception as e:
                from agent.redact import redact_sensitive_text
                return json.dumps({
                    "output": "",
                    "exit_code": -1,
                    "error": "Failed to start background process: "
                    + redact_sensitive_text(str(e), force=True),
                }, ensure_ascii=False)
        else:
            # Run foreground command with retry logic
            max_retries = 3
            retry_count = 0
            result = None

            # Clear only once before execution. Re-clearing inside retries
            # would hide a real Stop that arrives after the command begins.
            if _approved_run:
                from tools.interrupt import clear_current_thread_interrupt

                clear_current_thread_interrupt()
            
            while retry_count <= max_retries:
                try:
                    execute_kwargs = {
                        "timeout": effective_timeout,
                        "cwd": _resolve_command_cwd(
                            workdir=workdir,
                            env=env,
                            default_cwd=cwd,
                            prev_owner=prev_cwd_owner,
                            current_owner=session_key,
                        ),
                    }
                    result = env.execute(command, **execute_kwargs)
                except Exception as e:
                    error_str = str(e).lower()
                    if "timeout" in error_str:
                        return json.dumps({
                            "output": "",
                            "exit_code": 124,
                            "error": f"Command timed out after {effective_timeout} seconds"
                        }, ensure_ascii=False)
                    
                    # Retry on transient errors
                    if retry_count < max_retries:
                        retry_count += 1
                        wait_time = 2 ** retry_count
                        logger.warning("Execution error, retrying in %ds (attempt %d/%d) - Command: %s - Error: %s: %s - Task: %s, Backend: %s",
                                       wait_time, retry_count, max_retries, _safe_command_preview(command), type(e).__name__, e, effective_task_id, env_type)
                        time.sleep(wait_time)
                        continue
                    
                    from agent.redact import redact_sensitive_text
                    safe_retry_error = redact_sensitive_text(str(e), force=True)
                    logger.error("Execution failed after %d retries - Command: %s - Error: %s: %s - Task: %s, Backend: %s",
                                 max_retries, _safe_command_preview(command), type(e).__name__, safe_retry_error, effective_task_id, env_type)
                    return json.dumps({
                        "output": "",
                        "exit_code": -1,
                        "error": f"Command execution failed: {type(e).__name__}: "
                        + safe_retry_error,
                    }, ensure_ascii=False)
                
                # Got a result
                break
            
            # Extract output
            output = result.get("output", "")
            returncode = result.get("returncode", 0)

            sudo_auth_failed = _sudo_wrong_password_failure(output)
            sudo_cache_cleared = _invalidate_cached_sudo_on_auth_failure(
                command,
                output,
            )
            if sudo_cache_cleared:
                has_sudo_prompt_callback = _get_sudo_password_callback() is not None
                if has_sudo_prompt_callback or env_var_enabled("FAN_INTERACTIVE"):
                    output += (
                        "\n\n⚠️ Sudo authentication failed — cached password "
                        "cleared. You will be prompted again on the next sudo command."
                    )
            if sudo_auth_failed and _count_real_sudo_invocations(command) > 1:
                output += (
                    "\n\n💡 Tip: this command had multiple sudo invocations. "
                    "Fan pipes one password line per sudo; nested sudo inside "
                    "heredocs/scripts may still need a single outer sudo wrapper."
                )

            # Foreground terminal output canonicalization seam: plugins receive
            # the full output string before default truncation and may only
            # replace it by returning a string from transform_terminal_output.
            # The hook is fail-open, and the first valid string return wins.
            try:
                from fan_cli.plugins import invoke_hook
                hook_results = invoke_hook(
                    "transform_terminal_output",
                    command=command,
                    output=output,
                    returncode=returncode,
                    task_id=effective_task_id or "",
                    env_type=env_type,
                )
                for hook_result in hook_results:
                    if isinstance(hook_result, str):
                        output = hook_result
                        break
            except Exception:
                pass
            
            # Truncate output if too long, keeping both head and tail
            from tools.tool_output_limits import get_max_bytes
            MAX_OUTPUT_CHARS = get_max_bytes()
            if len(output) > MAX_OUTPUT_CHARS:
                head_chars = int(MAX_OUTPUT_CHARS * 0.4)  # 40% head (error messages often appear early)
                tail_chars = MAX_OUTPUT_CHARS - head_chars  # 60% tail (most recent/relevant output)
                omitted = len(output) - head_chars - tail_chars
                truncated_notice = (
                    f"\n\n... [OUTPUT TRUNCATED - {omitted} chars omitted "
                    f"out of {len(output)} total] ...\n\n"
                )
                output = output[:head_chars] + truncated_notice + output[-tail_chars:]

            # Strip ANSI escape sequences so the model never sees terminal
            # formatting — prevents it from copying escapes into file writes.
            from tools.ansi_strip import strip_ansi
            output = strip_ansi(output)

            # Keep foreground and background output on one policy. Environment
            # dumps get opaque KEY=value masking; source/config dumps retain
            # the lower-false-positive code path.
            from agent.redact import redact_terminal_output
            output = redact_terminal_output(output.strip(), command) if output else ""

            # Interpret non-zero exit codes that aren't necessarily execution
            # errors (e.g. grep=1 means "no matches", diff=1 means "different").
            exit_context = _exit_code_context(command, returncode)

            result_dict = {
                "output": output,
                "exit_code": returncode,
                "error": None,
            }
            if approval_note:
                # rc=130 is an interruption only when the executor recorded
                # its interruption marker; a child may legitimately choose
                # that status on its own.
                if returncode == 130 and "[Command interrupted]" in output:
                    result_dict["approval"] = approval_note.rstrip(".") + ", then interrupted."
                else:
                    result_dict["approval"] = approval_note
            if exit_context:
                exit_note, exit_expected = exit_context
                result_dict["exit_code_meaning"] = exit_note
                if exit_expected:
                    result_dict["exit_code_expected"] = True
            if sudo_auth_failed:
                result_dict["sudo_auth_failed"] = True
            if sudo_cache_cleared:
                result_dict["sudo_cache_cleared"] = True

            return json.dumps(result_dict, ensure_ascii=False)

    except Exception as e:
        import traceback
        from agent.redact import redact_sensitive_text
        tb_str = redact_sensitive_text(traceback.format_exc(), force=True)
        safe_error = redact_sensitive_text(str(e), force=True)
        logger.error("terminal_tool exception:\n%s", tb_str)
        return json.dumps({
            "output": "",
            "exit_code": -1,
            "error": f"Failed to execute command: {safe_error}",
            "traceback": tb_str,
            "status": "error"
        }, ensure_ascii=False)


def check_terminal_requirements() -> bool:
    """Local execution has no external requirements (the remote/container
    backends were removed — commands always run on the host)."""
    return True


if __name__ == "__main__":
    # Simple test when run directly
    print("Terminal Tool Module")
    print("=" * 50)
    
    config = _get_env_config()
    print("\nCurrent Configuration:")
    print(f"  Environment type: {config['env_type']}")
    print(f"  Working directory: {config['cwd']}")
    print(f"  Default timeout: {config['timeout']}s")
    print(f"  Lifetime: {config['lifetime_seconds']}s")

    print("\nAvailable Tool:")
    print("  - terminal_tool: Execute commands locally")

    print("\nUsage Examples:")
    print("  # Execute a command")
    print("  result = terminal_tool(command='ls -la')")
    print("  ")
    print("  # Run a background task")
    print("  result = terminal_tool(command='python server.py', background=True)")

    print("\nEnvironment Variables:")
    print(f"  TERMINAL_CWD: {os.getenv('TERMINAL_CWD', _safe_getcwd())}")
    from fan_constants import display_fan_home as _dhh
    print(f"  TERMINAL_SANDBOX_DIR: {os.getenv('TERMINAL_SANDBOX_DIR', f'{_dhh()}/sandboxes')}")
    print(f"  TERMINAL_TIMEOUT: {os.getenv('TERMINAL_TIMEOUT', '60')}")
    print(f"  TERMINAL_LIFETIME_SECONDS: {os.getenv('TERMINAL_LIFETIME_SECONDS', '300')}")


# ---------------------------------------------------------------------------
# Registry
# ---------------------------------------------------------------------------
from tools.registry import registry

TERMINAL_SCHEMA = {
    "name": "terminal",
    "description": TERMINAL_TOOL_DESCRIPTION,
    "parameters": {
        "type": "object",
        "properties": {
            "command": {
                "type": "string",
                "description": "The command to execute on the VM"
            },
            "background": {
                "type": "boolean",
                "description": "Run the command in the background. Almost always pair with notify_on_complete=true — without it, the process runs silently and you'll have no way to learn it finished short of calling process(action='poll') yourself (easy to forget, leading to silent blindness on long jobs). Two legitimate patterns: (1) Long-lived processes that never exit (servers, watchers, daemons) — these stay silent because there's no exit to notify on. (2) Long-running bounded tasks (tests, builds, deploys, CI pollers, batch jobs) — these MUST set notify_on_complete=true. For short commands, prefer foreground with a generous timeout instead.",
                "default": False
            },
            "timeout": {
                "type": "integer",
                "description": f"Max seconds to wait (default: 180, foreground max: {FOREGROUND_MAX_TIMEOUT}). Returns INSTANTLY when command finishes — set high for long tasks, you won't wait unnecessarily. Foreground timeout above {FOREGROUND_MAX_TIMEOUT}s is rejected; use background=true for longer commands.",
                "minimum": 1
            },
            "workdir": {
                "type": "string",
                "description": "Working directory for this command (absolute path). Defaults to the session working directory."
            },
            "pty": {
                "type": "boolean",
                "description": "Run in pseudo-terminal (PTY) mode for interactive CLI tools like Codex, Claude Code, or Python REPL. Default: false.",
                "default": False
            },
            "notify_on_complete": {
                "type": "boolean",
                "description": "When true (and background=true), you'll be automatically notified exactly once when the process finishes. **This is the right choice for almost every long-running task** — tests, builds, deployments, multi-item batch jobs, anything that takes over a minute and has a defined end. Use this and keep working on other things; the system notifies you on exit. MUTUALLY EXCLUSIVE with watch_patterns — when both are set, watch_patterns is dropped.",
                "default": False
            },
            "watch_patterns": {
                "type": "array",
                "items": {"type": "string"},
                "description": "Strings to watch for in background process output. HARD RATE LIMIT: at most 1 notification per 15 seconds per process — matches arriving inside the cooldown are dropped. After 3 consecutive 15-second windows with dropped matches, watch_patterns is automatically disabled for that process and promoted to notify_on_complete behavior (one notification on exit, no more mid-process spam). USE ONLY for truly rare, one-shot mid-process signals on LONG-LIVED processes that will never exit on their own — e.g. ['Application startup complete'] on a server so you know when to hit its endpoint, or ['migration done'] on a daemon. DO NOT use for: (1) end-of-run markers like 'DONE'/'PASS' — use notify_on_complete instead; (2) error patterns like 'ERROR'/'Traceback' in loops or multi-item batch jobs — they fire on every iteration and you'll hit the strike limit fast; (3) anything you'd ever combine with notify_on_complete. When in doubt, choose notify_on_complete. MUTUALLY EXCLUSIVE with notify_on_complete — set one, not both."
            }
        },
        "required": ["command"]
    }
}


def _handle_terminal(args, **kw):
    return terminal_tool(
        command=args.get("command"),
        background=args.get("background", False),
        timeout=args.get("timeout"),
        task_id=kw.get("task_id"),
        workdir=args.get("workdir"),
        pty=args.get("pty", False),
        notify_on_complete=args.get("notify_on_complete", False),
        watch_patterns=args.get("watch_patterns"),
    )


registry.register(
    name="terminal",
    toolset="terminal",
    schema=TERMINAL_SCHEMA,
    handler=_handle_terminal,
    check_fn=check_terminal_requirements,
    emoji="💻",
    max_result_size_chars=100_000,
)
