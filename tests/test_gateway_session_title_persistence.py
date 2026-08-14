from tui_gateway import server


def _set_title(session_id: str, title: str) -> dict:
    return server.handle_request(
        {
            "id": "title-test",
            "method": "session.title",
            "params": {"session_id": session_id, "title": title},
        }
    )


def test_title_before_first_message_creates_row_and_persists(monkeypatch) -> None:
    state = {"row": None, "title": None, "ensured": False}

    class FakeDB:
        def set_session_title(self, _key: str, title: str) -> bool:
            if state["row"] is None:
                return False
            state["title"] = title
            return True

        def get_session(self, _key: str):
            return state["row"]

    session_id = "title-before-message"
    session = {"session_key": "stored-title-key", "pending_title": None}
    server._sessions[session_id] = session
    monkeypatch.setattr(server, "_get_db", lambda: FakeDB())

    def ensure_row(_session: dict) -> None:
        state["ensured"] = True
        state["row"] = {"id": "stored-title-key", "title": None}

    monkeypatch.setattr(server, "_ensure_session_db_row", ensure_row)
    try:
        response = _set_title(session_id, "My first title")
    finally:
        server._sessions.pop(session_id, None)

    assert response["result"] == {"pending": False, "title": "My first title"}
    assert state == {
        "row": {"id": "stored-title-key", "title": None},
        "title": "My first title",
        "ensured": True,
    }
    assert session["pending_title"] is None


def test_title_queues_when_retry_cannot_create_row(monkeypatch) -> None:
    class FakeDB:
        def set_session_title(self, _key: str, _title: str) -> bool:
            return False

        def get_session(self, _key: str):
            return None

    session_id = "title-persistence-fallback"
    session = {"session_key": "missing-title-key", "pending_title": None}
    server._sessions[session_id] = session
    monkeypatch.setattr(server, "_get_db", lambda: FakeDB())
    monkeypatch.setattr(server, "_ensure_session_db_row", lambda _session: None)
    try:
        response = _set_title(session_id, "Keep this title")
    finally:
        server._sessions.pop(session_id, None)

    assert response["result"] == {"pending": True, "title": "Keep this title"}
    assert session["pending_title"] == "Keep this title"
