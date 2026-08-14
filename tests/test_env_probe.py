from __future__ import annotations

import subprocess
import sys
import threading
import time

import pytest

from tools import env_probe


@pytest.fixture(autouse=True)
def reset_probe_cache():
    env_probe._reset_cache_for_tests()
    yield
    env_probe._reset_cache_for_tests()


def test_hung_probe_fails_open_for_concurrent_callers(monkeypatch):
    release = threading.Event()
    probe_calls = 0

    def stuck_probe():
        nonlocal probe_calls
        probe_calls += 1
        release.wait(timeout=10)
        return "Python toolchain: late result."

    monkeypatch.setattr(env_probe, "_build_probe_line", stuck_probe)
    monkeypatch.setattr(env_probe, "_PROBE_WAIT_TIMEOUT", 0.2)

    results = []
    callers = [
        threading.Thread(
            target=lambda: results.append(env_probe.get_environment_probe_line()),
            daemon=True,
        )
        for _ in range(4)
    ]
    started = time.monotonic()
    for caller in callers:
        caller.start()
    for caller in callers:
        caller.join(timeout=2)

    try:
        assert all(not caller.is_alive() for caller in callers)
        assert results == ["", "", "", ""]
        assert probe_calls == 1
        assert time.monotonic() - started < 1.5
    finally:
        release.set()
        env_probe._PROBE_DONE.wait(timeout=2)


def test_late_probe_result_is_published_after_recovery(monkeypatch):
    release = threading.Event()

    def slow_probe():
        release.wait(timeout=10)
        return "Python toolchain: recovered."

    monkeypatch.setattr(env_probe, "_build_probe_line", slow_probe)
    monkeypatch.setattr(env_probe, "_PROBE_WAIT_TIMEOUT", 0.1)

    assert env_probe.get_environment_probe_line() == ""
    release.set()
    assert env_probe._PROBE_DONE.wait(timeout=2)
    assert env_probe.get_environment_probe_line() == "Python toolchain: recovered."


def test_repeat_caller_only_peeks_after_first_timeout(monkeypatch):
    release = threading.Event()

    def stuck_probe():
        release.wait(timeout=10)
        return ""

    monkeypatch.setattr(env_probe, "_build_probe_line", stuck_probe)
    monkeypatch.setattr(env_probe, "_PROBE_WAIT_TIMEOUT", 0.1)

    try:
        assert env_probe.get_environment_probe_line() == ""
        monkeypatch.setattr(env_probe, "_PROBE_WAIT_TIMEOUT", 10.0)
        started = time.monotonic()
        assert env_probe.get_environment_probe_line() == ""
        assert time.monotonic() - started < 0.5
    finally:
        release.set()
        env_probe._PROBE_DONE.wait(timeout=2)


def test_run_timeout_is_bounded_when_descendant_holds_pipes():
    script = (
        "import subprocess, sys, time\n"
        "subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(5)'])\n"
        "time.sleep(5)\n"
    )
    started = time.monotonic()

    rc, output, error = env_probe._run(
        [sys.executable, "-c", script],
        timeout=0.2,
    )

    assert (rc, output, error) == (-1, "", "timeout")
    assert time.monotonic() - started < 3


def test_windows_timeout_cleanup_requests_process_tree_kill(monkeypatch):
    calls = []

    class FakeProcess:
        pid = 1234

        def kill(self):
            calls.append("kill")

    def fake_run(command, **kwargs):
        calls.append((command, kwargs))
        return subprocess.CompletedProcess(command, 0)

    monkeypatch.setattr(env_probe.sys, "platform", "win32")
    monkeypatch.setattr(env_probe.subprocess, "run", fake_run)

    env_probe._kill_process_tree(FakeProcess())

    command, kwargs = calls[0]
    assert command == ["taskkill", "/T", "/F", "/PID", "1234"]
    assert kwargs["timeout"] == 2
    assert calls[1] == "kill"
