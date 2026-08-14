from __future__ import annotations

import json
import os
import re
from pathlib import Path
from types import SimpleNamespace

import pytest

import tools.browser_program_tool as program_tool
from agent.display import _build_tool_preview_unguarded, _detect_tool_failure
from agent.electron_browser_client import ElectronBrowserRuntimeError
from agent.tool_guardrails import ToolCallGuardrailController
from agent.prompt_builder import (
    BROWSER_PROGRAM_TOOL_GUIDANCE,
    ELECTRON_BROWSER_TOOL_GUIDANCE,
)
from agent.system_prompt import build_system_prompt_parts
from fan_cli.invocation_context import (
    reset_current_invocation_session,
    set_current_invocation_session,
)
from tools.electron_browser_context import (
    clear_browser_decision_context,
    current_browser_decision_token,
    current_browser_observation_token,
    set_browser_decision_context,
)
from tools.registry import discover_builtin_tools, registry
from tools.tool_search import is_deferrable_tool_name
from toolsets import TOOLSETS


ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture(autouse=True)
def _clear_recent_verification_receipt():
    program_tool._clear_recent_verification_completion()
    yield
    program_tool._clear_recent_verification_completion()


class _Client:
    def __init__(self, responses):
        self.responses = responses
        self.calls = []
        self.available = True

    def call(self, action, **kwargs):
        self.calls.append((action, kwargs))
        response = self.responses[action]
        if isinstance(response, list):
            response = response.pop(0)
        if isinstance(response, Exception):
            raise response
        return response


def _snapshot(token: dict | None = None) -> dict:
    result = {
        "url": "https://www.baidu.com/",
        "title": "百度一下",
        "tabs": [
            {
                "stableId": "tab-1",
                "current": True,
                "title": "百度一下",
                "url": "https://www.baidu.com/",
            }
        ],
        "browserUseText": "[53]<textarea role=textbox name=搜索>",
        "snapshot": {"interactiveCount": 1},
    }
    if token is not None:
        result["__fanDecisionToken"] = token
    return result


def _patch_client(monkeypatch, responses):
    client = _Client(responses)
    monkeypatch.setattr(program_tool, "_client", lambda: client)
    return client


def test_program_toolset_registers_exactly_three_small_schemas(monkeypatch):
    monkeypatch.setenv("ELECTRON_BROWSER_RUNTIME_URL", "http://runtime.test/rpc")
    monkeypatch.setenv("ELECTRON_BROWSER_RUNTIME_TOKEN", "secret")
    discover_builtin_tools()

    names = {"browser_snapshot", "browser_run", "browser_handoff"}
    assert set(TOOLSETS["browser_program"]["tools"]) == names
    assert set(registry.get_tool_names_for_toolset("browser_program")) == names

    definitions = registry.get_definitions(names, quiet=True)
    encoded = json.dumps(
        definitions,
        ensure_ascii=False,
        separators=(",", ":"),
    ).encode("utf-8")
    assert len(encoded) < 8 * 1024
    assert is_deferrable_tool_name("browser_snapshot") is False
    assert is_deferrable_tool_name("browser_run") is False
    assert is_deferrable_tool_name("browser_handoff") is False
    assert is_deferrable_tool_name("browser_observe") is True

    run_definition = next(
        definition
        for definition in definitions
        if definition["function"]["name"] == "browser_run"
    )
    run_schema = run_definition["function"]
    assert "fresh isolated scope" in run_schema["description"]
    assert "variables from an earlier browser_run never persist" in (
        run_schema["description"]
    )
    assert "const snapshot = await fan.observe()" in (
        run_schema["parameters"]["properties"]["code"]["description"]
    )
    handoff_schema = next(
        definition
        for definition in definitions
        if definition["function"]["name"] == "browser_handoff"
    )["function"]
    assert "Auto-detected verification already blocks and resumes" in (
        handoff_schema["description"]
    )


def test_snapshot_reuses_observation_envelope_and_hides_private_token(monkeypatch):
    token = {
        "version": 1,
        "sessionId": "session-1",
        "activeTabId": "tab-1",
        "viewEpoch": 2,
        "documentRevision": 3,
        "pageGeneration": 4,
        "selectorGeneration": 5,
        "tabListGeneration": 1,
    }
    client = _patch_client(monkeypatch, {"programSnapshot": _snapshot(token)})
    set_browser_decision_context(None, required=True)
    try:
        raw = program_tool._browser_snapshot({}, task_id="session-1")
        decision = current_browser_decision_token()
        observation = current_browser_observation_token()
    finally:
        clear_browser_decision_context()

    data = json.loads(raw)
    assert data["status"] == "completed"
    assert data["effect"] == "snapshot-refresh"
    assert "<page_observation>" in data["snapshot"]
    assert "[53]<textarea" in data["snapshot"]
    assert "browser_" not in data["snapshot"]
    assert "__fanDecisionToken" not in raw
    assert decision == token
    assert observation == token

    action, call = client.calls[0]
    assert action == "programSnapshot"
    assert call["workbench_id"] == "session-1"
    assert call["params"] == {
        "scope": "active_page",
        "includeScreenshot": False,
    }
    assert call["action_id"] is None


def test_program_snapshot_scroll_markers_are_directly_executable(monkeypatch):
    observed = _snapshot()
    observed["browserUseText"] = (
        "[↑ ~1.5 screen(s) above — browser_scroll up to reveal]\n"
        "[53]<textarea role=textbox name=搜索>\n"
        "[↓ ~2 screen(s) below — browser_scroll down to reveal]"
    )
    _patch_client(monkeypatch, {"programSnapshot": observed})

    data = json.loads(
        program_tool._browser_snapshot({}, task_id="session-1")
    )

    assert "fan.scroll({up: true, pages: 1})" in data["snapshot"]
    assert "fan.scroll({down: true, pages: 1})" in data["snapshot"]
    assert "fan.scroll up to reveal" not in data["snapshot"]
    assert "browser_scroll" not in data["snapshot"]


