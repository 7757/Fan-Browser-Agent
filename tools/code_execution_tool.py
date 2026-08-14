#!/usr/bin/env python3
"""
Code Execution Tool -- Programmatic Tool Calling (PTC)

Lets the LLM write a Python script that calls Fan tools via RPC,
collapsing multi-step tool chains into a single inference turn.

Architecture (two transports):

  **Local backend (UDS):**
  1. Parent generates a `fan_tools.py` stub module with UDS RPC functions
  2. Parent opens a Unix domain socket and starts an RPC listener thread
  3. Parent spawns a child process that runs the LLM's script
  4. Tool calls travel over the UDS back to the parent for dispatch

  **Remote backends (file-based RPC):**
  1. Parent generates `fan_tools.py` with file-based RPC stubs
  2. Parent ships both files to the remote environment
  3. Script runs inside the terminal backend (Docker/SSH/Modal/Daytona/etc.)
  4. Tool calls are written as request files; a polling thread on the parent
     reads them via env.execute(), dispatches, and writes response files
  5. The script polls for response files and continues

In both cases, only the script's stdout is returned to the LLM; intermediate
tool results never enter the context window.

Platform: Linux / macOS only (Unix domain sockets for local). Disabled on Windows.
Remote execution additionally requires Python 3 in the terminal backend.
"""

import base64
import functools
import json
import logging
import os
import platform
import secrets
import shlex
import socket
import subprocess
import sys
import tempfile
import threading
import time
import uuid

_IS_WINDOWS = platform.system() == "Windows"
from typing import Any, Dict, List, Optional

from tools.thread_context import propagate_context_to_thread

# Availability gate.  On Windows we fall back to loopback TCP for the
# sandbox RPC transport (AF_UNIX is unreliable on Windows Python) — see
# ``_use_tcp_rpc`` in ``_execute_local`` below.  That makes execute_code
# available on every platform Fan itself runs on.
logger = logging.getLogger(__name__)

SANDBOX_AVAILABLE = True

# Tools allowed inside the sandbox. The intersection of this list
# and the session's enabled tools determines which stubs are generated.
SANDBOX_ALLOWED_TOOLS = frozenset([
    "read_file",
    "write_file",
    "search_files",
    "patch",
    "terminal",
])

# Resource limit defaults (overridable via config.yaml → code_execution.*)
DEFAULT_TIMEOUT = 300        # 5 minutes
DEFAULT_MAX_TOOL_CALLS = 50
MAX_STDOUT_BYTES = 50_000    # 50 KB
MAX_STDERR_BYTES = 10_000    # 10 KB

# Environment variable scrubbing rules (shared between the local + remote
# backends).  Secret-substring block is applied first; anything left must
# match a safe prefix, the operational FAN_ allowlist, or (on Windows) an
# OS-essential name.
#
# NB: the broad "FAN_" prefix was deliberately removed (#27303) — it leaked
# FAN_*-named config that lacks a secret substring (e.g. FAN_BASE_URL,
# FAN_KANBAN_DB, FAN_*_WEBHOOK).  The child only needs the few
# runtime-location vars in _FAN_CHILD_ALLOWED below; FAN_RPC_SOCKET /
# FAN_RPC_DIR / TZ / HOME are injected explicitly after scrubbing.
_SAFE_ENV_PREFIXES = ("PATH", "HOME", "USER", "LANG", "LC_", "TERM",
                      "TMPDIR", "TMP", "TEMP", "SHELL", "LOGNAME",
                      "XDG_", "PYTHONPATH", "VIRTUAL_ENV", "CONDA")
_SECRET_SUBSTRINGS = ("KEY", "TOKEN", "SECRET", "PASSWORD", "CREDENTIAL",
                      "PASSWD", "AUTH", "DSN", "WEBHOOK", "CREDS",
                      "BEARER", "APIKEY")

# Operational FAN_* vars the child legitimately needs by exact name — these
# are non-secret runtime-location flags (the same set fan_cli treats as the
# runtime location) that repo-root modules a sandbox script imports may read at
# import time.  None match _SECRET_SUBSTRINGS.
_FAN_CHILD_ALLOWED = frozenset({
    "FAN_HOME",
    "FAN_CONFIG",
    "FAN_ENV",
})

# Windows-only: a handful of variables are required by the OS/CRT itself.
# Without them, even stdlib calls like ``socket.socket()`` fail with
# WinError 10106 (Winsock can't locate mswsock.dll) and ``subprocess``
# can't resolve cmd.exe.  These are well-known OS paths, not secrets, so
# we allow them through by exact name.  The _SECRET_SUBSTRINGS block
# still runs as a safety net (none of these names match those substrings).
_WINDOWS_ESSENTIAL_ENV_VARS = frozenset({
    "SYSTEMROOT",       # %SYSTEMROOT%\System32 — Winsock needs this
    "SYSTEMDRIVE",      # C: (or wherever Windows lives)
    "WINDIR",           # usually same as SYSTEMROOT
    "COMSPEC",          # cmd.exe path — subprocess shell=True needs it
    "PATHEXT",          # .COM;.EXE;.BAT;... — shell lookup
    "OS",               # "Windows_NT" — some tools gate on this
    "PROCESSOR_ARCHITECTURE",
    "NUMBER_OF_PROCESSORS",
    "PUBLIC",           # C:\Users\Public
    "ALLUSERSPROFILE",  # C:\ProgramData — some stdlib paths use it
    "PROGRAMDATA",      # C:\ProgramData
    "PROGRAMFILES",
    "PROGRAMFILES(X86)",
    "PROGRAMW6432",
    "APPDATA",          # %USERPROFILE%\AppData\Roaming — Python uses it
    "LOCALAPPDATA",     # %USERPROFILE%\AppData\Local
    "USERPROFILE",      # C:\Users\<name> — Python's expanduser uses it
    "USERDOMAIN",
    "USERNAME",
    "HOMEDRIVE",        # C:
    "HOMEPATH",         # \Users\<name>
    "COMPUTERNAME",
})


