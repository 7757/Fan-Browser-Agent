from __future__ import annotations

from types import SimpleNamespace

from tui_gateway import server


def test_restart_keeps_unused_slash_worker_lazy(monkeypatch) -> None:
    created: list[tuple[str, str]] = []

    class UnexpectedWorker:
        def __init__(self, session_key: str, model: str):
            created.append((session_key, model))

    monkeypatch.setattr(server, "_SlashWorker", UnexpectedWorker)

    session = {
        "agent": SimpleNamespace(model="test-model"),
        "session_key": "stored-session",
        "slash_worker": None,
    }

    server._restart_slash_worker(session)

    assert created == []
    assert session["slash_worker"] is None


def test_slash_exec_creates_worker_on_first_use(monkeypatch) -> None:
    created: list[tuple[str, str]] = []

    class FakeWorker:
        def __init__(self, session_key: str, model: str):
            created.append((session_key, model))

        def close(self) -> None:
            pass

        def run(self, command: str) -> str:
            return f"ran {command}"

    sid = "lazy-slash-session"
    session = {
        "agent": SimpleNamespace(model="test-model"),
        "session_key": "stored-session",
        "slash_worker": None,
    }
    server._sessions[sid] = session
    monkeypatch.setattr(server, "_SlashWorker", FakeWorker)

    try:
        response = server.handle_request(
            {
                "id": "lazy-slash",
                "method": "slash.exec",
                "params": {"command": "/help", "session_id": sid},
            }
        )
    finally:
        server._sessions.pop(sid, None)

    assert response is not None
    assert response["result"]["output"] == "ran /help"
    assert created == [("stored-session", "test-model")]
    assert isinstance(session["slash_worker"], FakeWorker)
