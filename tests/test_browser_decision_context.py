from __future__ import annotations

import json
import threading
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import tools.electron_browser_tool as browser_tool
from agent.electron_browser_client import ElectronBrowserRuntimeError
from agent.tool_executor import _browser_decision_context


def _token(selector_generation: int) -> dict:
    return {
        "version": 1,
        "sessionId": "session-a",
        "activeTabId": "session-a",
        "viewEpoch": 2,
        "documentRevision": 3,
        "pageGeneration": 1,
        "selectorGeneration": selector_generation,
        "tabListGeneration": 0,
    }


def test_state_bound_rpc_carries_token_and_refreshes_internal_composite_state(monkeypatch):
    client = MagicMock()
    client.call.return_value = {
        "clicked": 3,
        "__fanDecisionToken": _token(9),
    }
    monkeypatch.setattr(browser_tool, "_client", lambda: client)
    browser_tool.set_browser_decision_context(_token(8), required=True)
    try:
        result = browser_tool._call("click", {"index": 3}, task_id="session-a")
        assert result == {"clicked": 3}
        assert client.call.call_args.kwargs["params"]["_fanDecisionToken"] == _token(8)
        assert browser_tool.current_browser_decision_token() == _token(9)
    finally:
        browser_tool.clear_browser_decision_context()


def test_executor_captures_browser_state_before_and_after_each_tool():
    agent = SimpleNamespace(_browser_decision_token=_token(8))

    with _browser_decision_context(agent, "browser_click"):
        assert browser_tool.current_browser_decision_token() == _token(8)
        browser_tool._refresh_browser_decision_token(_token(9))
        browser_tool._refresh_browser_observation_token(_token(9))

    assert agent._browser_last_tool_state_before == _token(8)
    assert agent._browser_last_tool_state_after == _token(9)
    assert agent._browser_last_observation_state_after == _token(9)
    assert browser_tool.current_browser_decision_token() is None
    assert browser_tool.current_browser_observation_token() is None


def test_auxiliary_rpc_cannot_rebind_the_model_visible_observation():
    client = MagicMock()

    def call(action, **_kwargs):
        if action == "liveState":
            return {
                "tabs": [
                    {
                        "current": True,
                        "targetId": "session-a",
                        "url": "https://example.test/",
                    }
                ]
            }
        if action == "observe":
            return {"text": "page", "__fanDecisionToken": _token(9)}
        if action == "screenshot":
            return {"data": "image", "__fanDecisionToken": _token(10)}
        raise AssertionError(action)

    client.call.side_effect = call
    browser_tool.set_browser_decision_context(_token(8), required=True)
    try:
        with patch.object(browser_tool, "_client", return_value=client):
            browser_tool._call("observe", {}, guard=False, task_id="session-a")
            browser_tool._call("screenshot", {}, task_id="session-a")

        assert browser_tool.current_browser_decision_token() == _token(10)
        assert browser_tool.current_browser_observation_token() == _token(9)
    finally:
        browser_tool.clear_browser_decision_context()


def test_fill_form_binds_its_final_observation_to_the_fresh_token(monkeypatch):
    client = MagicMock()
    client.call.return_value = {
        "status": "completed",
        "observation": {
            "url": "https://example.com/form",
            "text": "[9]<button>Submit",
        },
        "__fanDecisionToken": _token(9),
    }
    monkeypatch.setattr(browser_tool, "_client", lambda: client)
    browser_tool.set_browser_decision_context(_token(8), required=True)
    try:
        result = browser_tool._call(
            "fillForm",
            {"fields": [{"index": 3, "text": "Ada"}]},
            task_id="session-a",
        )

        assert result["observation"] == {
            "url": "https://example.com/form",
            "text": "[9]<button>Submit",
        }
        assert browser_tool.current_browser_decision_token() == _token(9)
        assert browser_tool.current_browser_observation_token() == _token(9)
    finally:
        browser_tool.clear_browser_decision_context()


def test_missing_decision_token_fails_closed_without_rpc(monkeypatch):
    client = MagicMock()
    monkeypatch.setattr(browser_tool, "_client", lambda: client)
    browser_tool.set_browser_decision_context(None, required=True)
    try:
        result = browser_tool._call("click", {"index": 3}, task_id="session-a")
        assert result["__error_code__"] == "BROWSER_DECISION_TOKEN_MISSING"
        assert result["__error_details__"]["replanRequired"] is True
        client.call.assert_not_called()
    finally:
        browser_tool.clear_browser_decision_context()


def test_observe_can_establish_token_when_the_request_started_without_one(monkeypatch):
    client = MagicMock()

    def call(action, **_kwargs):
        if action == "liveState":
            return {
                "tabs": [
                    {
                        "current": True,
                        "targetId": "session-a",
                        "url": "https://example.test/",
                    }
                ]
            }
        assert action == "observe"
        return {
            "text": "page",
            "__fanDecisionToken": _token(4),
        }

    client.call.side_effect = call
    monkeypatch.setattr(browser_tool, "_client", lambda: client)
    browser_tool.set_browser_decision_context(None, required=True)
    try:
        result = browser_tool._call("observe", {}, guard=False, task_id="session-a")
        assert result == {"text": "page"}
        assert browser_tool.current_browser_decision_token() == _token(4)
        observe_call = next(call for call in client.call.call_args_list if call.args[0] == "observe")
        assert "_fanDecisionToken" not in observe_call.kwargs["params"]
    finally:
        browser_tool.clear_browser_decision_context()


