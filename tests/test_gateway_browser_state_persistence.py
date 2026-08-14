import json
from types import SimpleNamespace

from fan_state import SessionDB
from tui_gateway import server


def _request(method: str, params: dict) -> dict:
    return server.handle_request(
        {
            "id": "browser-state-test",
            "method": method,
            "params": params,
        }
    )


class _MemoryBrowserStateDB:
    def __init__(self, rows: dict[str, dict], resume_targets: dict[str, str] | None = None):
        self.rows = rows
        self.resume_targets = resume_targets or {}
        self.updated: list[tuple[str, str | None]] = []

    def get_session(self, session_id: str):
        return self.rows.get(session_id)

    def resolve_resume_session_id(self, session_id: str):
        return self.resume_targets.get(session_id, session_id)

    def update_session_browser_state(self, session_id: str, payload: str | None):
        self.updated.append((session_id, payload))
        self.rows[session_id]["browser_state"] = payload


def test_compression_inherits_unchanged_browser_state_into_continuation(
    monkeypatch,
    tmp_path,
) -> None:
    parent_id = "browser-state-compression-parent"
    continuation_id = "browser-state-compression-child"
    state = {"active": 0, "tabs": [{"url": "https://example.com"}]}
    payload = json.dumps(state)
    db = SessionDB(tmp_path / "state.db")
    db.create_session(parent_id, "tui")
    db.update_session_browser_state(parent_id, payload)
    db.create_session(
        continuation_id,
        "tui",
        parent_session_id=parent_id,
    )
    session = {
        "agent": SimpleNamespace(session_id=continuation_id),
        "session_key": parent_id,
        "pending_title": None,
    }

    monkeypatch.setattr(server, "_get_db", lambda: db)
    monkeypatch.setattr(
        server,
        "_cancel_async_delegations_for_session",
        lambda *_args: None,
    )
    monkeypatch.setattr(server, "_transfer_active_session_slot", lambda *_args, **_kwargs: True)
    monkeypatch.setattr(server, "_retarget_kanban_notifications", lambda *_args: None)

    import agent.human_interaction_state as human_interaction_state
    import tools.approval as approval
    import tools.transient_values as transient_values

    monkeypatch.setattr(transient_values, "transfer_session_values", lambda *_args: None)
    monkeypatch.setattr(
        human_interaction_state,
        "clear_human_interaction_state",
        lambda *_args: None,
    )
    monkeypatch.setattr(approval, "unregister_gateway_notify", lambda *_args: None)
    monkeypatch.setattr(approval, "is_session_yolo_enabled", lambda *_args: False)
    monkeypatch.setattr(approval, "register_gateway_notify", lambda *_args, **_kwargs: None)
    try:
        server._sync_session_key_after_compress(
            "runtime-compression-inheritance",
            session,
            clear_pending_title=False,
            restart_slash_worker=False,
        )
        child = db.get_session(continuation_id)
    finally:
        db.close()

    assert session["session_key"] == continuation_id
    assert json.loads(child["browser_state"]) == state


def test_browser_state_inheritance_never_overwrites_newer_child_state(tmp_path) -> None:
    parent_id = "browser-state-parent-old"
    continuation_id = "browser-state-child-new"
    parent_payload = json.dumps({"tabs": [{"url": "https://old.example"}]})
    child_payload = json.dumps({"tabs": [{"url": "https://new.example"}]})
    db = SessionDB(tmp_path / "state.db")
    try:
        db.create_session(parent_id, "tui")
        db.update_session_browser_state(parent_id, parent_payload)
        db.create_session(
            continuation_id,
            "tui",
            parent_session_id=parent_id,
        )
        db.update_session_browser_state(continuation_id, child_payload)

        inherited = db.inherit_session_browser_state(parent_id, continuation_id)
        child = db.get_session(continuation_id)
    finally:
        db.close()

    assert inherited is False
    assert child["browser_state"] == child_payload


