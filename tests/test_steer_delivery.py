from __future__ import annotations

import threading
import time
from types import SimpleNamespace

from run_agent import AIAgent
from tui_gateway import server
from tui_gateway.pending_interactions import PendingInteractionRegistry


class _FakeSteerAgent:
    def __init__(self, pending: str | None = None) -> None:
        self.pending = pending
        self.received: list[str] = []

    def steer(self, text: str) -> bool:
        self.received.append(text)
        return bool(text.strip())

    def _drain_pending_steer(self) -> str | None:
        pending, self.pending = self.pending, None
        return pending


def _steer_request(session_id: str, text: str = "补充问题") -> dict:
    return server.handle_request(
        {
            "id": "steer-test",
            "method": "session.steer",
            "params": {"session_id": session_id, "text": text},
        }
    )


def test_session_steer_rejects_idle_session_without_touching_agent(monkeypatch) -> None:
    session_id = "idle-steer-session"
    agent = _FakeSteerAgent()
    server._sessions[session_id] = {
        "agent": agent,
        "history_lock": threading.Lock(),
        "running": False,
    }
    monkeypatch.setattr(server, "_track_product_event", lambda *_args, **_kwargs: None)
    try:
        response = _steer_request(session_id)
    finally:
        server._sessions.pop(session_id, None)

    assert response["result"] == {
        "status": "rejected",
        "reason": "session_idle",
        "text": "补充问题",
    }
    assert agent.received == []


def test_session_steer_accepts_running_session(monkeypatch) -> None:
    session_id = "running-steer-session"
    agent = _FakeSteerAgent()
    server._sessions[session_id] = {
        "agent": agent,
        "history_lock": threading.Lock(),
        "running": True,
    }
    monkeypatch.setattr(server, "_track_product_event", lambda *_args, **_kwargs: None)
    try:
        response = _steer_request(session_id)
    finally:
        server._sessions.pop(session_id, None)

    assert response["result"] == {"status": "accepted", "text": "补充问题"}
    assert agent.received == ["补充问题"]


def test_late_steer_reserves_immediate_followup_in_arrival_order() -> None:
    session = {
        "_turn_cancel_requested": False,
        "last_active": 0.0,
        "running": False,
    }
    agent = _FakeSteerAgent("第二条补充")

    followup = server._reserve_late_steer_followup(
        session,
        agent,
        "第一条补充",
    )

    assert followup == "第一条补充\n第二条补充"
    assert session["running"] is True
    assert session["last_active"] > 0
    assert agent.pending is None


def test_cancelled_turn_drops_late_steer_instead_of_restarting() -> None:
    session = {
        "_turn_cancel_requested": True,
        "last_active": 0.0,
        "running": False,
    }
    agent = _FakeSteerAgent("停止后不应继续")

    assert server._reserve_late_steer_followup(session, agent, None) is None
    assert session["running"] is False
    assert agent.pending is None


def _bare_agent(*, interrupted: bool, pending_steer: str) -> AIAgent:
    agent = AIAgent.__new__(AIAgent)
    agent._interrupt_requested = interrupted
    agent._interrupt_message = None
    agent._interrupt_thread_signal_pending = False
    agent._execution_thread_id = None
    agent._pending_steer = pending_steer
    agent._pending_steer_lock = threading.Lock()
    agent._tool_worker_threads = set()
    agent._tool_worker_threads_lock = threading.Lock()
    return agent


def test_normal_turn_cleanup_preserves_steer_accepted_during_teardown() -> None:
    agent = _bare_agent(interrupted=False, pending_steer="收尾补充")

    agent.clear_interrupt()

    assert agent._pending_steer == "收尾补充"


def test_hard_interrupt_still_discards_pending_steer() -> None:
    agent = _bare_agent(interrupted=True, pending_steer="停止后不应继续")

    agent.clear_interrupt()

    assert agent._pending_steer is None