def _scrub_child_env(source_env, is_passthrough=None, is_windows=None):
    """Produce the scrubbed child-process env for execute_code.

    Rules (order matters):
      1. Passthrough vars (skill- or config-declared) always pass.
      2. Secret-substring names (KEY/TOKEN/DSN/WEBHOOK/etc.) are blocked.
      3. Names matching a safe prefix pass.
      4. Operational FAN_* vars (_FAN_CHILD_ALLOWED) pass by exact name.
      5. On Windows, a small OS-essential allowlist passes by exact name
         — without these the child can't even create a socket or spawn a
         subprocess.

    Extracted into a helper so tests can exercise the logic without
    spawning a subprocess.
    """
    if is_passthrough is None:
        try:
            from tools.env_passthrough import is_env_passthrough as _ep
        except Exception:
            _ep = lambda _: False  # noqa: E731
        is_passthrough = _ep
    if is_windows is None:
        is_windows = _IS_WINDOWS

    scrubbed = {}
    # Non-secret FAN_* vars dropped by the tightened allowlist (#27303). The
    # broad "FAN_" prefix used to pass these through; now only the
    # operational set does. The drop is intentional (those vars can carry
    # config like FAN_KANBAN_DB / FAN_BASE_URL), but a sandbox script
    # that imports a repo module reading one at import time would otherwise see
    # it silently unset. Surface the drop once so the behavior change is
    # diagnosable and points at the env_passthrough opt-in escape hatch.
    _dropped_fan = []
    for k, v in source_env.items():
        if is_passthrough(k):
            scrubbed[k] = v
            continue
        if any(s in k.upper() for s in _SECRET_SUBSTRINGS):
            continue
        if any(k.startswith(p) for p in _SAFE_ENV_PREFIXES):
            scrubbed[k] = v
            continue
        if k in _FAN_CHILD_ALLOWED:
            scrubbed[k] = v
            continue
        if is_windows and k.upper() in _WINDOWS_ESSENTIAL_ENV_VARS:
            scrubbed[k] = v
            continue
        if k.startswith("FAN_"):
            # Non-secret (secrets were already dropped above) and not in any
            # allowlist — a deliberately-dropped FAN_* var.
            _dropped_fan.append(k)
    if _dropped_fan:
        logger.debug(
            "execute_code: dropped %d non-allowlisted FAN_* var(s) from the "
            "sandbox child env (%s). This is intentional hardening (#27303); if "
            "a sandbox script legitimately needs one, declare it via "
            "env_passthrough in the skill/config so it passes by explicit opt-in.",
            len(_dropped_fan),
            ", ".join(sorted(_dropped_fan)),
        )
    return scrubbed


def check_sandbox_requirements() -> bool:
    """Code execution sandbox requires a POSIX OS for Unix domain sockets."""
    if not SANDBOX_AVAILABLE:
        return False
    return True


# ---------------------------------------------------------------------------
# fan_tools.py code generator
# ---------------------------------------------------------------------------

# Per-tool stub templates: (function_name, signature, docstring, args_dict_expr)
# The args_dict_expr builds the JSON payload sent over the RPC socket.
_TOOL_STUBS = {
    "read_file": (
        "read_file",
        "path: str, offset: int = 1, limit: int = 500",
        '"""Read a file (1-indexed lines). Returns dict with "content" and "total_lines"."""',
        '{"path": path, "offset": offset, "limit": limit}',
    ),
    "write_file": (
        "write_file",
        "path: str, content: str",
        '"""Write content to a file (always overwrites). Returns dict with status."""',
        '{"path": path, "content": content}',
    ),
    "search_files": (
        "search_files",
        'pattern: str, target: str = "content", path: str = ".", file_glob: str = None, limit: int = 50, offset: int = 0, output_mode: str = "content", context: int = 0',
        '"""Search file contents (target="content") or find files by name (target="files"). Returns dict with "matches"."""',
        '{"pattern": pattern, "target": target, "path": path, "file_glob": file_glob, "limit": limit, "offset": offset, "output_mode": output_mode, "context": context}',
    ),
    "patch": (
        "patch",
        'path: str = None, old_string: str = None, new_string: str = None, replace_all: bool = False, mode: str = "replace", patch: str = None',
        '"""Targeted find-and-replace (mode="replace") or V4A multi-file patches (mode="patch"). Returns dict with status."""',
        '{"path": path, "old_string": old_string, "new_string": new_string, "replace_all": replace_all, "mode": mode, "patch": patch}',
    ),
    "terminal": (
        "terminal",
        "command: str, timeout: int = None, workdir: str = None",
        '"""Run a shell command (foreground only). Returns dict with "output" and "exit_code"."""',
        '{"command": command, "timeout": timeout, "workdir": workdir}',
    ),
}


def generate_fan_tools_module(enabled_tools: List[str],
                                 transport: str = "uds") -> str:
    """
    Build the source code for the fan_tools.py stub module.

    Only tools in both SANDBOX_ALLOWED_TOOLS and enabled_tools get stubs.

    Args:
        enabled_tools: Tool names enabled in the current session.
        transport: kept for signature compatibility — only ``"uds"``
            (local Unix domain socket) exists now; the file-based RPC
            transport went away with the remote backends.
    """
    tools_to_generate = sorted(SANDBOX_ALLOWED_TOOLS & set(enabled_tools))

    stub_functions = []
    export_names = []
    for tool_name in tools_to_generate:
        if tool_name not in _TOOL_STUBS:
            continue
        func_name, sig, doc, args_expr = _TOOL_STUBS[tool_name]
        stub_functions.append(
            f"def {func_name}({sig}):\n"
            f"    {doc}\n"
            f"    return _call({func_name!r}, {args_expr})\n"
        )
        export_names.append(func_name)

    return _UDS_TRANSPORT_HEADER + "\n".join(stub_functions)


# ---- Shared helpers section (embedded in both transport headers) ----------

_COMMON_HELPERS = '''\

# ---------------------------------------------------------------------------
# Convenience helpers (avoid common scripting pitfalls)
# ---------------------------------------------------------------------------

def json_parse(text: str):
    """Parse JSON tolerant of control characters (strict=False).
    Use this instead of json.loads() when parsing terminal output that may
    contain raw tabs/newlines in strings."""
    return json.loads(text, strict=False)


def shell_quote(s: str) -> str:
    """Shell-escape a string for safe interpolation into commands.
    Use this when inserting dynamic content into terminal() commands:
        terminal(f"echo {shell_quote(user_input)}")
    """
    return shlex.quote(s)


def retry(fn, max_attempts=3, delay=2):
    """Retry a function up to max_attempts times with exponential backoff.
    Use for transient failures (network errors, API rate limits):
        result = retry(lambda: terminal("gh issue list ..."))
    """
    last_err = None
    for attempt in range(max_attempts):
        try:
            return fn()
        except Exception as e:
            last_err = e
            if attempt < max_attempts - 1:
                time.sleep(delay * (2 ** attempt))
    raise last_err

'''

# ---- UDS transport (local backend) ---------------------------------------