def test_program_errors_never_recommend_absent_legacy_browser_tools():
    raw = program_tool._runtime_error(
        ElectronBrowserRuntimeError(
            "option not found",
            code="DROPDOWN_OPTION_NOT_FOUND",
            details={"options": [{"text": "Alpha", "value": "a"}]},
        )
    )

    assert "fan.dropdownOptions" in raw
    assert "fan.select" in raw
    assert "browser_dropdown_options" not in raw
    assert "browser_select" not in raw


def test_run_forwards_initial_token_and_returns_bound_final_snapshot(monkeypatch):
    initial = {
        "version": 1,
        "sessionId": "session-1",
        "activeTabId": "tab-1",
        "viewEpoch": 1,
        "documentRevision": 1,
        "pageGeneration": 1,
        "selectorGeneration": 1,
        "tabListGeneration": 1,
    }
    final = {**initial, "documentRevision": 2, "selectorGeneration": 2}
    client = _patch_client(
        monkeypatch,
        {
            "programRun": {
                "runId": "runtime-run",
                "status": "needs_replan",
                "value": {"candidates": 2},
                "trace": [{"step": 1, "action": "navigate"}],
                "effect": {
                    "occurred": True,
                    "uncertain": False,
                    "kinds": ["navigation"],
                },
                "error": {
                    "code": "BROWSER_REPLAN_REQUIRED",
                    "message": "choose one candidate",
                },
                "finalSnapshot": _snapshot(final),
            }
        },
    )
    set_browser_decision_context(initial, required=True)
    try:
        raw = program_tool._browser_run(
            {
                "intent": "open search",
                "code": 'await fan.navigate("https://www.baidu.com/");',
                "timeout_ms": 20_000,
            },
            task_id="session-1",
            tool_call_id="call-1",
        )
        decision = current_browser_decision_token()
        observation = current_browser_observation_token()
    finally:
        clear_browser_decision_context()

    data = json.loads(raw)
    assert data["status"] == "needs_replan"
    assert data["replan_required"] is True
    assert data["run_id"] == "runtime-run"
    assert data["effect"] == "snapshot-refresh"
    assert data["run_effect"]["kinds"] == ["navigation"]
    assert data["boundary"]["code"] == "BROWSER_REPLAN_REQUIRED"
    assert "error" not in data
    assert _detect_tool_failure("browser_run", raw) == (False, "")
    assert "<page_observation>" in data["final_snapshot"]
    assert "__fanDecisionToken" not in raw
    assert decision == final
    assert observation == final

    action, call = client.calls[0]
    assert action == "programRun"
    assert call["params"] == {
        "intent": "open search",
        "code": 'await fan.navigate("https://www.baidu.com/");',
        "timeoutMs": 20_000,
        "_fanDecisionToken": initial,
    }
    assert call["timeout"] == 35.0
    assert re.fullmatch(
        r"[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}",
        call["action_id"],
    )


def test_desktop_run_forwards_the_current_control_turn(monkeypatch):
    client = _patch_client(
        monkeypatch,
        {
            "programRun": {
                "runId": "controlled-run",
                "status": "completed",
                "value": "done",
                "effect": {
                    "occurred": False,
                    "uncertain": False,
                    "kinds": [],
                },
            }
        },
    )
    token = set_current_invocation_session(
        "stored-session",
        ui_session_id="runtime-session",
        control_id="control-turn-1",
    )
    try:
        data = json.loads(
            program_tool._browser_run(
                {"intent": "inspect the current page", "code": "return 'done'"},
                task_id="session-1",
                tool_call_id="call-controlled-run",
            )
        )
    finally:
        reset_current_invocation_session(token)

    assert data["status"] == "completed"
    assert client.calls[0][1]["params"]["_fanControlId"] == "control-turn-1"


def test_needs_human_blocks_for_verification_and_resumes_from_fresh_snapshot(
    monkeypatch,
):
    args = {
        "intent": "submit once and stop for verification",
        "code": "await fan.click(fan.ref(9))",
    }
    fresh = _snapshot()
    fresh["url"] = "https://example.test/verified"
    fresh["captchaState"] = {"detected": False}
    client = _patch_client(
        monkeypatch,
        {
            "programRun": {
                "runId": "runtime-human-effect",
                "status": "needs_human",
                "value": None,
                "trace": [{"step": 1, "method": "click", "status": "completed"}],
                "effect": {
                    "occurred": True,
                    "uncertain": False,
                    "kinds": ["external-submit"],
                },
                "error": {
                    "code": "BROWSER_HUMAN_VERIFICATION_REQUIRED",
                    "message": "Human verification is required",
                },
                "finalSnapshot": None,
            },
            "programHandoff": {"status": "needs_human", "stopped": True},
            "programSnapshot": [
                {
                    **_snapshot(),
                    "url": "https://example.test/verification",
                    "captchaState": {
                        "detected": True,
                        "kind": "behavioral",
                        "requiresUserInput": True,
                        "challengeId": "slider-a",
                        "documentRevision": 7,
                    },
                },
                fresh,
            ],
        },
    )
    callback_meta = []
    monkeypatch.setattr(
        program_tool,
        "_browser_callbacks",
        lambda: (lambda meta: callback_meta.append(meta) or "continue", None),
    )

    raw = program_tool._browser_run(
        args,
        task_id="session-1",
        tool_call_id="call-human-effect",
    )
    data = json.loads(raw)

    assert data["status"] == "needs_replan"
    assert data["replan_required"] is True
    assert data["run_effect"] == {
        "occurred": True,
        "uncertain": False,
        "kinds": ["external-submit"],
    }
    assert data["effect"] == "snapshot-refresh"
    assert data["url"] == "https://example.test/verified"
    assert "<page_observation>" in data["final_snapshot"]
    assert data["boundary"]["code"] == "BROWSER_HUMAN_CONTROL_RESUMED"
    assert callback_meta == [
        {
            "kind": "verification",
            "captcha_type": "behavioral",
            "challenge_id": "slider-a",
            "document_revision": 7,
            "url": "https://example.test/verification",
            "message": (
                "需要人工验证 — 请在浏览器中完成验证，Agent 会在你完成后继续"
            ),
        }
    ]
    assert [action for action, _call in client.calls] == [
        "programRun",
        "programHandoff",
        "programSnapshot",
        "programSnapshot",
    ]

    guardrails = ToolCallGuardrailController()
    guardrails.after_call("browser_run", args, raw, failed=False)
    decision = guardrails.before_call(
        "browser_run",
        {**args, "intent": "try the same submit again"},
    )
    assert decision.action == "skip"
    assert decision.code == "browser_program_effect_replay_blocked"


