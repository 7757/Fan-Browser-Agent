from __future__ import annotations

import importlib
import threading


def _server(monkeypatch, tmp_path):
    monkeypatch.setenv("FAN_HOME", str(tmp_path / "fan-home"))
    return importlib.import_module("tui_gateway.server")


def test_desktop_default_loads_program_not_legacy(monkeypatch, tmp_path):
    server = _server(monkeypatch, tmp_path)
    monkeypatch.delenv("FAN_GATEWAY_TOOLSETS", raising=False)
    monkeypatch.delenv("FAN_BROWSER_RUNTIME", raising=False)
    monkeypatch.delenv("FAN_GATEWAY_BROWSER_RUNTIME", raising=False)
    monkeypatch.setattr(
        "fan_cli.config.load_config",
        lambda: {},
    )
    monkeypatch.setattr(
        "fan_cli.tools_config._get_platform_tools",
        lambda *_args, **_kwargs: {"terminal", "file"},
    )

    enabled = server._load_enabled_toolsets()

    assert enabled == ["browser_program", "file", "terminal"]
    assert "electron_browser" not in enabled


def test_legacy_browser_remains_an_explicit_toolset(monkeypatch, tmp_path):
    server = _server(monkeypatch, tmp_path)
    monkeypatch.setenv("FAN_GATEWAY_TOOLSETS", "electron_browser")

    assert server._load_enabled_toolsets() == ["electron_browser"]


def test_snapshot_and_handoff_do_not_start_operating_visual(monkeypatch, tmp_path):
    server = _server(monkeypatch, tmp_path)

    class Client:
        def __init__(self):
            self.calls = []

        def call(self, action, **kwargs):
            self.calls.append((action, kwargs))
            return {"active": True}

    client = Client()
    monkeypatch.setattr(server, "_get_browser_control_client", lambda: client)
    session = {
        "history_lock": threading.Lock(),
        "session_key": "session-1",
        "inflight_turn": {"task_id": "turn-1"},
    }

    assert server._begin_browser_control(
        session,
        tool_name="browser_snapshot",
        tool_call_id="snapshot-1",
        args={},
    ) is False
    assert server._begin_browser_control(
        session,
        tool_name="browser_handoff",
        tool_call_id="handoff-1",
        args={},
    ) is False
    assert client.calls == []

    assert server._begin_browser_control(
        session,
        tool_name="browser_run",
        tool_call_id="run-1",
        args={"intent": "search"},
    ) is True
    assert client.calls[0][0] == "beginControl"
