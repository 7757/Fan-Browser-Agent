import json

import pytest

from tools import approval
from tools import terminal_tool


class FakeEnvironment:
    env = {}

    def __init__(self, cwd, cwd_owner):
        self.cwd = cwd
        self.cwd_owner = cwd_owner
        self.calls = []

    def execute(self, command, **kwargs):
        self.calls.append((command, kwargs))
        return {"output": "ok", "returncode": 0}


@pytest.fixture
def run_terminal(monkeypatch):
    def configure(env, *, session_key, default_cwd):
        monkeypatch.setattr(
            terminal_tool,
            "_active_environments",
            {"default": env},
        )
        monkeypatch.setattr(terminal_tool, "_last_activity", {})
        monkeypatch.setattr(terminal_tool, "_task_env_overrides", {})
        monkeypatch.setattr(terminal_tool, "_start_cleanup_thread", lambda: None)
        monkeypatch.setattr(
            terminal_tool,
            "_resolve_container_task_id",
            lambda _task_id: "default",
        )
        monkeypatch.setattr(
            terminal_tool,
            "_get_env_config",
            lambda: {
                "env_type": "local",
                "cwd": default_cwd,
                "timeout": 60,
                "lifetime_seconds": 300,
                "local_persistent": False,
            },
        )
        monkeypatch.setattr(
            approval,
            "get_current_session_key",
            lambda default="": session_key,
        )
        monkeypatch.delenv("FAN_GATEWAY_SESSION", raising=False)

        result = json.loads(
            terminal_tool.terminal_tool(
                command="pwd",
                task_id=session_key,
                force=True,
            )
        )
        assert result["exit_code"] == 0
        return env.calls

    return configure


def test_stale_env_cwd_from_different_session_is_ignored(run_terminal):
    env = FakeEnvironment("/workspace/session-a", "session-A")

    calls = run_terminal(
        env,
        session_key="session-B",
        default_cwd="/workspace/session-b",
    )

    assert calls == [
        ("pwd", {"timeout": 60, "cwd": "/workspace/session-b"})
    ]
    assert env.cwd_owner == "session-B"


def test_same_session_live_cwd_is_preserved(run_terminal):
    env = FakeEnvironment("/workspace/session-a/deep", "session-A")

    calls = run_terminal(
        env,
        session_key="session-A",
        default_cwd="/workspace/session-a",
    )

    assert calls == [
        ("pwd", {"timeout": 60, "cwd": "/workspace/session-a/deep"})
    ]


def test_explicit_workdir_still_wins_over_owner_guard():
    env = FakeEnvironment("/workspace/session-a", "session-A")

    resolved = terminal_tool._resolve_command_cwd(
        workdir="/workspace/explicit",
        env=env,
        default_cwd="/workspace/session-b",
        prev_owner="session-A",
        current_owner="session-B",
    )

    assert resolved == "/workspace/explicit"