_UDS_TRANSPORT_HEADER = '''\
"""Auto-generated Fan tools RPC stubs."""
import json, os, socket, shlex, threading, time

_sock = None
# The RPC server handles a single client connection serially and has no
# request-id in the protocol, so concurrent _call() invocations from multiple
# threads (e.g. ThreadPoolExecutor) would race on the shared socket and get
# each other's responses. Serialize the entire send+recv round-trip.
_call_lock = threading.Lock()
''' + _COMMON_HELPERS + '''\

def _connect():
    """Connect to the parent's RPC server via the transport it picked.

    FAN_RPC_SOCKET can be either:
      - a filesystem path (POSIX Unix domain socket — the default on
        Linux and macOS)
      - a string of the form ``tcp://127.0.0.1:<port>`` (Windows, where
        AF_UNIX is unreliable — the parent falls back to loopback TCP)
    """
    global _sock
    if _sock is None:
        endpoint = os.environ["FAN_RPC_SOCKET"]
        if endpoint.startswith("tcp://"):
            # tcp://host:port  (host is always 127.0.0.1 in practice — we
            # only bind loopback server-side)
            _host_port = endpoint[len("tcp://"):]
            _host, _, _port = _host_port.rpartition(":")
            _sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            _sock.connect((_host or "127.0.0.1", int(_port)))
        else:
            _sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            _sock.connect(endpoint)
        _sock.settimeout(300)
    return _sock

def _call(tool_name, args):
    """Send a tool call to the parent process and return the parsed result."""
    request = json.dumps({
        "tool": tool_name,
        "args": args,
        "token": os.environ.get("FAN_RPC_TOKEN", ""),
    }) + "\\n"
    with _call_lock:
        conn = _connect()
        conn.sendall(request.encode())
        buf = b""
        while True:
            chunk = conn.recv(65536)
            if not chunk:
                raise RuntimeError("Agent process disconnected")
            buf += chunk
            if buf.endswith(b"\\n"):
                break
    raw = buf.decode().strip()
    result = json.loads(raw)
    if isinstance(result, str):
        try:
            return json.loads(result)
        except (json.JSONDecodeError, TypeError):
            return result
    return result

'''

# ---------------------------------------------------------------------------
# RPC server (runs in a thread inside the parent process)
# ---------------------------------------------------------------------------

# Terminal parameters that must not be used from ephemeral sandbox scripts
_TERMINAL_BLOCKED_PARAMS = {"background", "pty", "notify_on_complete", "watch_patterns"}


def _rpc_server_loop(
    server_sock: socket.socket,
    task_id: str,
    tool_call_log: list,
    tool_call_counter: list,   # mutable [int] so the thread can increment
    max_tool_calls: int,
    allowed_tools: frozenset,
    stop_event: threading.Event,
    rpc_token: str,
):
    """
    Accept one client connection and dispatch tool-call requests until
    the client disconnects or the call limit is reached.
    """
    from model_tools import handle_function_call

    conn = None
    try:
        server_sock.settimeout(0.05)
        while not stop_event.is_set():
            try:
                conn, _ = server_sock.accept()
                break
            except socket.timeout:
                continue
        if conn is None:
            return
        conn.settimeout(300)

        buf = b""
        while True:
            try:
                chunk = conn.recv(65536)
            except socket.timeout:
                break
            if not chunk:
                break
            buf += chunk

            # Process all complete newline-delimited messages in the buffer
            while b"\n" in buf:
                line, buf = buf.split(b"\n", 1)
                line = line.strip()
                if not line:
                    continue

                call_start = time.monotonic()
                try:
                    request = json.loads(line.decode())
                except (json.JSONDecodeError, UnicodeDecodeError) as exc:
                    resp = tool_error(f"Invalid RPC request: {exc}")
                    conn.sendall((resp + "\n").encode())
                    continue

                if not rpc_token or not secrets.compare_digest(
                    str(request.get("token") or ""), rpc_token
                ):
                    conn.sendall((json.dumps({"error": "Unauthorized RPC request"}) + "\n").encode())
                    continue

                tool_name = request.get("tool", "")
                tool_args = request.get("args", {})

                # Enforce the allow-list
                if tool_name not in allowed_tools:
                    available = ", ".join(sorted(allowed_tools))
                    resp = json.dumps({
                        "error": (
                            f"Tool '{tool_name}' is not available in execute_code. "
                            f"Available: {available}"
                        )
                    })
                    conn.sendall((resp + "\n").encode())
                    continue

                # Enforce tool call limit
                if tool_call_counter[0] >= max_tool_calls:
                    resp = json.dumps({
                        "error": (
                            f"Tool call limit reached ({max_tool_calls}). "
                            "No more tool calls allowed in this execution."
                        )
                    })
                    conn.sendall((resp + "\n").encode())
                    continue

                # Strip forbidden terminal parameters
                if tool_name == "terminal" and isinstance(tool_args, dict):
                    for param in _TERMINAL_BLOCKED_PARAMS:
                        tool_args.pop(param, None)

                # Dispatch through the standard tool handler.
                # Suppress stdout/stderr from internal tool handlers so
                # their status prints don't leak into the CLI spinner.
                try:
                    _real_stdout, _real_stderr = sys.stdout, sys.stderr
                    devnull = open(os.devnull, "w", encoding="utf-8")
                    try:
                        sys.stdout = devnull
                        sys.stderr = devnull
                        result = handle_function_call(
                            tool_name,
                            tool_args,
                            task_id=task_id,
                            result_mode="structured",
                        )
                    finally:
                        sys.stdout, sys.stderr = _real_stdout, _real_stderr
                        devnull.close()
                except Exception as exc:
                    logger.error("Tool call failed in sandbox: %s", exc, exc_info=True)
                    result = tool_error(str(exc))

                tool_call_counter[0] += 1
                call_duration = time.monotonic() - call_start

                # Log for observability
                args_preview = str(tool_args)[:80]
                tool_call_log.append({
                    "tool": tool_name,
                    "args_preview": args_preview,
                    "duration": round(call_duration, 2),
                })

                conn.sendall((result + "\n").encode())

    except socket.timeout:
        logger.debug("RPC listener socket timeout")
    except OSError as e:
        logger.debug("RPC listener socket error: %s", e, exc_info=True)
    finally:
        if conn:
            try:
                conn.close()
            except OSError as e:
                logger.debug("RPC conn close error: %s", e)


# ---------------------------------------------------------------------------
# Remote execution support (file-based RPC via terminal backend)
# ---------------------------------------------------------------------------

