from __future__ import annotations

from tools.daemon_pool import DaemonThreadPoolExecutor


def test_daemon_pool_workers_do_not_hold_interpreter_open():
    executor = DaemonThreadPoolExecutor(max_workers=1)
    future = executor.submit(lambda: __import__("threading").current_thread().daemon)
    assert future.result(timeout=1) is True
    executor.shutdown(wait=True)


def test_concurrent_timeout_configuration(monkeypatch):
    from agent.tool_executor import (
        _DEFAULT_CONCURRENT_TOOL_TIMEOUT_S,
        _resolve_concurrent_tool_timeout,
    )

    monkeypatch.delenv("FAN_CONCURRENT_TOOL_TIMEOUT_S", raising=False)
    assert _resolve_concurrent_tool_timeout() == _DEFAULT_CONCURRENT_TOOL_TIMEOUT_S
    monkeypatch.setenv("FAN_CONCURRENT_TOOL_TIMEOUT_S", "0")
    assert _resolve_concurrent_tool_timeout() is None
    monkeypatch.setenv("FAN_CONCURRENT_TOOL_TIMEOUT_S", "12.5")
    assert _resolve_concurrent_tool_timeout() == 12.5


def test_late_worker_cannot_replace_a_sealed_timeout_result():
    import threading

    from agent.tool_executor import _store_concurrent_result

    results = [None]
    lock = threading.Lock()
    sealed = set()
    timeout = ("terminal", {}, '{"error":"timed out"}', 10.0, True, False)
    late_success = ("terminal", {}, "late success", 10.1, False, False)

    assert _store_concurrent_result(results, lock, sealed, 0, timeout, seal=True)
    assert not _store_concurrent_result(results, lock, sealed, 0, late_success)
    assert results[0] == timeout