def test_browser_state_runtime_session_id_remains_backward_compatible(monkeypatch) -> None:
    runtime_id = "runtime-browser-state"
    stored_id = "stored-browser-state"
    db = _MemoryBrowserStateDB(
        {stored_id: {"id": stored_id, "browser_state": None}}
    )
    session = {
        "session_key": stored_id,
        "browser_workbench_id": "stable-workbench",
    }
    monkeypatch.setattr(server, "_get_db", lambda: db)
    with server._sessions_lock:
        server._sessions[runtime_id] = session
    try:
        state = {"active": 0, "tabs": [{"id": "t1", "url": "https://example.com"}]}
        response = _request(
            "session.browserState.set",
            {"session_id": runtime_id, "state": state},
        )
        restored = _request(
            "session.browserState.get",
            {"session_id": runtime_id},
        )
    finally:
        with server._sessions_lock:
            server._sessions.pop(runtime_id, None)

    assert response["result"] == {}
    assert db.updated == [(stored_id, json.dumps(state))]
    assert restored["result"] == {"state": state}


def test_browser_workbench_resolves_to_live_compression_continuation(monkeypatch) -> None:
    runtime_id = "runtime-compressed-browser-state"
    workbench_id = "original-browser-workbench"
    continuation_id = "compressed-continuation"
    db = _MemoryBrowserStateDB(
        {
            workbench_id: {"id": workbench_id, "browser_state": None},
            continuation_id: {"id": continuation_id, "browser_state": None},
        }
    )
    session = {
        "session_key": continuation_id,
        "browser_workbench_id": workbench_id,
        "created_at": 1.0,
        "last_active": 2.0,
    }
    monkeypatch.setattr(server, "_get_db", lambda: db)
    with server._sessions_lock:
        server._sessions[runtime_id] = session
    try:
        state = {"active": 1, "tabs": [{"id": "t1"}, {"id": "t2"}]}
        response = _request(
            "session.browserState.set",
            {"browser_workbench_id": workbench_id, "state": state},
        )
        restored = _request(
            "session.browserState.get",
            {"browser_workbench_id": workbench_id},
        )
    finally:
        with server._sessions_lock:
            server._sessions.pop(runtime_id, None)

    assert response["result"] == {}
    assert db.updated == [(continuation_id, json.dumps(state))]
    assert db.rows[workbench_id]["browser_state"] is None
    assert restored["result"] == {"state": state}


def test_browser_state_retries_when_compression_rotates_key_during_write(
    monkeypatch,
) -> None:
    runtime_id = "runtime-compress-race"
    workbench_id = "workbench-compress-race"
    parent_id = "parent-before-concurrent-compression"
    continuation_id = "continuation-after-concurrent-compression"
    session = {
        "session_key": parent_id,
        "browser_workbench_id": workbench_id,
        "created_at": 1.0,
        "last_active": 2.0,
    }

    class CompressingDB(_MemoryBrowserStateDB):
        def update_session_browser_state(self, session_id: str, payload: str | None):
            super().update_session_browser_state(session_id, payload)
            if session_id == parent_id:
                session["session_key"] = continuation_id

    db = CompressingDB(
        {
            parent_id: {"id": parent_id, "browser_state": None},
            continuation_id: {"id": continuation_id, "browser_state": None},
        }
    )
    monkeypatch.setattr(server, "_get_db", lambda: db)
    with server._sessions_lock:
        server._sessions[runtime_id] = session
    try:
        state = {"active": 0, "tabs": [{"url": "https://example.com"}]}
        response = _request(
            "session.browserState.set",
            {"browser_workbench_id": workbench_id, "state": state},
        )
    finally:
        with server._sessions_lock:
            server._sessions.pop(runtime_id, None)

    payload = json.dumps(state)
    assert response["result"] == {}
    assert db.updated == [(parent_id, payload), (continuation_id, payload)]
    assert db.rows[continuation_id]["browser_state"] == payload