def _get_or_create_env(task_id: str):
    """Get or create the terminal environment for *task_id*.

    Reuses the same environment (container/sandbox/SSH session) that the
    terminal and file tools use, creating one if it doesn't exist yet.
    Returns ``(env, env_type)`` tuple.
    """
    from tools.terminal_tool import (
        _active_environments, _env_lock, _create_environment,
        _get_env_config, _last_activity, _start_cleanup_thread,
        _creation_locks, _creation_locks_lock, _task_env_overrides,
        _resolve_container_task_id,
    )

    effective_task_id = _resolve_container_task_id(task_id)

    # Fast path: environment already exists
    with _env_lock:
        if effective_task_id in _active_environments:
            _last_activity[effective_task_id] = time.time()
            return _active_environments[effective_task_id], _get_env_config()["env_type"]

    # Slow path: create environment (same pattern as file_tools._get_file_ops)
    with _creation_locks_lock:
        if effective_task_id not in _creation_locks:
            _creation_locks[effective_task_id] = threading.Lock()
        task_lock = _creation_locks[effective_task_id]

    with task_lock:
        with _env_lock:
            if effective_task_id in _active_environments:
                _last_activity[effective_task_id] = time.time()
                return _active_environments[effective_task_id], _get_env_config()["env_type"]

        config = _get_env_config()
        env_type = config["env_type"]
        overrides = _task_env_overrides.get(effective_task_id, {})

        # Local-only execution: remote/container backends were removed.
        cwd = overrides.get("cwd") or config["cwd"]
        local_config = {
            "persistent": config.get("local_persistent", False),
        }

        logger.info("Creating new %s environment for execute_code task %s...",
                     env_type, effective_task_id[:8])
        env = _create_environment(
            env_type=env_type,
            cwd=cwd,
            timeout=config["timeout"],
            local_config=local_config,
            task_id=effective_task_id,
        )

        with _env_lock:
            _active_environments[effective_task_id] = env
            _last_activity[effective_task_id] = time.time()

        _start_cleanup_thread()
        logger.info("%s environment ready for execute_code task %s",
                     env_type, effective_task_id[:8])
        return env, env_type




# ---------------------------------------------------------------------------
# Main entry point
# ---------------------------------------------------------------------------