def test_immediate_handoff_after_verification_resume_is_suppressed(
    monkeypatch,
):
    challenge = {
        "detected": True,
        "kind": "behavioral",
        "requiresUserInput": True,
        "challengeId": "slider-complete-once",
    }
    verified = {
        **_snapshot(),
        "url": "https://example.test/verified",
        "captchaState": {"detected": False},
        "interventionPending": False,
    }
    client = _patch_client(
        monkeypatch,
        {
            "programRun": {
                "runId": "runtime-verification-once",
                "status": "needs_human",
                "captchaState": challenge,
                "url": "https://example.test/challenge",
                "effect": {
                    "occurred": False,
                    "uncertain": False,
                    "kinds": [],
                },
            },
            "programHandoff": {"status": "needs_human", "stopped": True},
            "programSnapshot": [verified, verified],
        },
    )
    verification_prompts = []
    control_prompts = []
    monkeypatch.setattr(
        program_tool,
        "_browser_callbacks",
        lambda: (
            lambda meta: verification_prompts.append(meta) or "auto",
            lambda meta: control_prompts.append(meta) or "continue",
        ),
    )
    call_context = {
        "task_id": "session-1",
        "user_task": "完成滑块验证后继续页面任务",
    }

    resumed = json.loads(
        program_tool._browser_run(
            {
                "intent": "等待用户完成滑块",
                "code": "await fan.click(fan.ref(9));",
            },
            **call_context,
            tool_call_id="call-verification",
        )
    )
    redundant = json.loads(
        program_tool._browser_handoff(
            {
                "reason": "请用户完成刚才的滑块验证",
                "instructions": "请拖动滑块。",
            },
            **call_context,
            tool_call_id="call-redundant-handoff",
        )
    )

    assert resumed["boundary"]["code"] == "BROWSER_HUMAN_CONTROL_RESUMED"
    assert redundant["status"] == "needs_replan"
    assert redundant["replan_required"] is True
    assert redundant["boundary"] == {
        "code": "BROWSER_REDUNDANT_HANDOFF_SKIPPED",
        "message": (
            "The previous browser verification is already complete. No new "
            "human-control prompt was opened. Continue from this fresh snapshot."
        ),
        "kind": "verification",
    }
    assert redundant["url"] == "https://example.test/verified"
    assert "<page_observation>" in redundant["final_snapshot"]
    assert len(verification_prompts) == 1
    assert control_prompts == []
    assert [action for action, _call in client.calls] == [
        "programRun",
        "programHandoff",
        "programSnapshot",
        "programSnapshot",
    ]


def test_snapshot_returns_requested_screenshot_as_multimodal(monkeypatch):
    observed = _snapshot()
    observed["screenshot"] = {
        "data": "ZmFrZS1qcGVn",
        "format": "jpeg",
        "width": 100,
        "height": 80,
        "visualEvidenceToken": "coordinate-action-token-not-an-image",
        "captchaState": {
            "detected": True,
            "matches": [{"text": "must not be duplicated"}],
        },
        "interventionPending": False,
        "actionId": "private-action-id",
    }
    _patch_client(monkeypatch, {"programSnapshot": observed})

    result = program_tool._browser_snapshot(
        {"include_screenshot": True},
        task_id="session-1",
    )

    assert isinstance(result, dict)
    assert result["_multimodal"] is True
    assert result["content"][1]["image_url"]["url"] == (
        "data:image/jpeg;base64,ZmFrZS1qcGVn"
    )
    assert "ZmFrZS1qcGVn" not in result["text_summary"]
    summary = json.loads(result["text_summary"])
    public_screenshot = summary["screenshot"]
    assert public_screenshot["format"] == "jpeg"
    assert public_screenshot["width"] == 100
    assert public_screenshot["height"] == 80
    assert public_screenshot["imageAttached"] is True
    assert public_screenshot["reusableImageSource"] is False
    assert "exact path returned by fan.saveScreenshot" in (
        public_screenshot["visionUsage"]
    )
    for private_key in (
        "visualEvidenceToken",
        "captchaState",
        "interventionPending",
        "actionId",
    ):
        assert private_key not in public_screenshot
        assert private_key not in result["text_summary"]
        assert private_key not in result["screenshot"]


def test_run_rejects_oversize_code_before_rpc(monkeypatch):
    client = _patch_client(monkeypatch, {})
    raw = program_tool._browser_run(
        {"intent": "too large", "code": "界" * 30_000},
        task_id="session-1",
    )

    data = json.loads(raw)
    assert data["code"] == "BROWSER_PROGRAM_CODE_TOO_LARGE"
    assert client.calls == []


def test_run_timeout_is_unknown_and_never_replayed(monkeypatch):
    client = _patch_client(
        monkeypatch,
        {
            "programRun": ElectronBrowserRuntimeError(
                "timed out",
                code="RUNTIME_REQUEST_TIMEOUT",
            ),
            "actionStatus": {"status": "running"},
            "programStop": {"stopped": True},
        },
    )
    raw = program_tool._browser_run(
        {"intent": "submit once", "code": "return {ok:true};"},
        task_id="session-1",
        tool_call_id="call-timeout",
    )

    data = json.loads(raw)
    assert data["status"] == "unknown_after_effect"
    assert data["do_not_retry"] is True
    assert data["recovery"] == {
        "required": True,
        "tool": "browser_snapshot",
        "reason": "establish-settled-page-state",
    }
    assert "final_snapshot" not in data
    assert data.get("effect") != "snapshot-refresh"
    assert len([call for call in client.calls if call[0] == "programRun"]) == 1
    assert len([call for call in client.calls if call[0] == "actionStatus"]) == 1
    assert len([call for call in client.calls if call[0] == "programStop"]) == 1


