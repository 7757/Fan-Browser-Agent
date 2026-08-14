from __future__ import annotations

import json
import threading

from tui_gateway import server
from tui_gateway.pending_interactions import PendingInteractionRegistry
from tools.transient_values import protect_value, resolve_value_ref


def test_collect_block_resumes_with_explicit_status_and_idempotent_response(
    monkeypatch,
) -> None:
    registry = PendingInteractionRegistry()
    monkeypatch.setattr(server, "_pending_interactions", registry)
    emitted: list[tuple[str, str, dict]] = []
    emitted_ready = threading.Event()

    def emit(event: str, session_id: str, payload: dict) -> None:
        emitted.append((event, session_id, payload))
        emitted_ready.set()

    monkeypatch.setattr(server, "_emit", emit)
    monkeypatch.setattr(server, "_track_product_event", lambda *_args, **_kwargs: None)
    result: list[str] = []
    worker = threading.Thread(
        target=lambda: result.append(
            server._block(
                "collect.request",
                "session-a",
                {"question": "Passport", "fields": [{"name": "passport"}]},
                timeout=2,
            )
        )
    )
    worker.start()
    assert emitted_ready.wait(timeout=1)

    request_id = emitted[0][2]["request_id"]
    assert emitted[0][2]["interaction_epoch"] == registry.epoch
    assert emitted[0][2]["interaction_revision"] == 1
    response = json.dumps(
        {"values": {"passport": "N123456"}, "skipped": False},
        ensure_ascii=False,
    )
    first = server._respond(
        "rpc-1",
        {"request_id": request_id, "session_id": "session-a", "result": response},
        "result",
    )
    duplicate = server._respond(
        "rpc-2",
        {"request_id": request_id, "session_id": "session-a", "result": response},
        "result",
    )
    worker.join(timeout=1)

    assert first["result"] == {"status": "submitted", "accepted": True}
    assert duplicate["result"] == {"status": "submitted", "accepted": False}
    assert not worker.is_alive()
    parsed = json.loads(result[0])
    assert parsed["status"] == "submitted"
    assert parsed["values"] == {"passport": "N123456"}
    assert registry.get(request_id).response == ""
    assert emitted[-1] == (
        "interaction.resolved",
        "session-a",
        {
            "request_id": request_id,
            "kind": "collect",
            "status": "submitted",
            "interaction_epoch": registry.epoch,
            "interaction_revision": 2,
        },
    )
    assert "N123456" not in json.dumps(emitted[-1])