def execute_code(
    code: str,
    task_id: Optional[str] = None,
    enabled_tools: Optional[List[str]] = None,
) -> str:
    """
    Run a Python script in a sandboxed child process with RPC access
    to a subset of Fan tools.

    Dispatches to the local (UDS) or remote (file-based RPC) path
    depending on the configured terminal backend.

    Args:
        code:          Python source code to execute.
        task_id:       Session task ID for tool isolation (terminal env, etc.).
        enabled_tools: Tool names enabled in the current session. The sandbox
                       gets the intersection with SANDBOX_ALLOWED_TOOLS.

    Returns:
        JSON string with execution results.
    """
    if not SANDBOX_AVAILABLE:
        return json.dumps({
            "error": "execute_code sandbox is unavailable in this environment. "
                     "Use normal tool calls (terminal, read_file, write_file, ...) instead."
        })

    if not code or not code.strip():
        return tool_error("No code provided.")

    # Local-only execution (remote/container backends were removed).
    env_type = "local"

    # execute_code runs arbitrary Python (subprocess/os.system/...) that never
    # passes through terminal()/DANGEROUS_PATTERNS, so guard the whole script
    # here before spawning it. Runs synchronously in the caller
    # (tool-executor) thread, which holds the session context (#30882).
    from tools.approval import check_execute_code_guard
    _guard = check_execute_code_guard(code, env_type)
    if not _guard.get("approved", False):
        return json.dumps({
            "status": "error",
            "error": _guard.get("message") or "execute_code blocked by approval guard.",
            "tool_calls_made": 0,
            "duration_seconds": 0,
        }, ensure_ascii=False)

    # The approval wait may have left an interrupt bit on this executor
    # thread. Clear it immediately before the approved child is spawned so a
    # stale Stop cannot cancel the newly authorized script on its first poll.
    if _guard.get("user_approved"):
        from tools.interrupt import clear_current_thread_interrupt

        clear_current_thread_interrupt()

    # --- Local execution path (UDS) ---

    # Import per-thread interrupt check (cooperative cancellation)
    from tools.interrupt import is_interrupted as _is_interrupted

    # Resolve config
    _cfg = _load_config()
    timeout = _cfg.get("timeout", DEFAULT_TIMEOUT)
    max_tool_calls = _cfg.get("max_tool_calls", DEFAULT_MAX_TOOL_CALLS)

    # Determine which tools the sandbox can call
    if enabled_tools is None:
        sandbox_tools = SANDBOX_ALLOWED_TOOLS
    else:
        session_tools = set(enabled_tools)
        sandbox_tools = frozenset(SANDBOX_ALLOWED_TOOLS & session_tools)

    # --- Set up temp directory with fan_tools.py and script.py ---
    tmpdir = tempfile.mkdtemp(prefix="fan_sandbox_")
    # Use /tmp on macOS to avoid the long /var/folders/... path that pushes
    # Unix domain socket paths past the 104-byte macOS AF_UNIX limit.
    # On Linux, tempfile.gettempdir() already returns /tmp.
    #
    # Windows: Python 3.9+ added partial AF_UNIX support but the file-backed
    # variant is flaky across Windows builds (requires Windows 10 1803+,
    # still fails under some configurations, and the socket file can't live
    # on the same temp drive as the script).  Fall back to loopback TCP —
    # same ephemeral port, same 1-connection listen queue, same serialized
    # request/response framing.  The generated client reads the transport
    # selector from FAN_RPC_SOCKET (path vs. ``tcp://host:port``).
    _sock_tmpdir = "/tmp" if sys.platform == "darwin" else tempfile.gettempdir()
    _use_tcp_rpc = _IS_WINDOWS
    if _use_tcp_rpc:
        sock_path = None  # not used on Windows; TCP endpoint stored below
        rpc_endpoint = None  # set after bind()
    else:
        sock_path = os.path.join(_sock_tmpdir, f"fan_rpc_{uuid.uuid4().hex}.sock")
        rpc_endpoint = sock_path

    tool_call_log: list = []
    tool_call_counter = [0]  # mutable so the RPC thread can increment
    exec_start = time.monotonic()
    server_sock = None
    stop_event = threading.Event()
    rpc_token = secrets.token_urlsafe(32)

    try:
        # Write the auto-generated fan_tools module.
        # encoding="utf-8" is required on Windows — the stub and user code
        # both contain non-ASCII characters (em-dashes in docstrings, plus
        # whatever the user script carries).  Python's default open() uses
        # the system locale on Windows (cp1252 typically), which corrupts
        # those bytes; the child then fails to import with a SyntaxError
        # ("'utf-8' codec can't decode byte 0x97 in position ...") because
        # Python source files are decoded as UTF-8 by default (PEP 3120).
        # sandbox_tools is the exact intersection with this session's grants.
        # Only callers omitting enabled_tools receive the compatibility default.
        tools_src = generate_fan_tools_module(list(sandbox_tools))
        with open(os.path.join(tmpdir, "fan_tools.py"), "w", encoding="utf-8") as f:
            f.write(tools_src)

        # Write the user's script
        with open(os.path.join(tmpdir, "script.py"), "w", encoding="utf-8") as f:
            f.write(code)

        # --- Start RPC server ---
        # Two transports:
        #   POSIX: AF_UNIX stream socket on sock_path, chmod 0600 for
        #   owner-only access.  Filesystem permissions gate the socket.
        #   Windows: AF_INET stream socket on 127.0.0.1 with an ephemeral
        #   port.  No filesystem permission story, but loopback-only bind
        #   means only the current user's processes (not remote) can
        #   connect.  FAN_RPC_SOCKET is set to ``tcp://127.0.0.1:<port>``
        #   which the generated client parses to pick AF_INET.
        if _use_tcp_rpc:
            server_sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            server_sock.bind(("127.0.0.1", 0))  # ephemeral port
            _host, _port = server_sock.getsockname()[:2]
            rpc_endpoint = f"tcp://{_host}:{_port}"
        else:
            server_sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            server_sock.bind(sock_path)
            os.chmod(sock_path, 0o600)
        server_sock.listen(1)

        # Wrapped so the thread inherits the turn's approval context + callbacks
        # (see tools.thread_context) — else gateway sandbox tool calls silently
        # auto-approve dangerous commands (#33057, #30882).
        rpc_thread = threading.Thread(
            target=propagate_context_to_thread(_rpc_server_loop),
            args=(
                server_sock, task_id, tool_call_log,
                tool_call_counter, max_tool_calls, sandbox_tools, stop_event, rpc_token,
            ),
            daemon=True,
        )
        rpc_thread.start()

        # --- Spawn child process ---
        # Build a minimal environment for the child. We intentionally exclude
        # API keys and tokens to prevent credential exfiltration from LLM-
        # generated scripts. The child accesses tools via RPC, not direct API.
        # Exception: env vars declared by loaded skills (via env_passthrough
        # registry) or explicitly allowed by the user in config.yaml
        # (terminal.env_passthrough) are passed through.  On Windows, a small
        # OS-essential allowlist (SYSTEMROOT, WINDIR, COMSPEC, ...) is also
        # passed through — without those, the child can't create a socket
        # or spawn a subprocess.  See ``_scrub_child_env`` for the rules.
        child_env = _scrub_child_env(os.environ)
        child_env["FAN_RPC_SOCKET"] = rpc_endpoint
        child_env["FAN_RPC_TOKEN"] = rpc_token
        child_env["PYTHONDONTWRITEBYTECODE"] = "1"
        # Force UTF-8 for the child's stdio and default file encoding.
        #
        # Without this, on Windows sys.stdout is bound to the console code
        # page (cp1252 on US-locale installs), and any script that does
        # ``print("café")`` or ``print("→")`` crashes with:
        #
        #   UnicodeEncodeError: 'charmap' codec can't encode character
        #   '\u2192' in position N: character maps to <undefined>
        #
        # PYTHONIOENCODING fixes sys.stdin/stdout/stderr.
        # PYTHONUTF8=1 enables "UTF-8 mode" (PEP 540) which additionally
        # makes ``open()``'s default encoding UTF-8, so user scripts that
        # write files without specifying encoding= also work correctly.
        #
        # On POSIX both values usually match the locale default already,
        # so setting them is harmless belt-and-suspenders for environments
        # with a C/POSIX locale (containers, minimal base images).
        child_env["PYTHONIOENCODING"] = "utf-8"
        child_env["PYTHONUTF8"] = "1"
        # Ensure the fan-agent root is importable in the sandbox so
        # repo-root modules are available to child scripts.  We also prepend
        # the staging tmpdir so ``from fan_tools import ...`` resolves even
        # when the subprocess CWD is not tmpdir (project mode).
        _fan_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        _existing_pp = child_env.get("PYTHONPATH", "")
        _pp_parts = [tmpdir, _fan_root]
        if _existing_pp:
            _pp_parts.append(_existing_pp)
        child_env["PYTHONPATH"] = os.pathsep.join(_pp_parts)
        # Inject user's configured timezone so datetime.now() in sandboxed
        # code reflects the correct wall-clock time.  Only TZ is set —
        # FAN_TIMEZONE is an internal Fan setting and must not leak
        # into child processes.
        _tz_name = os.getenv("FAN_TIMEZONE", "").strip()
        if _tz_name:
            child_env["TZ"] = _tz_name
        child_env.pop("FAN_TIMEZONE", None)

        # Fan-managed HOME isolation: redirect system tool configs into
        # {FAN_HOME}/home/ when that directory exists.
        from fan_constants import get_subprocess_home
        _subprocess_home = get_subprocess_home()
        if _subprocess_home:
            child_env["HOME"] = _subprocess_home

        # Resolve interpreter + CWD based on execute_code mode.
        #   - strict : today's behavior (sys.executable + tmpdir CWD).
        #   - project: user's venv python + session's working directory, so
        #              project deps like pandas and user files resolve.
        # Env scrubbing and tool whitelist apply identically in both modes.
        _mode = _get_execution_mode()
        _child_python = _resolve_child_python(_mode)
        _child_cwd = _resolve_child_cwd(_mode, tmpdir)
        _script_path = os.path.join(tmpdir, "script.py")

        from agent.file_safety import wrap_agent_subprocess_argv

        proc = subprocess.Popen(
            wrap_agent_subprocess_argv([_child_python, _script_path]),
            cwd=_child_cwd,
            env=child_env,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            stdin=subprocess.DEVNULL,
            start_new_session=True,
            creationflags=subprocess.CREATE_NO_WINDOW if _IS_WINDOWS else 0,
        )

        # --- Poll loop: watch for exit, timeout, and interrupt ---
        deadline = time.monotonic() + timeout
        stderr_chunks: list = []

        # Background readers to avoid pipe buffer deadlocks.
        # For stdout we use a head+tail strategy: keep the first HEAD_BYTES
        # and a rolling window of the last TAIL_BYTES so the final print()
        # output is never lost.  Stderr keeps head-only (errors appear early).
        _STDOUT_HEAD_BYTES = int(MAX_STDOUT_BYTES * 0.4)   # 40% head
        _STDOUT_TAIL_BYTES = MAX_STDOUT_BYTES - _STDOUT_HEAD_BYTES  # 60% tail

        def _drain(pipe, chunks, max_bytes):
            """Simple head-only drain (used for stderr)."""
            total = 0
            try:
                while True:
                    data = pipe.read(4096)
                    if not data:
                        break
                    if total < max_bytes:
                        keep = max_bytes - total
                        chunks.append(data[:keep])
                    total += len(data)
            except (ValueError, OSError) as e:
                logger.debug("Error reading process output: %s", e, exc_info=True)

        stdout_total_bytes = [0]  # mutable ref for total bytes seen

        def _drain_head_tail(pipe, head_chunks, tail_chunks, head_bytes, tail_bytes, total_ref):
            """Drain stdout keeping both head and tail data."""
            head_collected = 0
            from collections import deque
            tail_buf = deque()
            tail_collected = 0
            try:
                while True:
                    data = pipe.read(4096)
                    if not data:
                        break
                    total_ref[0] += len(data)
                    # Fill head buffer first
                    if head_collected < head_bytes:
                        keep = min(len(data), head_bytes - head_collected)
                        head_chunks.append(data[:keep])
                        head_collected += keep
                        data = data[keep:]  # remaining goes to tail
                        if not data:
                            continue
                    # Everything past head goes into rolling tail buffer
                    tail_buf.append(data)
                    tail_collected += len(data)
                    # Evict old tail data to stay within tail_bytes budget
                    while tail_collected > tail_bytes and tail_buf:
                        oldest = tail_buf.popleft()
                        tail_collected -= len(oldest)
            except (ValueError, OSError):
                pass
            # Transfer final tail to output list
            tail_chunks.extend(tail_buf)

        stdout_head_chunks: list = []
        stdout_tail_chunks: list = []

        stdout_reader = threading.Thread(
            target=_drain_head_tail,
            args=(proc.stdout, stdout_head_chunks, stdout_tail_chunks,
                  _STDOUT_HEAD_BYTES, _STDOUT_TAIL_BYTES, stdout_total_bytes),
            daemon=True
        )
        stderr_reader = threading.Thread(
            target=_drain, args=(proc.stderr, stderr_chunks, MAX_STDERR_BYTES), daemon=True
        )
        stdout_reader.start()
        stderr_reader.start()

        status = "success"
        _activity_state = {
            "last_touch": time.monotonic(),
            "start": exec_start,
        }
        try:
            from tools.environments.base import touch_activity_if_due
        except Exception:
            touch_activity_if_due = None
        poll_interval = 0.005
        while proc.poll() is None:
            if _is_interrupted():
                _kill_process_group(proc)
                status = "interrupted"
                break
            now = time.monotonic()
            if now > deadline:
                _kill_process_group(proc, escalate=True)
                status = "timeout"
                break
            # Periodic activity touch so the gateway's inactivity timeout
            # doesn't kill the agent during long code execution (#10807).
            if touch_activity_if_due is not None:
                try:
                    touch_activity_if_due(_activity_state, "execute_code running")
                except Exception:
                    pass
            try:
                proc.wait(timeout=min(poll_interval, max(0.0, deadline - now)))
            except subprocess.TimeoutExpired:
                pass
            poll_interval = min(0.2, poll_interval * 1.5)

        # Wait for readers to finish draining
        stdout_reader.join(timeout=3)
        stderr_reader.join(timeout=3)

        stdout_head = b"".join(stdout_head_chunks).decode("utf-8", errors="replace")
        stdout_tail = b"".join(stdout_tail_chunks).decode("utf-8", errors="replace")
        stderr_text = b"".join(stderr_chunks).decode("utf-8", errors="replace")

        # Assemble stdout with head+tail truncation
        total_stdout = stdout_total_bytes[0]
        if total_stdout > MAX_STDOUT_BYTES and stdout_tail:
            omitted = total_stdout - len(stdout_head) - len(stdout_tail)
            truncated_notice = (
                f"\n\n... [OUTPUT TRUNCATED - {omitted:,} chars omitted "
                f"out of {total_stdout:,} total] ...\n\n"
            )
            stdout_text = stdout_head + truncated_notice + stdout_tail
        else:
            stdout_text = stdout_head + stdout_tail

        exit_code = proc.returncode if proc.returncode is not None else -1
        duration = round(time.monotonic() - exec_start, 2)

        # Wait for RPC thread to finish
        stop_event.set()
        server_sock.close()  # break accept() so thread exits promptly
        server_sock = None  # prevent double close in finally
        rpc_thread.join(timeout=3)

        # Strip ANSI escape sequences so the model never sees terminal
        # formatting — prevents it from copying escapes into file writes.
        from tools.ansi_strip import strip_ansi
        stdout_text = strip_ansi(stdout_text)
        stderr_text = strip_ansi(stderr_text)

        # Redact secrets (API keys, tokens, etc.) from sandbox output.
        # The sandbox env-var filter (lines 434-454) blocks os.environ access,
        # but scripts can still read secrets from disk (e.g. open('~/.fan/.env')).
        # This ensures leaked secrets never enter the model context.
        from agent.redact import redact_sensitive_text
        stdout_text = redact_sensitive_text(stdout_text, code_file=True)
        stderr_text = redact_sensitive_text(stderr_text, code_file=True)

        # Build response
        result: Dict[str, Any] = {
            "status": status,
            "output": stdout_text,
            "tool_calls_made": tool_call_counter[0],
            "duration_seconds": duration,
        }

        if status == "timeout":
            timeout_msg = f"Script timed out after {timeout}s and was killed."
            result["error"] = timeout_msg
            # Include timeout message in output so the LLM always surfaces it
            # to the user.  When output is empty, models often treat the result
            # as "nothing happened" and produce an empty response, which the
            # gateway stream consumer silently drops (#10807).
            if stdout_text:
                result["output"] = stdout_text + f"\n\n⏰ {timeout_msg}"
            else:
                result["output"] = f"⏰ {timeout_msg}"
            logger.warning(
                "execute_code timed out after %ss (limit %ss) with %d tool calls",
                duration, timeout, tool_call_counter[0],
            )
        elif status == "interrupted":
            result["output"] = stdout_text + "\n[execution interrupted — user sent a new message]"
        elif exit_code != 0:
            result["status"] = "error"
            result["error"] = stderr_text or f"Script exited with code {exit_code}"
            # Include stderr in output so the LLM sees the traceback
            if stderr_text:
                result["output"] = stdout_text + "\n--- stderr ---\n" + stderr_text

        return json.dumps(result, ensure_ascii=False)

    except Exception as exc:
        duration = round(time.monotonic() - exec_start, 2)
        logger.error(
            "execute_code failed after %ss with %d tool calls: %s: %s",
            duration,
            tool_call_counter[0],
            type(exc).__name__,
            exc,
            exc_info=True,
        )
        return json.dumps({
            "status": "error",
            "error": str(exc),
            "tool_calls_made": tool_call_counter[0],
            "duration_seconds": duration,
        }, ensure_ascii=False)

    finally:
        # Cleanup temp dir and socket
        if server_sock is not None:
            try:
                server_sock.close()
            except OSError as e:
                logger.debug("Server socket close error: %s", e)
        import shutil
        shutil.rmtree(tmpdir, ignore_errors=True)
        try:
            # Only UDS has a filesystem socket to unlink; TCP sockets are
            # freed by server_sock.close() above.
            if sock_path:
                os.unlink(sock_path)
        except OSError:
            pass  # already cleaned up or never created