def test_run_non_timeout_transport_failure_recovers_completed_status(monkeypatch):
    client = _patch_client(
        monkeypatch,
        {
            "programRun": ElectronBrowserRuntimeError(
                "connection reset while reading response",
            ),
            "actionStatus": {
                "status": "completed",
                "result": {
                    "runId": "runtime-reconciled",
                    "status": "completed",
                    "value": {"submitted": True},
                    "effect": {
                        "occurred": True,
                        "uncertain": False,
                        "kinds": ["external-submit"],
                    },
                    "finalSnapshot": _snapshot(),
                },
            },
        },
    )

    data = json.loads(
        program_tool._browser_run(
            {"intent": "submit once", "code": "return {submitted:true};"},
            task_id="session-1",
            tool_call_id="call-transport-completed",
        )
    )

    assert data["status"] == "completed"
    assert data["value"] == {"submitted": True}
    assert data["run_id"] == "runtime-reconciled"
    assert [action for action, _call in client.calls] == [
        "programRun",
        "actionStatus",
    ]


def test_run_transport_completed_without_a_program_result_stays_uncertain(
    monkeypatch,
):
    client = _patch_client(
        monkeypatch,
        {
            "programRun": ElectronBrowserRuntimeError("connection reset"),
            "actionStatus": {
                "status": "completed",
                "result": {"value": {"submitted": True}},
            },
        },
    )

    data = json.loads(
        program_tool._browser_run(
            {"intent": "submit once", "code": "return true;"},
            task_id="session-1",
            tool_call_id="call-transport-malformed-completed",
        )
    )

    assert data["status"] == "unknown_after_effect"
    assert data["do_not_retry"] is True
    assert data["errorCode"] == "BROWSER_PROGRAM_TRANSPORT_UNKNOWN"


def test_run_non_timeout_transport_uncertainty_blocks_replay(monkeypatch):
    args = {"intent": "submit once", "code": "return {submitted:true};"}
    client = _patch_client(
        monkeypatch,
        {
            "programRun": ElectronBrowserRuntimeError(
                "connection closed before a response arrived",
            ),
            "actionStatus": {"status": "unknown"},
        },
    )

    raw = program_tool._browser_run(
        args,
        task_id="session-1",
        tool_call_id="call-transport-unknown",
    )
    data = json.loads(raw)

    assert data["status"] == "unknown_after_effect"
    assert data["errorCode"] == "BROWSER_PROGRAM_TRANSPORT_UNKNOWN"
    assert data["do_not_retry"] is True
    assert data["recovery"] == {
        "required": True,
        "tool": "browser_snapshot",
        "reason": "establish-settled-page-state",
    }
    assert [action for action, _call in client.calls] == [
        "programRun",
        "actionStatus",
    ]

    guardrails = ToolCallGuardrailController()
    guardrails.after_call("browser_run", args, raw, failed=True)
    decision = guardrails.before_call("browser_run", dict(args))
    assert decision.action == "skip"
    assert decision.code == "browser_program_effect_replay_blocked"


def test_run_non_timeout_transport_failure_stops_a_running_program(monkeypatch):
    client = _patch_client(
        monkeypatch,
        {
            "programRun": ElectronBrowserRuntimeError(
                "connection closed before a response arrived",
            ),
            "actionStatus": {"status": "running"},
            "programStop": {"stopped": True},
        },
    )

    data = json.loads(
        program_tool._browser_run(
            {"intent": "submit once", "code": "return true;"},
            task_id="session-1",
            tool_call_id="call-transport-running",
        )
    )

    assert data["status"] == "unknown_after_effect"
    stop_call = next(
        call for action, call in client.calls if action == "programStop"
    )
    assert stop_call["params"] == {
        "reason": "Browser program transport failed",
        "code": "BROWSER_PROGRAM_TRANSPORT_FAILED",
    }


def test_run_transport_status_proves_pre_dispatch_failure(monkeypatch):
    client = _patch_client(
        monkeypatch,
        {
            "programRun": ElectronBrowserRuntimeError("connection reset"),
            "actionStatus": {
                "status": "failed",
                "error": {
                    "error": "Worker could not be started",
                    "errorCode": "BROWSER_PROGRAM_WORKER_START_FAILED",
                    "errorDetails": {
                        "beforeDispatch": True,
                        "dispatchAttempted": False,
                    },
                },
            },
        },
    )

    data = json.loads(
        program_tool._browser_run(
            {"intent": "read only", "code": "return true;"},
            task_id="session-1",
            tool_call_id="call-transport-before-dispatch",
        )
    )

    assert data["status"] == "failed_before_effect"
    assert data["run_effect"] == {
        "occurred": False,
        "uncertain": False,
        "kinds": [],
    }
    assert data["error"]["code"] == "BROWSER_PROGRAM_WORKER_START_FAILED"
    assert "do_not_retry" not in data


def test_run_structured_runtime_rejection_does_not_query_action_status(
    monkeypatch,
):
    client = _patch_client(
        monkeypatch,
        {
            "programRun": ElectronBrowserRuntimeError(
                "A browser program is already running",
                code="BROWSER_PROGRAM_ALREADY_RUNNING",
                details={"retryable": True},
            ),
        },
    )

    data = json.loads(
        program_tool._browser_run(
            {"intent": "read only", "code": "return true;"},
            task_id="session-1",
            tool_call_id="call-structured-rejection",
        )
    )

    assert data["code"] == "BROWSER_PROGRAM_ALREADY_RUNNING"
    assert [action for action, _call in client.calls] == ["programRun"]