def test_collect_skip_and_interrupt_are_not_conflated(monkeypatch) -> None:
    registry = PendingInteractionRegistry()
    monkeypatch.setattr(server, "_pending_interactions", registry)
    monkeypatch.setattr(server, "_emit", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(server, "_track_product_event", lambda *_args, **_kwargs: None)

    skipped = registry.create(
        "session-a", "collect.request", {"question": "Optional"}, request_id="skip"
    )
    registry.respond(
        skipped.request_id,
        json.dumps({"values": {}, "skipped": True}),
        status="skipped",
    )
    skip_result = registry.wait(skipped.request_id, timeout=0)

    interrupted = registry.create(
        "session-a", "collect.request", {"question": "Required"}, request_id="stop"
    )
    server._clear_pending("session-a")
    interrupt_result = registry.wait(interrupted.request_id, timeout=0)

    assert skip_result.status == "skipped"
    assert interrupt_result.status == "interrupted"


def test_browser_block_terminal_statuses_return_explicit_stop(monkeypatch) -> None:
    monkeypatch.setattr(server, "_track_product_event", lambda *_args, **_kwargs: None)

    for event in ("verification.request", "control.request"):
        for terminal_status in ("interrupted", "cancelled", "expired"):
            registry = PendingInteractionRegistry()
            monkeypatch.setattr(server, "_pending_interactions", registry)
            requested = threading.Event()
            emitted: list[tuple[str, dict]] = []

            def emit(name: str, _session_id: str, payload: dict) -> None:
                emitted.append((name, payload))
                if name == event:
                    requested.set()

            monkeypatch.setattr(server, "_emit", emit)
            result: list[str] = []
            worker = threading.Thread(
                target=lambda: result.append(
                    server._block(
                        event,
                        "session-a",
                        {},
                        timeout=0 if terminal_status == "expired" else 2,
                    )
                )
            )
            worker.start()
            assert requested.wait(timeout=1)

            if terminal_status != "expired":
                request_id = next(
                    payload["request_id"]
                    for name, payload in emitted
                    if name == event
                )
                if terminal_status == "interrupted":
                    registry.cancel_session("session-a")
                else:
                    registry.respond(request_id, "ignored", status="cancelled")

            worker.join(timeout=1)
            assert not worker.is_alive()
            assert result == ["stop"]


def test_late_browser_block_after_session_stop_is_not_created(monkeypatch) -> None:
    """A CAPTCHA result arriving after Stop must not resurrect its prompt."""

    session_id = "late-browser-stop-session"
    registry = PendingInteractionRegistry()
    emitted: list[str] = []

    class InterruptAgent:
        def interrupt(self) -> None:
            pass

    class LiveThread:
        @staticmethod
        def is_alive() -> bool:
            return True

    server._sessions[session_id] = {
        "_run_thread": LiveThread(),
        "_turn_cancel_requested": False,
        "agent": InterruptAgent(),
        "history_lock": threading.Lock(),
        "queued_prompt": None,
        "running": True,
        "session_key": "late-browser-stop-key",
    }
    monkeypatch.setattr(server, "_pending_interactions", registry)
    monkeypatch.setattr(server, "_end_browser_control", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(server, "_track_product_event", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(
        server,
        "_emit",
        lambda event, _sid, _payload=None: emitted.append(event),
    )
    try:
        stopped = server.handle_request(
            {
                "id": "stop-late-browser-rpc",
                "method": "session.interrupt",
                "params": {"session_id": session_id},
            }
        )
        late_result = server._block(
            "verification.request",
            session_id,
            {"challenge_id": "arrived-after-stop"},
            timeout=0,
            active_turn_only=True,
        )
    finally:
        server._sessions.pop(session_id, None)

    assert stopped["result"] == {"status": "interrupted"}
    assert late_result == "stop"
    assert registry.pending_for_session(session_id) == []
    assert "verification.request" not in emitted


def test_turn_bound_browser_block_after_session_teardown_fails_closed(
    monkeypatch,
) -> None:
    session_id = "removed-before-browser-result"
    registry = PendingInteractionRegistry()
    emitted: list[str] = []
    server._sessions.pop(session_id, None)
    monkeypatch.setattr(server, "_pending_interactions", registry)
    monkeypatch.setattr(
        server,
        "_emit",
        lambda event, _sid, _payload=None: emitted.append(event),
    )

    result = server._block(
        "verification.request",
        session_id,
        {"challenge_id": "orphaned-result"},
        timeout=None,
        active_turn_only=True,
    )

    assert result == "stop"
    assert registry.pending_for_session(session_id) == []
    assert emitted == []


def test_browser_request_publish_is_ordered_before_concurrent_stop(monkeypatch) -> None:
    """Stop cannot return before an already-admitted request is published."""

    session_id = "publish-before-stop-session"
    registry = PendingInteractionRegistry()
    publish_started = threading.Event()
    release_publish = threading.Event()
    stop_reached_agent = threading.Event()
    stop_done = threading.Event()
    order: list[str] = []
    block_result: list[str] = []
    stop_result: list[dict] = []

    class InterruptAgent:
        def interrupt(self) -> None:
            stop_reached_agent.set()

    class LiveThread:
        @staticmethod
        def is_alive() -> bool:
            return True

    server._sessions[session_id] = {
        "_run_thread": LiveThread(),
        "_turn_cancel_requested": False,
        "agent": InterruptAgent(),
        "history_lock": threading.Lock(),
        "queued_prompt": None,
        "running": True,
        "session_key": "publish-before-stop-key",
    }
    monkeypatch.setattr(server, "_pending_interactions", registry)
    monkeypatch.setattr(server, "_end_browser_control", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(server, "_track_product_event", lambda *_args, **_kwargs: None)

    def emit(event: str, _sid: str, _payload=None) -> None:
        if event == "verification.request":
            order.append("request")
            publish_started.set()
            assert release_publish.wait(timeout=1)
        elif event == "interaction.resolved":
            order.append("resolved")

    monkeypatch.setattr(server, "_emit", emit)

    blocker = threading.Thread(
        target=lambda: block_result.append(
            server._block(
                "verification.request",
                session_id,
                {"challenge_id": "publish-first"},
                timeout=2,
                active_turn_only=True,
            )
        )
    )

    def stop_session() -> None:
        stop_result.append(
            server.handle_request(
                {
                    "id": "publish-stop-rpc",
                    "method": "session.interrupt",
                    "params": {"session_id": session_id},
                }
            )
        )
        order.append("stop-returned")
        stop_done.set()

    stopper = threading.Thread(target=stop_session)
    blocker.start()
    assert publish_started.wait(timeout=1)
    stopper.start()
    assert stop_reached_agent.wait(timeout=1)
    try:
        # The request transport write is still inside the admission critical
        # section, so Stop cannot publish its cancellation latch or return yet.
        assert not stop_done.wait(timeout=0.05)
        release_publish.set()
        blocker.join(timeout=1)
        stopper.join(timeout=1)
    finally:
        release_publish.set()
        server._sessions.pop(session_id, None)

    assert not blocker.is_alive()
    assert not stopper.is_alive()
    assert block_result == ["stop"]
    assert stop_result[0]["result"] == {"status": "interrupted"}
    assert order.index("request") < order.index("stop-returned")


def test_approval_uses_same_replayable_idempotent_registry(monkeypatch) -> None:
    registry = PendingInteractionRegistry()
    monkeypatch.setattr(server, "_pending_interactions", registry)
    monkeypatch.setattr(server, "_track_product_event", lambda *_args, **_kwargs: None)
    emitted: list[dict] = []
    ready = threading.Event()

    def emit(event: str, _session_id: str, payload: dict) -> None:
        if event == "approval.request":
            emitted.append(payload)
            ready.set()

    monkeypatch.setattr(server, "_emit", emit)
    result: list[str] = []
    worker = threading.Thread(
        target=lambda: result.append(
            server._request_approval(
                "session-a",
                {"command": "rm -rf /tmp/x", "description": "delete files"},
            )
        )
    )
    worker.start()
    assert ready.wait(timeout=1)
    request_id = emitted[0]["request_id"]
    assert registry.pending_for_session("session-a")[0]["kind"] == "approval"

    first = server._respond(
        "rpc-1",
        {
            "request_id": request_id,
            "session_id": "session-a",
            "choice": "once",
        },
        "choice",
    )
    duplicate = server._respond(
        "rpc-2",
        {
            "request_id": request_id,
            "session_id": "session-a",
            "choice": "deny",
        },
        "choice",
    )
    worker.join(timeout=1)

    assert first["result"] == {"status": "submitted", "accepted": True}
    assert duplicate["result"] == {"status": "submitted", "accepted": False}
    assert result == ["once"]


def test_pending_response_cannot_cross_session_boundary(monkeypatch) -> None:
    registry = PendingInteractionRegistry()
    registry.create("session-a", "approval.request", {}, request_id="approval-a")
    monkeypatch.setattr(server, "_pending_interactions", registry)

    response = server._respond(
        "rpc-1",
        {
            "request_id": "approval-a",
            "session_id": "session-b",
            "choice": "once",
        },
        "choice",
    )

    assert response["error"]["code"] == 4009
    assert registry.get("approval-a").status == "waiting"


def test_pending_response_requires_session_id(monkeypatch) -> None:
    registry = PendingInteractionRegistry()
    registry.create("session-a", "collect.request", {}, request_id="collect-a")
    monkeypatch.setattr(server, "_pending_interactions", registry)

    response = server._respond(
        "rpc-1",
        {"request_id": "collect-a", "result": "{}"},
        "result",
    )

    assert response["error"]["code"] == 4002
    assert registry.get("collect-a").status == "waiting"


def test_verification_auto_response_requires_the_exact_challenge_identity(
    monkeypatch,
) -> None:
    registry = PendingInteractionRegistry()
    registry.create(
        "session-a",
        "verification.request",
        {"challenge_id": "challenge-new"},
        request_id="verification-a",
    )
    monkeypatch.setattr(server, "_pending_interactions", registry)

    stale = server._respond_verification(
        "rpc-stale",
        {
            "answer": "auto",
            "challenge_id": "challenge-old",
            "request_id": "verification-a",
            "session_id": "session-a",
        },
    )
    missing = server._respond_verification(
        "rpc-missing",
        {
            "answer": "auto",
            "request_id": "verification-a",
            "session_id": "session-a",
        },
    )

    assert stale["error"]["code"] == 4009
    assert missing["error"]["code"] == 4009
    assert registry.get("verification-a").status == "waiting"

    matching = server._respond_verification(
        "rpc-matching",
        {
            "answer": "auto",
            "challenge_id": "challenge-new",
            "request_id": "verification-a",
            "session_id": "session-a",
        },
    )
    assert matching["result"] == {"status": "submitted", "accepted": True}

    # Manual Continue remains compatible with restored requests from older
    # versions that do not carry challenge identity metadata.
    registry.create(
        "session-a",
        "verification.request",
        {},
        request_id="verification-legacy",
    )
    manual = server._respond_verification(
        "rpc-manual",
        {
            "answer": "continue",
            "request_id": "verification-legacy",
            "session_id": "session-a",
        },
    )
    assert manual["result"] == {"status": "submitted", "accepted": True}


def test_collect_response_with_unknown_status_fails_closed(monkeypatch) -> None:
    registry = PendingInteractionRegistry()
    registry.create("session-a", "collect.request", {}, request_id="collect-a")
    monkeypatch.setattr(server, "_pending_interactions", registry)

    response = server._respond(
        "rpc-1",
        {
            "request_id": "collect-a",
            "session_id": "session-a",
            "result": json.dumps(
                {
                    "status": "done",
                    "values": {"passport": "must-not-remain"},
                }
            ),
        },
        "result",
    )

    assert response["result"] == {"status": "cancelled", "accepted": True}
    assert registry.get("collect-a").response == ""


def test_session_teardown_cancels_waits_and_clears_transient_values(monkeypatch) -> None:
    registry = PendingInteractionRegistry()
    pending = registry.create(
        "runtime-session-a",
        "collect.request",
        {},
        request_id="collect-teardown",
    )
    monkeypatch.setattr(server, "_pending_interactions", registry)
    monkeypatch.setattr(server, "_finalize_session", lambda _session: None)
    reference = protect_value(
        "P1234567",
        owner="durable-session-a",
        field_type="passport",
    )

    server._teardown_session(
        {"session_key": "durable-session-a", "agent": None},
        sid="runtime-session-a",
    )

    assert registry.wait(pending.request_id, timeout=0).status == "interrupted"
    assert resolve_value_ref(reference, owner="durable-session-a") is None


def test_background_teardown_rejects_late_prompt_and_closes_agent_on_unwind(
    monkeypatch,
) -> None:
    class BackgroundAgent:
        def __init__(self) -> None:
            self.interrupts = 0
            self.closes = 0

        def interrupt(self) -> None:
            self.interrupts += 1

        def close(self) -> None:
            self.closes += 1

    agent = BackgroundAgent()
    cancelled = threading.Event()
    record = {
        "agent": agent,
        "cancelled": cancelled,
        "closed": False,
        "lock": threading.Lock(),
    }
    session = {
        "agent": None,
        "history_lock": threading.Lock(),
        "prompt_background_tasks": {"bg-test": record},
        "session_key": "durable-session-bg",
    }
    monkeypatch.setitem(server._sessions, "runtime-session-bg", session)
    monkeypatch.setattr(server, "_finalize_session", lambda _session: None)

    server._teardown_session(session, sid="runtime-session-bg")

    assert cancelled.is_set()
    assert agent.interrupts == 1
    assert agent.closes == 0
    late, _ = server._admit_pending_interaction(
        "verification.request",
        "runtime-session-bg",
        {},
        active_turn_only=False,
        live_session_only=True,
    )
    assert late is None

    # The daemon owns final cleanup after interrupt makes its run unwind.
    server._close_prompt_background_agent(record, interrupt=False)
    assert agent.closes == 1