def test_browser_workbench_uses_latest_live_binding(monkeypatch) -> None:
    workbench_id = "shared-workbench"
    old_id = "old-continuation"
    current_id = "current-continuation"
    db = _MemoryBrowserStateDB(
        {
            old_id: {"id": old_id, "browser_state": None},
            current_id: {"id": current_id, "browser_state": None},
        }
    )
    monkeypatch.setattr(server, "_get_db", lambda: db)
    with server._sessions_lock:
        server._sessions["parked-runtime"] = {
            "session_key": old_id,
            "browser_workbench_id": workbench_id,
            "created_at": 1.0,
            "last_active": 10.0,
        }
        server._sessions["current-runtime"] = {
            "session_key": current_id,
            "browser_workbench_id": workbench_id,
            "created_at": 2.0,
            "last_active": 20.0,
        }
    try:
        response = _request(
            "session.browserState.set",
            {"browser_workbench_id": workbench_id, "state": {"active": 0}},
        )
    finally:
        with server._sessions_lock:
            server._sessions.pop("parked-runtime", None)
            server._sessions.pop("current-runtime", None)

    assert response["result"] == {}
    assert db.updated == [(current_id, json.dumps({"active": 0}))]


def test_browser_workbench_durable_fallback_follows_compression_lineage(monkeypatch) -> None:
    workbench_id = "closed-original-workbench"
    continuation_id = "closed-current-continuation"
    db = _MemoryBrowserStateDB(
        {
            workbench_id: {"id": workbench_id, "browser_state": None},
            continuation_id: {"id": continuation_id, "browser_state": None},
        },
        resume_targets={workbench_id: continuation_id},
    )
    monkeypatch.setattr(server, "_get_db", lambda: db)

    state = {"active": 0, "tabs": [{"url": "https://example.com"}]}
    response = _request(
        "session.browserState.set",
        {"browser_workbench_id": workbench_id, "state": state},
    )
    restored = _request(
        "session.browserState.get",
        {"browser_workbench_id": workbench_id},
    )

    assert response["result"] == {}
    assert db.updated == [(continuation_id, json.dumps(state))]
    assert restored["result"] == {"state": state}


def test_unknown_browser_workbench_returns_rpc_error(monkeypatch) -> None:
    db = _MemoryBrowserStateDB({})
    monkeypatch.setattr(server, "_get_db", lambda: db)

    response = _request(
        "session.browserState.get",
        {"browser_workbench_id": "missing-workbench"},
    )

    assert response["error"]["code"] == 4001
    assert response["error"]["message"] == "session not found"


def test_browser_state_set_reports_database_write_failure(monkeypatch) -> None:
    runtime_id = "runtime-write-failure"
    stored_id = "stored-write-failure"

    class FailingDB(_MemoryBrowserStateDB):
        def update_session_browser_state(self, session_id: str, payload: str | None):
            raise OSError("disk is read-only")

    db = FailingDB({stored_id: {"id": stored_id, "browser_state": None}})
    monkeypatch.setattr(server, "_get_db", lambda: db)
    with server._sessions_lock:
        server._sessions[runtime_id] = {"session_key": stored_id}
    try:
        response = _request(
            "session.browserState.set",
            {"session_id": runtime_id, "state": {"active": 0}},
        )
    finally:
        with server._sessions_lock:
            server._sessions.pop(runtime_id, None)

    assert response["error"]["code"] == 5037
    assert "browser state persistence failed" in response["error"]["message"]


def test_browser_state_set_does_not_acknowledge_a_missing_durable_row(
    monkeypatch,
) -> None:
    runtime_id = "runtime-missing-durable-row"

    class MissingRowDB(_MemoryBrowserStateDB):
        def update_session_browser_state(self, session_id: str, payload: str | None):
            raise AssertionError("must not update a missing row")

    db = MissingRowDB({})
    monkeypatch.setattr(server, "_get_db", lambda: db)
    monkeypatch.setattr(server, "_ensure_session_db_row", lambda _session: None)
    with server._sessions_lock:
        server._sessions[runtime_id] = {"session_key": "missing-durable-row"}
    try:
        response = _request(
            "session.browserState.set",
            {"session_id": runtime_id, "state": {"active": 0}},
        )
    finally:
        with server._sessions_lock:
            server._sessions.pop(runtime_id, None)

    assert response["error"] == {
        "code": 5037,
        "message": "browser state target is not durable",
    }