def test_handoff_uses_host_hard_stop_and_blocking_control_contract(monkeypatch):
    initial = {
        **_snapshot(),
        "url": "https://example.test/login",
        "captchaState": {"detected": False},
    }
    resumed = {
        **_snapshot(),
        "url": "https://example.test/account",
        "captchaState": {"detected": False},
    }
    client = _patch_client(
        monkeypatch,
        {
            "programHandoff": {"stopped": True},
            "programSnapshot": [initial, resumed],
        },
    )
    control_meta = []
    monkeypatch.setattr(
        program_tool,
        "_browser_callbacks",
        lambda: (None, lambda meta: control_meta.append(meta) or "continue"),
    )
    raw = program_tool._browser_handoff(
        {
            "reason": "login required",
            "instructions": "Please sign in, then return to Fan.",
        },
        task_id="session-1",
        tool_call_id="call-handoff",
    )

    data = json.loads(raw)
    assert data["status"] == "needs_replan"
    assert data["replan_required"] is True
    assert data["reason"] == "login required"
    assert data["url"] == "https://example.test/account"
    assert "<page_observation>" in data["final_snapshot"]
    assert data["boundary"]["kind"] == "control"
    assert control_meta == [
        {
            "kind": "control",
            "url": "https://example.test/login",
            "message": "Please sign in, then return to Fan.",
        }
    ]
    action, call = client.calls[0]
    assert action == "programHandoff"
    assert call["params"] == {
        "reason": "login required",
        "instructions": "Please sign in, then return to Fan.",
    }
    assert [action for action, _call in client.calls] == [
        "programHandoff",
        "programSnapshot",
        "programSnapshot",
    ]


def test_completed_program_with_behavioral_captcha_enters_verification(
    monkeypatch,
):
    client = _patch_client(
        monkeypatch,
        {
            "programRun": {
                "runId": "runtime-captcha",
                "status": "completed",
                "value": {"submitted": True},
                "captchaState": {
                    "detected": True,
                    "kind": "behavioral",
                    "requiresUserInput": True,
                    "challengeId": "slider-completed",
                },
                "documentRevision": 9,
                "url": "https://example.test/challenge",
                "effect": {
                    "occurred": True,
                    "uncertain": False,
                    "kinds": ["external-submit"],
                },
            },
            "programHandoff": {"status": "needs_human", "stopped": False},
            "programSnapshot": {
                **_snapshot(),
                "url": "https://example.test/result",
                "captchaState": {"detected": False},
            },
        },
    )
    seen = []
    monkeypatch.setattr(
        program_tool,
        "_browser_callbacks",
        lambda: (lambda meta: seen.append(meta) or "auto", None),
    )

    data = json.loads(
        program_tool._browser_run(
            {
                "intent": "submit form",
                "code": "await fan.click(fan.ref(9));",
            },
            task_id="session-1",
            tool_call_id="call-completed-captcha",
        )
    )

    assert data["status"] == "needs_replan"
    assert data["run_effect"]["kinds"] == ["external-submit"]
    assert "value" not in data
    assert seen[0]["challenge_id"] == "slider-completed"
    assert seen[0]["document_revision"] == 9
    assert [action for action, _call in client.calls] == [
        "programRun",
        "programHandoff",
        "programSnapshot",
    ]


def test_verification_continue_while_challenge_remains_blocks_again(
    monkeypatch,
):
    still_blocked = {
        **_snapshot(),
        "url": "https://example.test/challenge",
        "captchaState": {
            "detected": True,
            "kind": "behavioral",
            "requiresUserInput": True,
            "challengeId": "slider-still-present",
            "documentRevision": 11,
        },
    }
    cleared = {
        **_snapshot(),
        "url": "https://example.test/result",
        "captchaState": {"detected": False},
    }
    client = _patch_client(
        monkeypatch,
        {
            "programRun": {
                "runId": "runtime-still-blocked",
                "status": "needs_human",
                "captchaState": dict(still_blocked["captchaState"]),
                "url": still_blocked["url"],
                "effect": {
                    "occurred": True,
                    "uncertain": False,
                    "kinds": ["external-submit"],
                },
            },
            "programHandoff": {"status": "needs_human", "stopped": True},
            "programSnapshot": [still_blocked, cleared],
        },
    )
    prompts = []

    def verification(meta):
        prompts.append(meta)
        return "continue"

    monkeypatch.setattr(
        program_tool,
        "_browser_callbacks",
        lambda: (verification, None),
    )

    data = json.loads(
        program_tool._browser_run(
            {
                "intent": "submit",
                "code": "await fan.click(fan.ref(9));",
            },
            task_id="session-1",
            tool_call_id="call-still-blocked",
        )
    )

    assert data["status"] == "needs_replan"
    assert len(prompts) == 2
    assert prompts[0]["challenge_id"] == "slider-still-present"
    assert prompts[1]["challenge_id"] == "slider-still-present"
    assert "仍未完成" in prompts[1]["message"]
    assert [action for action, _call in client.calls] == [
        "programRun",
        "programHandoff",
        "programSnapshot",
        "programSnapshot",
    ]


def test_verification_stop_fails_closed_without_followup_snapshot(monkeypatch):
    client = _patch_client(
        monkeypatch,
        {
            "programRun": {
                "runId": "runtime-stop",
                "status": "needs_human",
                "captchaState": {
                    "detected": True,
                    "kind": "behavioral",
                    "requiresUserInput": True,
                    "challengeId": "slider-stop",
                },
                "url": "https://example.test/challenge",
                "effect": {
                    "occurred": True,
                    "uncertain": False,
                    "kinds": ["external-submit"],
                },
            },
            "programHandoff": {"status": "needs_human", "stopped": True},
        },
    )
    monkeypatch.setattr(
        program_tool,
        "_browser_callbacks",
        lambda: (lambda _meta: "stop", None),
    )

    raw = program_tool._browser_run(
        {
            "intent": "submit",
            "code": "await fan.click(fan.ref(9));",
        },
        task_id="session-1",
        tool_call_id="call-stop",
    )
    data = json.loads(raw)

    assert data["status"] == "failed_after_effect"
    assert data["error"]["code"] == "HUMAN_CONTROL_STOPPED"
    assert data["do_not_retry"] is True
    assert data["run_effect"]["occurred"] is True
    assert [action for action, _call in client.calls] == [
        "programRun",
        "programHandoff",
    ]