def test_busy_prompt_interrupts_executor_before_ending_browser_control(
    monkeypatch,
) -> None:
    events: list[str] = []
    registry = PendingInteractionRegistry()
    pending = registry.create(
        "busy-session",
        "verification.request",
        {"challenge_id": "busy-challenge"},
        request_id="busy-verification",
    )

    class InterruptAgent:
        def interrupt(self) -> None:
            events.append("interrupt")

    session = {
        "agent": InterruptAgent(),
        "last_active": 0.0,
        "queued_prompt": None,
    }
    monkeypatch.setattr(server, "_load_busy_input_mode", lambda: "interrupt")
    monkeypatch.setattr(
        server,
        "_session_has_compression_in_flight",
        lambda _session: False,
    )
    monkeypatch.setattr(server, "_pending_interactions", registry)

    def end_control(_session, *, reason):
        assert registry.get(pending.request_id).status == "interrupted"
        events.append(f"end:{reason}")

    monkeypatch.setattr(
        server,
        "_end_browser_control",
        end_control,
    )

    response = server._handle_busy_submit(
        "busy-rpc",
        "busy-session",
        session,
        "新的要求",
        None,
    )

    assert response["result"] == {"status": "queued"}
    assert events == ["interrupt", "end:interrupted-by-new-prompt"]
    assert registry.get(pending.request_id).status == "interrupted"
    assert session["queued_prompt"]["text"] == "新的要求"


def test_compression_probe_error_queues_without_interrupting(monkeypatch) -> None:
    class FailingSessionDB:
        def get_compression_lock_holder(self, _session_id: str):
            raise RuntimeError("sqlite temporarily unavailable")

    class InterruptAgent:
        session_id = "compression-probe-session"
        _session_db = FailingSessionDB()

        def __init__(self) -> None:
            self.interrupted = False

        def interrupt(self) -> None:
            self.interrupted = True

    agent = InterruptAgent()
    session = {
        "agent": agent,
        "last_active": 0.0,
        "queued_prompt": None,
    }
    monkeypatch.setattr(server, "_load_busy_input_mode", lambda: "interrupt")

    response = server._handle_busy_submit(
        "compression-probe-rpc",
        "compression-probe-session",
        session,
        "压缩期间的后续要求",
        None,
    )

    assert response["result"] == {"status": "queued"}
    assert agent.interrupted is False
    assert session["queued_prompt"]["text"] == "压缩期间的后续要求"


def test_missing_compression_probe_fails_closed() -> None:
    agent = SimpleNamespace(session_id="missing-probe-session", _session_db=object())

    assert server._session_has_compression_in_flight({"agent": agent}) is True


def test_explicitly_empty_compression_lock_allows_interrupt() -> None:
    session_db = SimpleNamespace(get_compression_lock_holder=lambda _sid: None)
    agent = SimpleNamespace(session_id="idle-compression-session", _session_db=session_db)

    assert server._session_has_compression_in_flight({"agent": agent}) is False