def _kill_process_group(proc, escalate: bool = False):
    """Kill the child and its entire process tree (cross-platform via psutil)."""
    import psutil
    try:
        parent = psutil.Process(proc.pid)
        children = parent.children(recursive=True)
        for child in children:
            try:
                child.terminate()
            except psutil.NoSuchProcess:
                pass
        try:
            parent.terminate()
        except psutil.NoSuchProcess:
            pass
    except psutil.NoSuchProcess:
        pass
    except (PermissionError, OSError) as e:
        logger.debug("Could not terminate process tree: %s", e, exc_info=True)
        try:
            proc.kill()
        except Exception as e2:
            logger.debug("Could not kill process: %s", e2, exc_info=True)

    if escalate:
        # Give the process 5s to exit after SIGTERM, then SIGKILL
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            try:
                parent = psutil.Process(proc.pid)
                for child in parent.children(recursive=True):
                    try:
                        child.kill()
                    except psutil.NoSuchProcess:
                        pass
                try:
                    parent.kill()
                except psutil.NoSuchProcess:
                    pass
            except psutil.NoSuchProcess:
                pass
            except (PermissionError, OSError) as e:
                logger.debug("Could not kill process tree: %s", e, exc_info=True)
                try:
                    proc.kill()
                except Exception as e2:
                    logger.debug("Could not kill process: %s", e2, exc_info=True)