def test_action_success_with_failed_trailing_observe_explicitly_requests_replan(monkeypatch):
    class Client:
        def call(self, action, *, workbench_id, params, **_kwargs):
            assert workbench_id == "session-a"
            if action == "liveState":
                return {
                    "tabs": [
                        {
                            "current": True,
                            "targetId": "session-a",
                            "url": "https://example.test/",
                        }
                    ]
                }
            if action == "click":
                return {"clicked": 3, "__fanDecisionToken": _token(9)}
            if action == "observe":
                raise ElectronBrowserRuntimeError("observe timed out")
            raise AssertionError(action)

    monkeypatch.setattr(browser_tool, "_client", Client)
    browser_tool.set_browser_decision_context(_token(8), required=True)
    try:
        result = json.loads(browser_tool._browser_click({"index": 3}, task_id="session-a"))
    finally:
        browser_tool.clear_browser_decision_context()

    assert result["result"]["clicked"] == 3
    assert result["replan_required"] is True
    assert "observe timed out" in result["observe_error"]
    assert "dom" not in result


def test_mutation_timeout_uses_action_status_without_replaying_the_action(monkeypatch):
    calls = []

    class Client:
        def call(self, action, *, workbench_id, params, action_id=None, **_kwargs):
            calls.append((action, action_id, params))
            if action == "click":
                raise ElectronBrowserRuntimeError(
                    "timed out",
                    code="RUNTIME_REQUEST_TIMEOUT",
                )
            if action == "actionStatus":
                return {"status": "completed", "result": {"clicked": 3}}
            raise AssertionError(action)

    monkeypatch.setattr(browser_tool, "_client", Client)
    result = browser_tool._call("click", {"index": 3}, task_id="session-a")

    assert result == {"clicked": 3}
    assert [action for action, _action_id, _params in calls] == ["click", "actionStatus"]
    assert calls[0][1]
    assert calls[1][1] == calls[0][1]


def test_unknown_mutation_timeout_is_nonretryable(monkeypatch):
    class Client:
        def call(self, action, **_kwargs):
            if action == "click":
                raise ElectronBrowserRuntimeError(
                    "timed out",
                    code="RUNTIME_REQUEST_TIMEOUT",
                )
            if action == "actionStatus":
                return {"status": "running"}
            raise AssertionError(action)

    monkeypatch.setattr(browser_tool, "_client", Client)
    result = browser_tool._call("click", {"index": 3}, task_id="session-a")

    assert result["__error_code__"] == "ACTION_TIMEOUT_PENDING"
    assert result["__error_details__"]["retryable"] is False
    assert result["__error_details__"]["replanRequired"] is True


def test_failed_mutation_status_preserves_the_runtime_error(monkeypatch):
    class Client:
        def call(self, action, **_kwargs):
            if action == "click":
                raise ElectronBrowserRuntimeError(
                    "timed out",
                    code="RUNTIME_REQUEST_TIMEOUT",
                )
            if action == "actionStatus":
                return {
                    "status": "failed",
                    "error": {
                        "ok": False,
                        "error": "target changed",
                        "errorCode": "CLICK_TARGET_MISMATCH",
                        "errorDetails": {"retryable": True, "replanRequired": True},
                    },
                }
            raise AssertionError(action)

    monkeypatch.setattr(browser_tool, "_client", Client)
    result = browser_tool._call("click", {"index": 3}, task_id="session-a")

    assert result["__error__"] == "target changed"
    assert result["__error_code__"] == "CLICK_TARGET_MISMATCH"
    assert result["__error_details__"] == {"retryable": True, "replanRequired": True}


def test_decision_tokens_are_isolated_between_concurrent_session_threads(monkeypatch):
    gate = threading.Barrier(2)
    captured: dict[str, dict] = {}

    class Client:
        def call(self, _action, *, workbench_id, params, **_kwargs):
            gate.wait(timeout=2)
            captured[workbench_id] = params["_fanDecisionToken"]
            return {"ok": True, "__fanDecisionToken": params["_fanDecisionToken"]}

    monkeypatch.setattr(browser_tool, "_client", Client)

    def run(session_id: str, generation: int):
        token = {**_token(generation), "sessionId": session_id, "activeTabId": session_id}
        browser_tool.set_browser_decision_context(token, required=True)
        try:
            browser_tool._call("click", {"index": generation}, task_id=session_id)
        finally:
            browser_tool.clear_browser_decision_context()

    first = threading.Thread(target=run, args=("session-a", 11))
    second = threading.Thread(target=run, args=("session-b", 22))
    first.start()
    second.start()
    first.join(timeout=3)
    second.join(timeout=3)

    assert not first.is_alive() and not second.is_alive()
    assert captured["session-a"]["selectorGeneration"] == 11
    assert captured["session-b"]["selectorGeneration"] == 22