def test_failed_program_handoff_preserves_effect_and_blocks_replay(monkeypatch):
    args = {
        "intent": "submit",
        "code": "await fan.click(fan.ref(9));",
    }
    client = _patch_client(
        monkeypatch,
        {
            "programRun": {
                "runId": "runtime-handoff-failed",
                "status": "needs_human",
                "captchaState": {
                    "detected": True,
                    "kind": "behavioral",
                    "requiresUserInput": True,
                    "challengeId": "slider-handoff-failed",
                },
                "effect": {
                    "occurred": True,
                    "uncertain": False,
                    "kinds": ["external-submit"],
                },
            },
            "programHandoff": ElectronBrowserRuntimeError(
                "transport unavailable",
                code="RUNTIME_UNAVAILABLE",
            ),
        },
    )

    raw = program_tool._browser_run(
        args,
        task_id="session-1",
        tool_call_id="call-handoff-failed",
    )
    data = json.loads(raw)

    assert data["status"] == "failed_after_effect"
    assert data["error"]["code"] == "RUNTIME_UNAVAILABLE"
    assert data["do_not_retry"] is True
    assert data["run_effect"] == {
        "occurred": True,
        "uncertain": False,
        "kinds": ["external-submit"],
    }
    assert "transport unavailable" not in raw
    assert [action for action, _call in client.calls] == [
        "programRun",
        "programHandoff",
    ]

    guardrails = ToolCallGuardrailController()
    guardrails.after_call("browser_run", args, raw, failed=True)
    decision = guardrails.before_call("browser_run", dict(args))
    assert decision.action == "skip"
    assert decision.code == "browser_program_effect_replay_blocked"


def test_missing_verification_callback_fails_closed(monkeypatch):
    client = _patch_client(
        monkeypatch,
        {
            "programRun": {
                "runId": "runtime-no-callback",
                "status": "needs_human",
                "captchaState": {
                    "detected": True,
                    "kind": "behavioral",
                    "requiresUserInput": True,
                    "challengeId": "slider-no-callback",
                },
                "url": "https://example.test/challenge",
            },
            "programHandoff": {"status": "needs_human", "stopped": True},
        },
    )
    monkeypatch.setattr(
        program_tool,
        "_browser_callbacks",
        lambda: (None, None),
    )

    data = json.loads(
        program_tool._browser_run(
            {
                "intent": "submit",
                "code": "await fan.click(fan.ref(9));",
            },
            task_id="session-1",
            tool_call_id="call-no-callback",
        )
    )

    assert data["status"] == "failed_before_effect"
    assert data["error"]["code"] == "BROWSER_HUMAN_CALLBACK_UNAVAILABLE"
    assert data["retryable"] is False
    assert "needs_human" not in json.dumps(data)
    assert [action for action, _call in client.calls] == [
        "programRun",
        "programHandoff",
    ]


def test_missing_control_callback_preserves_uncertain_effect_status(monkeypatch):
    client = _patch_client(
        monkeypatch,
        {
            "programRun": {
                "runId": "runtime-uncertain-intervention",
                "status": "needs_human",
                "interventionPending": True,
                "effect": {
                    "occurred": False,
                    "uncertain": True,
                    "kinds": [],
                },
                "error": {
                    "code": "BROWSER_PROGRAM_USER_INTERVENED",
                    "message": "The user took control of the browser",
                },
            },
            "programHandoff": {"status": "needs_human", "stopped": True},
            "programSnapshot": {
                **_snapshot(),
                "captchaState": {"detected": False},
            },
        },
    )
    monkeypatch.setattr(
        program_tool,
        "_browser_callbacks",
        lambda: (None, None),
    )

    data = json.loads(
        program_tool._browser_run(
            {
                "intent": "continue browsing",
                "code": "await fan.click(fan.ref(4));",
            },
            task_id="session-1",
            tool_call_id="call-uncertain-intervention",
        )
    )

    assert data["status"] == "unknown_after_effect"
    assert data["run_effect"] == {
        "occurred": False,
        "uncertain": True,
        "kinds": [],
    }
    assert data["retryable"] is False
    assert data["do_not_retry"] is True


def test_user_intervened_program_uses_control_callback(monkeypatch):
    client = _patch_client(
        monkeypatch,
        {
            "programRun": {
                "runId": "runtime-user-intervened",
                "status": "needs_human",
                "interventionPending": True,
                "url": "https://example.test/manual",
                "effect": {
                    "occurred": False,
                    "uncertain": True,
                    "kinds": [],
                },
                "error": {
                    "code": "BROWSER_PROGRAM_USER_INTERVENED",
                    "message": "The user took control of the browser",
                },
            },
            "programHandoff": {"status": "needs_human", "stopped": True},
            "programSnapshot": {
                **_snapshot(),
                "url": "https://example.test/manual-complete",
                "captchaState": {"detected": False},
                "interventionPending": False,
            },
        },
    )
    verification = []
    control = []
    monkeypatch.setattr(
        program_tool,
        "_browser_callbacks",
        lambda: (
            lambda meta: verification.append(meta) or "continue",
            lambda meta: control.append(meta) or "continue",
        ),
    )

    data = json.loads(
        program_tool._browser_run(
            {
                "intent": "continue browsing",
                "code": "await fan.click(fan.ref(4));",
            },
            task_id="session-1",
            tool_call_id="call-user-intervened",
        )
    )

    assert data["status"] == "needs_replan"
    assert data["boundary"]["kind"] == "control"
    assert verification == []
    assert control == [
        {
            "kind": "control",
            "url": "https://example.test/manual",
            "message": (
                "这一步需要你操作浏览器；完成后点击继续，Agent 会从当前页面接着执行"
            ),
        }
    ]
    assert [action for action, _call in client.calls] == [
        "programRun",
        "programHandoff",
        "programSnapshot",
        "programSnapshot",
    ]