def _load_config() -> dict:
    """Load code_execution config without importing the interactive CLI.

    This helper is called while building the module-level execute_code schema
    during tool discovery. Importing ``cli`` here pulls prompt_toolkit/Rich and
    a large chunk of the classic REPL onto every agent startup path. Read the
    lightweight raw config instead; the config layer already caches by (mtime,
    size), and an absent key cleanly falls back to DEFAULT_EXECUTION_MODE.
    """
    try:
        from fan_cli.config import read_raw_config

        cfg = read_raw_config().get("code_execution", {})
        return cfg if isinstance(cfg, dict) else {}
    except Exception:
        return {}


# ---------------------------------------------------------------------------
# Execution mode resolution (strict vs project)
# ---------------------------------------------------------------------------

# Valid values for code_execution.mode. Kept as a module constant so tests
# and the config layer can reference the canonical set.
EXECUTION_MODES = ("project", "strict")
DEFAULT_EXECUTION_MODE = "project"


def _get_execution_mode() -> str:
    """Return the active execute_code mode — 'project' or 'strict'.

    Reads ``code_execution.mode`` from config.yaml; invalid values fall back
    to ``DEFAULT_EXECUTION_MODE`` ('project') with a log warning.

    Mode semantics:
      - ``project`` (default): scripts run in the session's working directory
        with the active virtual environment's python, so project dependencies
        (pandas, torch, project packages) and files resolve naturally.
      - ``strict``: scripts run in an isolated temp directory with
        ``sys.executable`` (fan-agent's python). Reproducible and the
        interpreter is guaranteed to work, but project deps and relative paths
        won't resolve.

    Env scrubbing and tool whitelist apply identically in both modes.
    """
    cfg_value = str(_load_config().get("mode", DEFAULT_EXECUTION_MODE)).strip().lower()
    if cfg_value in EXECUTION_MODES:
        return cfg_value
    logger.warning(
        "Ignoring code_execution.mode=%r (expected one of %s), falling back to %r",
        cfg_value, EXECUTION_MODES, DEFAULT_EXECUTION_MODE,
    )
    return DEFAULT_EXECUTION_MODE


@functools.lru_cache(maxsize=32)
def _is_usable_python(python_path: str) -> bool:
    """Check whether a candidate Python interpreter is usable for execute_code.

    Requires Python 3.8+ (f-strings and stdlib modules the RPC stubs need).
    Cached so we don't fork a subprocess on every execute_code call.
    """
    try:
        result = subprocess.run(
            [python_path, "-c",
             "import sys; sys.exit(0 if sys.version_info >= (3, 8) else 1)"],
            timeout=5,
            capture_output=True,
            creationflags=subprocess.CREATE_NO_WINDOW if _IS_WINDOWS else 0,
        )
        return result.returncode == 0
    except (OSError, subprocess.TimeoutExpired, subprocess.SubprocessError):
        return False


def _resolve_child_python(mode: str) -> str:
    """Pick the Python interpreter for the execute_code subprocess.

    In ``strict`` mode, always ``sys.executable`` — guaranteed to work and
    keeps behavior fully reproducible across sessions.

    In ``project`` mode, prefer the user's active virtualenv/conda env's
    python so ``import pandas`` etc. work. Falls back to ``sys.executable``
    if no venv is detected, the candidate binary is missing/not executable,
    or it fails a Python 3.8+ version check.
    """
    if mode != "project":
        return sys.executable

    if _IS_WINDOWS:
        exe_names = ("python.exe", "python3.exe")
        subdirs = ("Scripts",)
    else:
        exe_names = ("python", "python3")
        subdirs = ("bin",)

    for var in ("VIRTUAL_ENV", "CONDA_PREFIX"):
        root = os.environ.get(var, "").strip()
        if not root:
            continue
        for subdir in subdirs:
            for exe in exe_names:
                candidate = os.path.join(root, subdir, exe)
                if not (os.path.isfile(candidate) and os.access(candidate, os.X_OK)):
                    continue
                if _is_usable_python(candidate):
                    return candidate
                # Found the interpreter but it failed the version check —
                # log once and fall through to sys.executable.
                logger.info(
                    "execute_code: skipping %s=%s (Python version < 3.8 or broken). "
                    "Using sys.executable instead.", var, candidate,
                )
                return sys.executable

    return sys.executable


