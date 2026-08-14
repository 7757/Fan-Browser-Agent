from __future__ import annotations

import json
import threading
from typing import Any

from tools import browser_program_tool
from tui_gateway import server
from tui_gateway.pending_interactions import PendingInteractionRegistry


def _page(
    url: str,
    text: str,
    *,
    captcha_state: dict[str, Any],
) -> dict[str, Any]:
    return {
        "url": url,
        "title": "Browser program integration fixture",
        "browserUseText": text,
        "snapshot": {"interactiveCount": 1},
        "captchaState": captcha_state,
        "__fanDecisionToken": {
            "version": 1,
            "sessionId": "gateway-human-session",
            "activeTabId": "tab-1",
            "viewEpoch": 1,
            "documentRevision": 12,
            "pageGeneration": 2,
            "selectorGeneration": 3,
            "tabListGeneration": 1,
        },
    }


class _ProgramClient:
    available = True

    def __init__(self, *, snapshots: list[dict[str, Any]] | None = None) -> None:
        self.calls: list[tuple[str, dict[str, Any]]] = []
        self._snapshots = list(snapshots or [])
        self._lock = threading.Lock()

    def call(self, action: str, **kwargs: Any) -> dict[str, Any]:
        with self._lock:
            self.calls.append((action, kwargs))
            if action == "programRun":
                return {
                    "runId": "runtime-slider-run",
                    # This is the original false-completion shape: the
                    # transaction settled but a human-only challenge remains.
                    "status": "completed",
                    "value": {"submitted": True},
                    "url": "https://example.test/slider",
                    "captchaState": {
                        "detected": True,
                        "kind": "behavioral",
                        "requiresUserInput": True,
                        "challengeId": "slider-gateway-1",
                        "documentRevision": 11,
                    },
                    "effect": {
                        "occurred": True,
                        "uncertain": False,
                        "kinds": ["external-submit"],
                    },
                }
            if action == "programHandoff":
                return {"status": "needs_human", "stopped": True}
            if action == "programSnapshot" and self._snapshots:
                return self._snapshots.pop(0)
        raise AssertionError(f"unexpected browser program RPC: {action}")

    def called_actions(self) -> list[str]:
        with self._lock:
            return [action for action, _kwargs in self.calls]


class _InterruptAgent:
    def __init__(self) -> None:
        self.interrupt_count = 0

    def interrupt(self) -> None:
        self.interrupt_count += 1


def _start_browser_run(
    monkeypatch,
    *,
    session_id: str,
    client: _ProgramClient,
) -> tuple[
    threading.Thread,
    threading.Event,
    list[tuple[str, str, dict[str, Any]]],
    list[str],
    list[BaseException],
    PendingInteractionRegistry,
    _InterruptAgent,
]:
    registry = PendingInteractionRegistry()
    request_emitted = threading.Event()
    emitted: list[tuple[str, str, dict[str, Any]]] = []
    emitted_lock = threading.Lock()
    results: list[str] = []
    failures: list[BaseException] = []
    agent = _InterruptAgent()

    def emit(event: str, sid: str, payload: dict[str, Any]) -> None:
        with emitted_lock:
            emitted.append((event, sid, dict(payload)))
        if event == "verification.request":
            request_emitted.set()

    monkeypatch.setattr(server, "_pending_interactions", registry)
    monkeypatch.setattr(server, "_emit", emit)
    monkeypatch.setattr(
        server,
        "_track_product_event",
        lambda *_args, **_kwargs: None,
    )
    monkeypatch.setattr(browser_program_tool, "_client", lambda: client)

    def run_tool() -> None:
        try:
            # This is the production turn wiring. The callbacks are
            # thread-local, so tool execution must remain on this thread.
            server._wire_callbacks(session_id)
            results.append(
                browser_program_tool._browser_run(
                    {
                        "intent": "submit once and wait for the slider",
                        "code": "await fan.click(fan.ref(9));",
                    },
                    task_id=session_id,
                    tool_call_id="gateway-slider-tool-call",
                )
            )
        except BaseException as exc:  # pragma: no cover - surfaced by assertions
            failures.append(exc)

    worker = threading.Thread(target=run_tool, daemon=True)
    server._sessions[session_id] = {
        "_run_thread": worker,
        "_turn_cancel_requested": False,
        "agent": agent,
        "history_lock": threading.Lock(),
        "queued_prompt": None,
        "running": True,
        "session_key": f"{session_id}-key",
    }
    worker.start()
    return (
        worker,
        request_emitted,
        emitted,
        results,
        failures,
        registry,
        agent,
    )