def test_explicit_handoff_without_control_callback_fails_before_effect(
    monkeypatch,
):
    client = _patch_client(
        monkeypatch,
        {
            "programHandoff": {"status": "needs_human", "stopped": True},
            "programSnapshot": {
                **_snapshot(),
                "url": "https://example.test/login",
                "captchaState": {"detected": False},
            },
        },
    )
    monkeypatch.setattr(
        program_tool,
        "_browser_callbacks",
        lambda: (None, None),
    )

    data = json.loads(
        program_tool._browser_handoff(
            {"reason": "login required"},
            task_id="session-1",
            tool_call_id="call-handoff-no-control",
        )
    )

    assert data["status"] == "failed_before_effect"
    assert data["error"]["code"] == "BROWSER_HUMAN_CALLBACK_UNAVAILABLE"
    assert data["do_not_retry"] is True
    assert [action for action, _call in client.calls] == [
        "programHandoff",
        "programSnapshot",
    ]


def test_explicit_handoff_uses_verification_for_current_behavioral_captcha(
    monkeypatch,
):
    current = {
        **_snapshot(),
        "url": "https://example.test/challenge",
        "captchaState": {
            "detected": True,
            "kind": "behavioral",
            "requiresUserInput": True,
            "challengeId": "slider-handoff",
        },
    }
    cleared = {
        **_snapshot(),
        "url": "https://example.test/result",
        "captchaState": {"detected": False},
    }
    client = _patch_client(
        monkeypatch,
        {
            "programHandoff": {"status": "needs_human", "stopped": True},
            "programSnapshot": [current, cleared],
        },
    )
    verification = []
    control = []
    monkeypatch.setattr(
        program_tool,
        "_browser_callbacks",
        lambda: (
            lambda meta: verification.append(meta) or "continue",
            lambda meta: control.append(meta) or "continue",
        ),
    )

    data = json.loads(
        program_tool._browser_handoff(
            {
                "reason": "verification required",
                "instructions": "Complete the slider.",
            },
            task_id="session-1",
            tool_call_id="call-handoff-verification",
        )
    )

    assert data["status"] == "needs_replan"
    assert data["boundary"]["kind"] == "verification"
    assert verification[0]["challenge_id"] == "slider-handoff"
    assert control == []
    assert [action for action, _call in client.calls] == [
        "programHandoff",
        "programSnapshot",
        "programSnapshot",
    ]


def test_program_progress_preview_uses_intent_instead_of_source_code():
    assert _build_tool_preview_unguarded(
        "browser_run",
        {
            "intent": "搜索并整理前三条自然结果",
            "code": "while (true) { /* intentionally noisy source */ }",
        },
    ) == "搜索并整理前三条自然结果"
    assert _build_tool_preview_unguarded(
        "browser_handoff",
        {"reason": "需要用户完成验证码"},
    ) == "需要用户完成验证码"


def test_program_display_uses_top_level_status_not_nested_page_words():
    assert _detect_tool_failure(
        "browser_run",
        json.dumps(
            {"status": "completed", "value": {"failed": False}},
            separators=(",", ":"),
        ),
    ) == (False, "")
    assert _detect_tool_failure(
        "browser_snapshot",
        json.dumps(
            {"status": "completed", "snapshot": "Build failed is page text"},
            separators=(",", ":"),
        ),
    ) == (False, "")
    failed, suffix = _detect_tool_failure(
        "browser_run",
        json.dumps(
            {
                "status": "unknown_after_effect",
                "error": {"message": "submit outcome unknown"},
            },
            separators=(",", ":"),
        ),
    )
    assert failed is True
    assert "submit outcome unknown" in suffix


def _prompt_agent(tool_names):
    return SimpleNamespace(
        load_soul_identity=False,
        skip_context_files=True,
        valid_tool_names=set(tool_names),
        _task_completion_guidance=False,
        _tool_use_enforcement=False,
        _kanban_worker_guidance="",
        _environment_probe=False,
        _memory_store=None,
        _memory_manager=None,
        model="",
        provider="",
        platform="",
        pass_session_id=False,
        session_id="",
        context_compressor=None,
    )


def test_system_prompt_selects_exact_browser_interface(monkeypatch):
    import run_agent

    monkeypatch.setattr(run_agent, "build_environment_hints", lambda: "")

    program = build_system_prompt_parts(
        _prompt_agent(
            {"browser_snapshot", "browser_run", "browser_handoff"}
        )
    )["stable"]
    legacy = build_system_prompt_parts(
        _prompt_agent({"browser_observe", "browser_click"})
    )["stable"]

    assert BROWSER_PROGRAM_TOOL_GUIDANCE in program
    assert ELECTRON_BROWSER_TOOL_GUIDANCE not in program
    assert ELECTRON_BROWSER_TOOL_GUIDANCE in legacy
    assert BROWSER_PROGRAM_TOOL_GUIDANCE not in legacy


def test_browser_program_guidance_checks_state_and_avoids_tail_observe():
    skill = (
        ROOT / "skills/browser/browser-programming/SKILL.md"
    ).read_text(encoding="utf-8")
    api_reference = (
        ROOT / "skills/browser/browser-programming/references/api.md"
    ).read_text(encoding="utf-8")

    assert "动作前置条件" in BROWSER_PROGRAM_TOOL_GUIDANCE
    assert "事务收尾不用观察" in BROWSER_PROGRAM_TOOL_GUIDANCE
    assert "Only call `fan.observe()` when a later action" in skill
    assert "Do not end a transaction with `fan.observe()`" in skill
    assert "Only call `fan.observe()` when a later action" in api_reference
    assert "Do not append a final `fan.observe()`" in api_reference