def test_busy_replacement_rejects_late_old_prompt_and_reopens_for_new_turn(
    monkeypatch,
) -> None:
    session_id = "busy-admission-session"
    registry = PendingInteractionRegistry()
    history_lock = threading.Lock()
    old_block_started = threading.Event()
    emitted_challenges: list[str] = []
    old_result: list[str] = []
    new_result: list[str] = []

    class InterruptAgent:
        def interrupt(self) -> None:
            pass

    session = {
        "_turn_cancel_requested": False,
        "agent": InterruptAgent(),
        "history_lock": history_lock,
        "last_active": 0.0,
        "queued_prompt": None,
        "running": True,
    }
    server._sessions[session_id] = session
    monkeypatch.setattr(server, "_pending_interactions", registry)
    monkeypatch.setattr(server, "_load_busy_input_mode", lambda: "interrupt")
    monkeypatch.setattr(
        server,
        "_session_has_compression_in_flight",
        lambda _session: False,
    )
    monkeypatch.setattr(server, "_end_browser_control", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(server, "_track_product_event", lambda *_args, **_kwargs: None)

    def emit(event: str, _sid: str, payload: dict | None = None) -> None:
        if event == "verification.request":
            emitted_challenges.append(str((payload or {}).get("challenge_id") or ""))

    monkeypatch.setattr(server, "_emit", emit)

    def late_old_block() -> None:
        old_block_started.set()
        old_result.append(
            server._block(
                "verification.request",
                session_id,
                {"challenge_id": "old-turn"},
                timeout=0,
                active_turn_only=True,
            )
        )

    # Mirror prompt.submit: it owns history_lock while applying the busy-input
    # policy. The old browser callback has already reached admission and waits
    # on that same lock.
    history_lock.acquire()
    worker = threading.Thread(target=late_old_block)
    worker.start()
    assert old_block_started.wait(timeout=1)
    try:
        response = server._handle_busy_submit(
            "busy-admission-rpc",
            session_id,
            session,
            "replacement prompt",
            None,
        )
    finally:
        history_lock.release()
    worker.join(timeout=1)

    assert not worker.is_alive()
    assert response["result"] == {"status": "queued"}
    assert old_result == ["stop"]
    assert emitted_challenges == []
    assert session["_turn_cancel_requested"] is True

    def run_replacement(_rid, _sid, _session, _text) -> None:
        new_result.append(
            server._block(
                "verification.request",
                session_id,
                {"challenge_id": "new-turn"},
                timeout=0,
                active_turn_only=True,
            )
        )

    monkeypatch.setattr(server, "_run_prompt_submit", run_replacement)
    session["running"] = False
    try:
        assert server._drain_queued_prompt(
            "busy-admission-rpc",
            session_id,
            session,
        )
    finally:
        server._sessions.pop(session_id, None)

    assert session["_turn_cancel_requested"] is False
    assert emitted_challenges == ["new-turn"]
    assert new_result == ["stop"]


def test_explicit_stop_interrupts_executor_before_ending_browser_control(
    monkeypatch,
) -> None:
    events: list[str] = []
    session_id = "stop-order-session"
    registry = PendingInteractionRegistry()
    pending = registry.create(
        session_id,
        "verification.request",
        {"challenge_id": "stop-challenge"},
        request_id="stop-verification",
    )
    end_started = threading.Event()
    late_response_done = threading.Event()
    late_responses: list[dict] = []

    class InterruptAgent:
        def interrupt(self) -> None:
            events.append("interrupt")

    class LiveThread:
        @staticmethod
        def is_alive() -> bool:
            return True

    server._sessions[session_id] = {
        "_run_thread": LiveThread(),
        "agent": InterruptAgent(),
        "history_lock": threading.Lock(),
        "queued_prompt": "pending",
        "running": True,
        "session_key": "stop-order-key",
    }
    monkeypatch.setattr(server, "_pending_interactions", registry)

    def delayed_auto_response() -> None:
        assert end_started.wait(timeout=1)
        late_responses.append(
            server._respond_verification(
                "late-auto-rpc",
                {
                    "answer": "auto",
                    "challenge_id": "stop-challenge",
                    "request_id": pending.request_id,
                    "session_id": session_id,
                },
            )
        )
        late_response_done.set()

    responder = threading.Thread(target=delayed_auto_response)
    responder.start()

    def end_control(_session, *, reason):
        # This is the exact former race window: a delayed captcha-cleared event
        # arrives while endControl is starting. Stop must already own the
        # registry's resolve-once terminal state.
        assert registry.get(pending.request_id).status == "interrupted"
        end_started.set()
        assert late_response_done.wait(timeout=1)
        events.append(f"end:{reason}")

    monkeypatch.setattr(
        server,
        "_end_browser_control",
        end_control,
    )
    monkeypatch.setattr(server, "_track_product_event", lambda *_args, **_kwargs: None)
    try:
        response = server.handle_request(
            {
                "id": "stop-rpc",
                "method": "session.interrupt",
                "params": {"session_id": session_id},
            }
        )
    finally:
        server._sessions.pop(session_id, None)
        end_started.set()
        responder.join(timeout=1)

    assert response["result"] == {"status": "interrupted"}
    assert events == ["interrupt", "end:cancelled"]
    assert late_responses[0]["result"] == {
        "status": "interrupted",
        "accepted": False,
    }


def test_explicit_stop_requires_active_browser_control_confirmation(
    monkeypatch,
) -> None:
    session_id = "stop-browser-confirmation-session"

    class InterruptAgent:
        def interrupt(self) -> None:
            pass

    class LiveThread:
        @staticmethod
        def is_alive() -> bool:
            return True

    browser_control = server._new_browser_control_state()
    browser_control.update(
        {
            "active": True,
            "control_id": "control-1",
            "workbench_id": "workbench-1",
        }
    )
    server._sessions[session_id] = {
        "_run_thread": LiveThread(),
        "agent": InterruptAgent(),
        "browser_control": browser_control,
        "history_lock": threading.Lock(),
        "queued_prompt": None,
        "running": True,
        "session_key": "stop-browser-confirmation-key",
    }
    outcomes = iter((False, True))
    monkeypatch.setattr(
        server,
        "_end_browser_control",
        lambda *_args, **_kwargs: next(outcomes),
    )
    monkeypatch.setattr(server, "_track_product_event", lambda *_args, **_kwargs: None)
    try:
        first = server.handle_request(
            {
                "id": "stop-browser-confirmation-1",
                "method": "session.interrupt",
                "params": {"session_id": session_id},
            }
        )
        second = server.handle_request(
            {
                "id": "stop-browser-confirmation-2",
                "method": "session.interrupt",
                "params": {"session_id": session_id},
            }
        )
    finally:
        server._sessions.pop(session_id, None)

    assert first["error"] == {
        "code": 5038,
        "message": "浏览器操作尚未确认停止，请重试",
    }
    assert second["result"] == {"status": "interrupted"}


def test_cancelled_turn_cannot_begin_late_browser_control(monkeypatch) -> None:
    calls: list[tuple] = []

    class Client:
        def call(self, *args, **kwargs):
            calls.append((args, kwargs))

    session = {
        "_turn_cancel_requested": True,
        "browser_control": server._new_browser_control_state(),
        "browser_workbench_id": "late-control-workbench",
        "history_lock": threading.Lock(),
        "inflight_turn": {"task_id": "late-control-turn"},
    }
    monkeypatch.setattr(server, "_get_browser_control_client", Client)

    assert (
        server._begin_browser_control(
            session,
            tool_name="browser_run",
            tool_call_id="late-browser-call",
            args={},
        )
        is False
    )
    assert calls == []
    assert session["browser_control"]["active"] is False


def test_gateway_immediately_runs_steer_returned_after_final_answer(
    monkeypatch,
    tmp_path,
) -> None:
    completed = threading.Event()
    emitted: list[tuple[str, str, dict]] = []

    class FollowupAgent(_FakeSteerAgent):
        max_iterations = 2

        def __init__(self) -> None:
            super().__init__()
            self.prompts: list[str] = []

        def run_conversation(self, text: str, **_kwargs) -> dict:
            self.prompts.append(text)
            messages = [
                {"role": "user", "content": prompt}
                for prompt in self.prompts
            ]
            if len(self.prompts) == 1:
                messages.append({"role": "assistant", "content": "第一轮完成"})
                return {
                    "completed": True,
                    "final_response": "第一轮完成",
                    "messages": messages,
                    "pending_steer": "收尾时补充",
                }

            messages.append({"role": "assistant", "content": "补充已处理"})
            completed.set()
            return {
                "completed": True,
                "final_response": "补充已处理",
                "messages": messages,
            }

    agent = FollowupAgent()
    session = {
        "_turn_cancel_requested": False,
        "agent": agent,
        "attached_images": [],
        "cols": 80,
        "cwd": str(tmp_path),
        "history": [],
        "history_lock": threading.Lock(),
        "history_version": 0,
        "inflight_turn": None,
        "last_active": time.time(),
        "queued_prompt": None,
        "running": True,
        "session_key": "stored-steer-session",
    }

    monkeypatch.setattr(server, "_clear_session_context", lambda _tokens: None)
    monkeypatch.setattr(server, "_end_browser_control", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(server, "_get_db", lambda: None)
    monkeypatch.setattr(server, "_load_cfg", lambda: {"onboarding": {"profile_build": "off"}})
    monkeypatch.setattr(server, "_get_usage", lambda _agent: {})
    monkeypatch.setattr(server, "_refresh_agent_fallback_chain", lambda _agent: None)
    monkeypatch.setattr(server, "_register_session_cwd", lambda _session: None)
    monkeypatch.setattr(server, "_session_info", lambda _agent, state: {"running": state["running"]})
    monkeypatch.setattr(server, "_set_session_context", lambda *_args, **_kwargs: [])
    monkeypatch.setattr(server, "_sync_session_key_after_compress", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(server, "_track_product_event", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(server, "_wire_callbacks", lambda _sid: None)
    monkeypatch.setattr(
        server,
        "_emit",
        lambda event, sid, payload=None: emitted.append((event, sid, payload or {})),
    )

    from tools.process_registry import process_registry

    monkeypatch.setattr(process_registry, "drain_notifications", lambda **_kwargs: [])

    server._run_prompt_submit("steer-rpc", "runtime-steer-session", session, "原始问题")

    assert completed.wait(timeout=2)
    run_thread = session.get("_run_thread")
    if run_thread is not None:
        run_thread.join(timeout=2)

    assert agent.prompts == ["原始问题", "收尾时补充"]
    assert session["running"] is False
    assert [event for event, _sid, _payload in emitted].count("message.start") == 2
    assert [event for event, _sid, _payload in emitted].count("message.complete") == 2