def _verification_request(
    emitted: list[tuple[str, str, dict[str, Any]]],
) -> dict[str, Any]:
    return next(
        payload
        for event, _session_id, payload in emitted
        if event == "verification.request"
    )


def test_gateway_verification_blocks_until_fresh_snapshot_can_replan(
    monkeypatch,
) -> None:
    session_id = "gateway-human-session"
    client = _ProgramClient(
        snapshots=[
            _page(
                "https://example.test/result",
                "[1]<main>Verified result page</main>",
                captcha_state={"detected": False},
            )
        ]
    )
    (
        worker,
        request_emitted,
        emitted,
        results,
        failures,
        registry,
        _agent,
    ) = _start_browser_run(
        monkeypatch,
        session_id=session_id,
        client=client,
    )

    try:
        assert request_emitted.wait(timeout=2)
        request = _verification_request(emitted)

        assert request["session_id"] == session_id
        assert request["kind"] == "verification"
        assert request["challenge_id"] == "slider-gateway-1"
        assert request["captcha_type"] == "behavioral"
        assert request["status"] == "waiting"
        assert registry.pending_kind(session_id) == "verification"

        # The handoff is already visible, but the tool has not completed and
        # no post-human snapshot (or next model turn) can run yet.
        assert worker.is_alive()
        assert results == []
        assert failures == []
        assert client.called_actions() == ["programRun", "programHandoff"]

        response = server.handle_request(
            {
                "jsonrpc": "2.0",
                "id": "verification-auto-response",
                "method": "verification.respond",
                "params": {
                    "answer": "auto",
                    "challenge_id": request["challenge_id"],
                    "request_id": request["request_id"],
                    "session_id": session_id,
                },
            }
        )
        assert response is not None
        assert response["result"] == {"status": "submitted", "accepted": True}

        worker.join(timeout=2)
        assert not worker.is_alive()
        assert failures == []
        assert len(results) == 1

        data = json.loads(results[0])
        assert data["status"] == "needs_replan"
        assert data["replan_required"] is True
        assert data["url"] == "https://example.test/result"
        assert "Verified result page" in data["final_snapshot"]
        assert data["boundary"] == {
            "code": "BROWSER_HUMAN_CONTROL_RESUMED",
            "message": (
                "The user completed the human-only browser step. Replan from "
                "this fresh snapshot; do not replay the previous browser program."
            ),
            "kind": "verification",
        }
        assert data["run_effect"]["kinds"] == ["external-submit"]
        assert client.called_actions() == [
            "programRun",
            "programHandoff",
            "programSnapshot",
        ]
        assert any(
            event == "interaction.resolved"
            and payload["request_id"] == request["request_id"]
            and payload["status"] == "submitted"
            for event, _sid, payload in emitted
        )
    finally:
        registry.cancel_session(session_id)
        worker.join(timeout=1)
        server._sessions.pop(session_id, None)


def test_gateway_interrupt_stops_blocked_program_without_followup_snapshot(
    monkeypatch,
) -> None:
    session_id = "gateway-human-stop-session"
    client = _ProgramClient(
        snapshots=[
            _page(
                "https://example.test/must-not-be-read",
                "[1]<main>This snapshot must not be consumed</main>",
                captcha_state={"detected": False},
            )
        ]
    )
    (
        worker,
        request_emitted,
        emitted,
        results,
        failures,
        registry,
        agent,
    ) = _start_browser_run(
        monkeypatch,
        session_id=session_id,
        client=client,
    )

    try:
        assert request_emitted.wait(timeout=2)
        request = _verification_request(emitted)
        assert worker.is_alive()
        assert results == []

        response = server.handle_request(
            {
                "jsonrpc": "2.0",
                "id": "stop-blocked-browser-run",
                "method": "session.interrupt",
                "params": {"session_id": session_id},
            }
        )
        assert response is not None
        assert response["result"] == {"status": "interrupted"}

        worker.join(timeout=2)
        assert not worker.is_alive()
        assert failures == []
        assert agent.interrupt_count == 1
        assert len(results) == 1

        data = json.loads(results[0])
        assert data["status"] == "failed_after_effect"
        assert data["error"]["code"] == "HUMAN_CONTROL_STOPPED"
        assert data["do_not_retry"] is True
        assert data["run_effect"]["occurred"] is True
        assert "final_snapshot" not in data
        assert client.called_actions() == ["programRun", "programHandoff"]
        assert registry.pending_for_session(session_id) == []
        assert any(
            event == "interaction.resolved"
            and payload["request_id"] == request["request_id"]
            and payload["status"] == "interrupted"
            for event, _sid, payload in emitted
        )
    finally:
        registry.cancel_session(session_id)
        worker.join(timeout=1)
        server._sessions.pop(session_id, None)