def _resolve_child_cwd(mode: str, staging_dir: str) -> str:
    """Resolve the working directory for the execute_code subprocess.

    - ``strict``: the staging tmpdir (today's behavior).
    - ``project``: the session's TERMINAL_CWD (same as the terminal tool), or
      ``os.getcwd()`` if TERMINAL_CWD is unset or doesn't point at a real dir.
      Falls back to the staging tmpdir as a last resort so we never invoke
      Popen with a nonexistent cwd.
    """
    if mode != "project":
        return staging_dir
    raw = os.environ.get("TERMINAL_CWD", "").strip()
    if raw:
        expanded = os.path.expanduser(raw)
        if os.path.isdir(expanded):
            return expanded
    here = os.getcwd()
    if os.path.isdir(here):
        return here
    return staging_dir


# ---------------------------------------------------------------------------
# OpenAI Function-Calling Schema
# ---------------------------------------------------------------------------

# Per-tool documentation lines for the execute_code description.
# Ordered to match the canonical display order.
_TOOL_DOC_LINES = [
    ("read_file",
     "  read_file(path: str, offset: int = 1, limit: int = 500) -> dict\n"
     "    Lines are 1-indexed. Returns {\"content\": \"...\", \"total_lines\": N}"),
    ("write_file",
     "  write_file(path: str, content: str) -> dict\n"
     "    Always overwrites the entire file."),
    ("search_files",
     "  search_files(pattern: str, target=\"content\", path=\".\", file_glob=None, limit=50) -> dict\n"
     "    target: \"content\" (search inside files) or \"files\" (find files by name). Returns {\"matches\": [...]}"),
    ("patch",
     "  patch(path: str, old_string: str, new_string: str, replace_all: bool = False) -> dict\n"
     "    Replaces old_string with new_string in the file."),
    ("terminal",
     "  terminal(command: str, timeout=None, workdir=None) -> dict\n"
     "    Foreground only (no background/pty). Returns {\"output\": \"...\", \"exit_code\": N}"),
]


def build_execute_code_schema(enabled_sandbox_tools: set = None,
                              mode: str = None) -> dict:
    """Build the execute_code schema with description listing only enabled tools.

    The schema description only mentions sandbox tools that are actually
    enabled for this session.

    ``mode`` controls the working-directory sentence in the description:
      - ``'strict'``: scripts run in a temp dir (not the session's CWD)
      - ``'project'`` (default): scripts run in the session's CWD with the
        active venv's python
    If ``mode`` is None, the current ``code_execution.mode`` config is read.
    """
    if enabled_sandbox_tools is None:
        enabled_sandbox_tools = SANDBOX_ALLOWED_TOOLS
    if mode is None:
        mode = _get_execution_mode()

    # Build tool documentation lines for only the enabled tools
    tool_lines = "\n".join(
        doc for name, doc in _TOOL_DOC_LINES if name in enabled_sandbox_tools
    )

    # Build example import list from enabled tools
    import_examples = [n for n in ("terminal", "read_file") if n in enabled_sandbox_tools]
    if not import_examples:
        import_examples = sorted(enabled_sandbox_tools)[:2]
    if import_examples:
        import_str = ", ".join(import_examples) + ", ..."
    else:
        import_str = "..."

    # Mode-specific CWD guidance. Project mode is the default and matches
    # terminal()'s filesystem/interpreter; strict mode retains the isolated
    # temp-dir staging and fan-agent's own python.
    if mode == "strict":
        cwd_note = (
            "Scripts run in their own temp dir, not the session's CWD — use absolute paths "
            "(os.path.expanduser('~/.fan/.env')) or terminal()/read_file() for user files."
        )
    else:
        cwd_note = (
            "Scripts run in the session's working directory with the active venv's python, "
            "so project deps (pandas, etc.) and relative paths work like in terminal()."
        )

    description = (
        "Run a Python script that can call Fan tools programmatically. "
        "Use this when you need 3+ tool calls with processing logic between them, "
        "need to filter/reduce large tool outputs before they enter your context, "
        "need conditional branching (if X then Y else Z), or need to loop "
        "(fetch N pages, process N files, retry on failure).\n\n"
        "Use normal tool calls instead when: single tool call with no processing, "
        "you need to see the full result and apply complex reasoning, "
        "or the task requires interactive user input.\n\n"
        f"Available via `from fan_tools import ...`:\n\n"
        f"{tool_lines}\n\n"
        "Limits: 5-minute timeout, 50KB stdout cap, max 50 tool calls per script. "
        "terminal() is foreground-only (no background or pty).\n\n"
        f"{cwd_note}\n\n"
        "Print your final result to stdout. Use Python stdlib (json, re, math, csv, "
        "datetime, collections, etc.) for processing between tool calls.\n\n"
        "Also available (no import needed — built into fan_tools):\n"
        "  json_parse(text: str) — json.loads with strict=False; use for terminal() output with control chars\n"
        "  shell_quote(s: str) — shlex.quote(); use when interpolating dynamic strings into shell commands\n"
        "  retry(fn, max_attempts=3, delay=2) — retry with exponential backoff for transient failures"
    )

    return {
        "name": "execute_code",
        "description": description,
        "parameters": {
            "type": "object",
            "properties": {
                "code": {
                    "type": "string",
                    "description": (
                        "Python code to execute. Import tools with "
                        f"`from fan_tools import {import_str}` "
                        "and print your final result to stdout."
                    ),
                },
            },
            "required": ["code"],
        },
    }


# Default schema used at registration time (all sandbox tools listed,
# current configured mode).  model_tools.py rebuilds per-session anyway.
EXECUTE_CODE_SCHEMA = build_execute_code_schema()


# --- Registry ---
from tools.registry import registry, tool_error

registry.register(
    name="execute_code",
    toolset="code_execution",
    schema=EXECUTE_CODE_SCHEMA,
    handler=lambda args, **kw: execute_code(
        code=args.get("code", ""),
        task_id=kw.get("task_id"),
        enabled_tools=kw.get("enabled_tools")),
    check_fn=check_sandbox_requirements,
    emoji="🐍",
    max_result_size_chars=100_000,
)
