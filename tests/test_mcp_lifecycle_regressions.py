"""Focused regression contracts for MCP lifecycle hardening.

These tests are intentionally unit-level: no real MCP process or network
endpoint is required.
"""

from __future__ import annotations

import asyncio
import signal
from types import SimpleNamespace

import pytest

from tools import mcp_tool
from tools import mcp_stdio_watchdog


def test_ready_wait_is_iteration_bounded_when_clock_is_frozen(monkeypatch):
    sleeps = []
    server = SimpleNamespace(
        session=None,
        _ready=SimpleNamespace(is_set=lambda: False),
    )
    monkeypatch.setattr(mcp_tool.time, "monotonic", lambda: 42.0)
    monkeypatch.setattr(mcp_tool.time, "sleep", sleeps.append)

    assert not mcp_tool._wait_for_server_session_ready(server, timeout=0.5)
    assert sleeps == [0.25]


def test_orphan_reaper_never_killpg_fan_own_group(monkeypatch):
    pid = 43210
    pid_signals = []
    group_signals = []

    monkeypatch.setattr(mcp_tool.os, "getpgrp", lambda: 77)
    monkeypatch.setattr(
        mcp_tool.os, "killpg", lambda pgid, sig: group_signals.append((pgid, sig))
    )
    monkeypatch.setattr(
        mcp_tool.os, "kill", lambda target, sig: pid_signals.append((target, sig))
    )
    monkeypatch.setattr(mcp_tool.time, "sleep", lambda _seconds: None)

    import psutil

    monkeypatch.setattr(psutil, "pid_exists", lambda _pid: False)

    with mcp_tool._lock:
        mcp_tool._orphan_stdio_pids.add(pid)
        mcp_tool._orphan_stdio_pid_servers[pid] = "demo"
        mcp_tool._stdio_pgids[pid] = 77

    mcp_tool._kill_orphaned_mcp_children(server_name="demo")

    assert group_signals == []
    assert pid_signals == [(pid, signal.SIGTERM)]


def test_start_cancellation_cancels_detached_run_task(monkeypatch):
    server = mcp_tool.MCPServerTask("demo")

    async def never_ready(_self, _config):
        await asyncio.Event().wait()

    monkeypatch.setattr(mcp_tool.MCPServerTask, "run", never_ready)

    async def exercise():
        start_task = asyncio.create_task(server.start({}))
        await asyncio.sleep(0)
        start_task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await start_task
        await asyncio.sleep(0)
        assert server._task is not None
        assert server._task.cancelled() or server._task.done()

    asyncio.run(exercise())


def test_watchdog_detects_parent_replacement_without_pid_one_assumption():
    assert mcp_stdio_watchdog._is_orphaned(
        100,
        123.0,
        getppid=lambda: 200,
    )


def test_watchdog_terminates_real_child_process_group(monkeypatch):
    sent = []
    process = SimpleNamespace(pid=123, wait=lambda timeout=None: 0)
    monkeypatch.setattr(mcp_stdio_watchdog.os, "getpgid", lambda _pid: 123)
    monkeypatch.setattr(mcp_stdio_watchdog.os, "getpgrp", lambda: 99)
    monkeypatch.setattr(
        mcp_stdio_watchdog.os,
        "killpg",
        lambda pgid, sig: sent.append((pgid, sig)),
    )

    mcp_stdio_watchdog._terminate_process_group(process)

    assert sent == [(123, signal.SIGTERM)]


def test_revived_owned_server_republishes_deregistered_tools(monkeypatch):
    server = mcp_tool.MCPServerTask("demo")
    server._config = {"command": "demo"}
    server._tools = [SimpleNamespace(name="search")]
    monkeypatch.setattr(
        mcp_tool,
        "_register_server_tools",
        lambda name, owner, config: ["mcp_demo_search"],
    )
    with mcp_tool._lock:
        mcp_tool._servers["demo"] = server
    try:
        server._register_discovered_tools_if_needed()
        assert server._registered_tool_names == ["mcp_demo_search"]
    finally:
        with mcp_tool._lock:
            mcp_tool._servers.pop("demo", None)


def test_register_wakes_cached_server_without_live_session(monkeypatch):
    reconnect = SimpleNamespace(was_set=False)
    reconnect.set = lambda: setattr(reconnect, "was_set", True)
    server = SimpleNamespace(
        session=None,
        _reconnect_event=reconnect,
        _registered_tool_names=[],
    )
    monkeypatch.setattr(mcp_tool, "_MCP_AVAILABLE", True)
    monkeypatch.setattr(mcp_tool, "_mcp_loop", None)
    with mcp_tool._lock:
        mcp_tool._servers["demo"] = server
    try:
        mcp_tool.register_mcp_servers({"demo": {"command": "demo"}})
        assert reconnect.was_set
    finally:
        with mcp_tool._lock:
            mcp_tool._servers.pop("demo", None)