def test_browser_program_guidance_documents_form_and_native_select_contract():
    assert '{target: fan.ref(N), text: "..."}' in BROWSER_PROGRAM_TOOL_GUIDANCE
    assert "输入内容的键是 `text`" in BROWSER_PROGRAM_TOOL_GUIDANCE
    assert "不是快照中表示当前状态的 `value`" in BROWSER_PROGRAM_TOOL_GUIDANCE
    assert "原生 `<select>` 不可用 `fan.click`" in BROWSER_PROGRAM_TOOL_GUIDANCE
    assert 'fan.select(fan.ref(N), "Two")' in BROWSER_PROGRAM_TOOL_GUIDANCE
    assert "返回 `value` 和 `text`" in BROWSER_PROGRAM_TOOL_GUIDANCE


def test_browser_program_guidance_keeps_autocomplete_inside_one_safe_transaction():
    guidance = BROWSER_PROGRAM_TOOL_GUIDANCE

    assert "`autocomplete.detected=true`" in guidance
    assert "`autocomplete_kind=...`" in guidance
    assert "`autocomplete=off`" in guidance
    assert "单独的 popup 不是充分证据" in guidance
    assert "原生 `<select role=combobox>`" in guidance
    assert "`fan.formSubmit` 只用于" in guidance
    assert "`fan.type → fresh fan.observe →" in guidance
    assert "`fan.type` 会为候选更新留出短暂等待窗口" in guidance
    assert "它不会替你选择候选" in guidance
    assert "也不保证候选必然出现" in guidance
    assert "内部等待候选呈现" not in guidance
    assert (
        "`fan.type → fresh fan.observe → fan.requireUnique(实际候选) → "
        "fan.click(候选) → fan.observe → fan.click(新提交按钮)`"
    ) in guidance
    assert "ticker、name、CIK、代码或地址" in guidance
    assert "不得根据输入词猜一个完整候选文本" in guidance
    assert "只有候选的精确、稳定字段已经由页面契约或先验快照明确给出" in guidance
    assert "普通自由文本搜索的候选通常可选" in guidance
    assert "可以跳过候选" in guidance
    for candidate_role in ("`option`", "`menuitem`", "`link`", "`button`"):
        assert candidate_role in guidance
    assert "不得假定 `role=option`" in guidance
    assert "const sourceTab = fan.requireUnique" in guidance
    assert "(await fan.tabs()).filter(tab => tab.current)" in guidance
    assert "selectedPage.url !== sourceTab.url" in guidance
    assert "URL 已变化时必须结束" in guidance
    assert "const candidatesPage = await fan.observe()" in guidance
    assert "candidatesPage.elements.filter" in guidance
    assert 'actual.includes("msft")' in guidance
    assert 'actual.includes("0000789019")' in guidance
    assert 'fan.waitForElement({id: "company-MSFT"})' in guidance
    assert '{text: "San Francisco"}' not in guidance
    assert "selectedPage.elements.filter" in guidance
    assert "不能在选择后复用输入前看到的旧提交" in guidance


def test_browser_program_guidance_and_references_share_scroll_contract():
    skill = (
        ROOT / "skills/browser/browser-programming/SKILL.md"
    ).read_text(encoding="utf-8")
    api_reference = (
        ROOT / "skills/browser/browser-programming/references/api.md"
    ).read_text(encoding="utf-8")

    assert "fan.scroll({up: true, pages: 1})" in BROWSER_PROGRAM_TOOL_GUIDANCE
    assert "down: false" in BROWSER_PROGRAM_TOOL_GUIDANCE
    assert "conflicting `up` and `down`" in skill
    assert "fan.scroll(target?, {down?, up?, pages?, timeoutMs?})" in (
        api_reference
    )
    assert "conflicting `up` and `down`" in api_reference


def test_browser_program_guidance_documents_declarative_wait_contract():
    assert (
        "fan.waitForState(target, {attached?, enabled?}, "
        "{timeoutMs?, pollMs?, description?})"
        in BROWSER_PROGRAM_TOOL_GUIDANCE
    )
    assert "const input = await fan.waitForState" in (
        BROWSER_PROGRAM_TOOL_GUIDANCE
    )
    assert "不要用角色查询重新寻找这个已知编号" in (
        BROWSER_PROGRAM_TOOL_GUIDANCE
    )
    assert (
        "fan.waitForElement(query, {timeoutMs?, pollMs?, description?})"
        in BROWSER_PROGRAM_TOOL_GUIDANCE
    )
    assert "它不接受函数回调" in (
        BROWSER_PROGRAM_TOOL_GUIDANCE
    )
    assert "多匹配或超时安全返回 `needs_replan`" in (
        BROWSER_PROGRAM_TOOL_GUIDANCE
    )
    assert "标签变化由 `fan.click` 内部等待" in BROWSER_PROGRAM_TOOL_GUIDANCE
    assert "点击后直接 `await fan.tabs()`" in BROWSER_PROGRAM_TOOL_GUIDANCE
    assert "`openedTab`" in BROWSER_PROGRAM_TOOL_GUIDANCE
    assert "fan.waitFor(" not in BROWSER_PROGRAM_TOOL_GUIDANCE
    assert "fan.waitForSnapshot" not in BROWSER_PROGRAM_TOOL_GUIDANCE


def test_browser_program_skill_frontmatter_contract():
    content = (
        ROOT / "skills/browser/browser-programming/SKILL.md"
    ).read_text(encoding="utf-8")
    match = re.search(r"^description: (.*)$", content, re.MULTILINE)

    assert match is not None
    description = match.group(1)
    assert len(description) <= 60
    assert description.endswith(".")
    assert "requires_toolsets: [browser_program]" in content
    assert "browser_snapshot" in content
    assert "browser_run" in content
    assert "browser_handoff" in content
    assert "Page/Locator/Expect" not in content
