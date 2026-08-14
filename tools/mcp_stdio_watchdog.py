#!/usr/bin/env python3
"""Parent-death supervisor for stdio MCP subprocesses.

Normal MCP shutdown is handled by :mod:`tools.mcp_tool`.  This small POSIX
supervisor covers hard exits (force-quit, crash, SIGKILL), where Fan cannot run
its cleanup hooks and an MCP child tree would otherwise remain orphaned.
"""

from __future__ import annotations

import argparse
import os
import signal
import subprocess
import sys
import threading
import time

try:
    import psutil
except ImportError:  # best-effort fallback to parent-PID comparison
    psutil = None


_POLL_INTERVAL_SECONDS = 2.0
_TERM_GRACE_SECONDS = 3.0


def _is_orphaned(
    original_parent_pid: int,
    parent_create_time: float,
    getppid=os.getppid,
) -> bool:
    """Detect parent exit and protect against PID reuse."""
    if getppid() != original_parent_pid:
        return True
    if psutil is None:
        return False
    try:
        if not psutil.pid_exists(original_parent_pid):
            return True
        return (
            psutil.Process(original_parent_pid).create_time()
            != parent_create_time
        )
    except psutil.Error:
        return True


def _terminate_process_group(process: subprocess.Popen) -> None:
    """Terminate the real MCP child tree without touching this supervisor."""
    killpg = getattr(os, "killpg", None)
    if killpg is None:
        try:
            process.terminate()
            process.wait(timeout=_TERM_GRACE_SECONDS)
        except (OSError, subprocess.TimeoutExpired):
            process.kill()
        return

    try:
        child_pgid = os.getpgid(process.pid)
        own_pgid = os.getpgrp()
    except (ProcessLookupError, OSError):
        return

    # start_new_session=True below should make these different. Retain the
    # guard so a platform/runtime regression can never turn cleanup into
    # watchdog self-termination.
    if child_pgid == own_pgid:
        try:
            process.terminate()
        except OSError:
            pass
        return

    sigkill = getattr(signal, "SIGKILL", signal.SIGTERM)
    for sig in (signal.SIGTERM, sigkill):
        try:
            killpg(child_pgid, sig)
        except (ProcessLookupError, PermissionError, OSError):
            return
        try:
            process.wait(timeout=_TERM_GRACE_SECONDS)
            return
        except subprocess.TimeoutExpired:
            continue


def _watch_parent(
    process: subprocess.Popen,
    original_parent_pid: int,
    parent_create_time: float,
) -> None:
    while process.poll() is None:
        if _is_orphaned(original_parent_pid, parent_create_time):
            _terminate_process_group(process)
            return
        time.sleep(_POLL_INTERVAL_SECONDS)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Parent-death watchdog for a stdio MCP subprocess",
    )
    parser.add_argument("--ppid", type=int, required=True)
    parser.add_argument("--create-time", type=float, required=True)
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args(argv)

    real_argv = list(args.command)
    if real_argv and real_argv[0] == "--":
        real_argv = real_argv[1:]
    if not real_argv:
        print("mcp_stdio_watchdog: missing command after '--'", file=sys.stderr)
        return 2

    process = subprocess.Popen(
        real_argv,
        stdin=sys.stdin,
        stdout=sys.stdout,
        stderr=sys.stderr,
        start_new_session=True,
    )

    def _forward_shutdown(signum, _frame):
        _terminate_process_group(process)
        raise SystemExit(128 + signum)

    signal.signal(signal.SIGTERM, _forward_shutdown)
    signal.signal(signal.SIGINT, _forward_shutdown)

    watcher = threading.Thread(
        target=_watch_parent,
        args=(process, args.ppid, args.create_time),
        daemon=True,
    )
    watcher.start()

    try:
        return process.wait()
    except KeyboardInterrupt:
        _terminate_process_group(process)
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
