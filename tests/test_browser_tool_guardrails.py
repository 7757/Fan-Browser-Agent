from __future__ import annotations

import json

from agent.tool_guardrails import (
    ToolCallGuardrailController,
    ToolGuardrailDecision,
    _safe_browser_page_url,
    append_toolguard_guidance,
)


def _failure(code: str, retryable: bool) -> str:
    return json.dumps(
        {
            "error": "browser action failed",
            "error_code": code,
            "error_details": {"retryable": retryable},
        }
    )


def test_user_facing_page_url_drops_credentials_query_and_fragment():
    assert (
        _safe_browser_page_url(
            "https://user:password@example.com/track?token=secret#result"
        )
        == "https://example.com/track"
    )


def test_nonretryable_browser_error_opens_the_tool_path_circuit_immediately():
    guardrails = ToolCallGuardrailController()
    guardrails.after_call(
        "browser_find_visual",
        {"description": "submit"},
        _failure("VISION_PROVIDER_UNAVAILABLE", False),
        failed=True,
    )

    decision = guardrails.before_call("browser_find_visual", {"description": "close"})
    assert decision.allows_execution is False
    assert decision.should_halt is False
    assert decision.code == "browser_path_circuit_open"
    assert "VISION_PROVIDER_UNAVAILABLE" in decision.message


def test_retryable_browser_error_opens_the_circuit_after_the_second_same_path_failure():
    guardrails = ToolCallGuardrailController()
    error = _failure("VISUAL_EVIDENCE_REQUIRED", True)

    guardrails.after_call("browser_click", {"x": 400, "y": 400}, error, failed=True)
    assert guardrails.before_call("browser_click", {"index": 2}).allows_execution is True
    guardrails.after_call("browser_click", {"x": 450, "y": 450}, error, failed=True)

    decision = guardrails.before_call("browser_click", {"index": 2})
    assert decision.allows_execution is False
    assert decision.should_halt is False
    assert decision.code == "browser_path_circuit_open"


def test_repeating_an_already_blocked_browser_tool_halts_the_turn():
    guardrails = ToolCallGuardrailController()
    guardrails.after_call(
        "browser_find_visual",
        {"description": "submit"},
        _failure("VISION_PROVIDER_UNAVAILABLE", False),
        failed=True,
    )

    first = guardrails.before_call("browser_find_visual", {"description": "close"})
    second = guardrails.before_call("browser_find_visual", {"description": "close"})

    assert first.action == "skip"
    assert second.action == "halt"
    assert second.code == "browser_no_progress_blocked_path_repeated"


def test_fresh_observation_clears_page_errors_but_keeps_capability_errors_blocked():
    guardrails = ToolCallGuardrailController()
    retryable = _failure("CLICK_TARGET_MISMATCH", True)
    guardrails.after_call("browser_click", {"index": 1}, retryable, failed=True)
    guardrails.after_call("browser_click", {"index": 2}, retryable, failed=True)
    guardrails.after_call(
        "browser_find_visual",
        {"description": "submit"},
        _failure("VISION_PROVIDER_UNAVAILABLE", False),
        failed=True,
    )
    guardrails.after_call(
        "browser_select",
        {"index": 4, "value": "active"},
        _failure("ACTION_TIMEOUT_PENDING", False),
        failed=True,
    )

    guardrails.after_call("browser_observe", {}, json.dumps({"dom": "fresh"}), failed=False)

    assert guardrails.before_call("browser_click", {"index": 3}).allows_execution is True
    assert guardrails.before_call("browser_select", {"index": 4, "value": "active"}).allows_execution is True
    assert guardrails.before_call("browser_find_visual", {"description": "close"}).allows_execution is False


def test_multimodal_observation_result_can_be_hashed_without_crashing():
    guardrails = ToolCallGuardrailController()
    result = {
        "_multimodal": True,
        "text_summary": "fresh page",
        "screenshot": {"format": "png", "width": 1280, "height": 800},
        "content": [
            {"type": "text", "text": "fresh page"},
            {"type": "image_url", "image_url": {"url": "data:image/png;base64,AAAA"}},
        ],
    }

    decision = guardrails.after_call("browser_observe", {}, result, failed=False)

    assert decision.allows_execution is True


def _browser_state(
    *,
    tab: str = "t0",
    document: int = 1,
    page: int = 1,
    tabs: int = 1,
    view: int = 1,
    selectors: int = 1,
) -> dict:
    return {
        "sessionId": "session-1",
        "activeTabId": tab,
        "documentRevision": document,
        "pageGeneration": page,
        "tabListGeneration": tabs,
        "viewEpoch": view,
        "selectorGeneration": selectors,
    }


def _replan_result(url: str = "https://www.baidu.com/") -> str:
    return json.dumps(
        {
            "result": {
                "executed": False,
                "replan_required": True,
                "code": "BROWSER_STATE_CHANGED",
            },
            "dom": f"[page: 百度一下 · {url}]\nOpen tabs:\n- #t0 当前",
        },
        ensure_ascii=False,
    )


def test_browser_same_stalled_path_warns_then_halts_before_third_execution():
    guardrails = ToolCallGuardrailController()
    state = _browser_state()
    args = {"tab_id": "t0"}

    first = guardrails.after_call(
        "browser_switch_tab",
        args,
        _replan_result(),
        failed=False,
        browser_state_before=state,
        browser_state_after=state,
    )
    second = guardrails.after_call(
        "browser_switch_tab",
        args,
        _replan_result(),
        failed=False,
        browser_state_before=state,
        browser_state_after=state,
    )
    third = guardrails.before_call(
        "browser_switch_tab",
        args,
        browser_state=state,
    )

    assert first.action == "allow"
    assert second.action == "warn"
    assert second.code == "browser_no_progress_warning"
    assert third.action == "halt"
    assert third.code == "browser_no_progress_circuit_open"
    assert third.user_context["attempted_action"] == "切换标签页"
    assert third.user_context["status"] == "no_progress"


def test_browser_alternating_recovery_calls_halt_after_three_no_progress_steps():
    guardrails = ToolCallGuardrailController()
    state = _browser_state()

    guardrails.after_call(
        "browser_switch_tab",
        {"tab_id": "t0"},
        _replan_result(),
        failed=False,
        browser_state_before=state,
        browser_state_after=state,
    )
    guardrails.after_call(
        "browser_observe",
        {},
        json.dumps(
            {
                "dom": (
                    "[page: 百度一下 · https://www.baidu.com/]\n"
                    "Open tabs:\n- #t0 当前"
                )
            },
            ensure_ascii=False,
        ),
        failed=False,
        browser_state_before=state,
        browser_state_after=state,
    )
    decision = guardrails.after_call(
        "browser_switch_tab",
        {"tab_id": "t1"},
        _replan_result(),
        failed=False,
        browser_state_before=state,
        browser_state_after=state,
    )

    assert decision.action == "halt"
    assert decision.code == "browser_no_progress_halt"
    assert decision.count == 3
    assert decision.user_context["attempted_action"] == "切换标签页"
    assert decision.user_context["page_url"] == "https://www.baidu.com/"


def test_real_browser_state_change_resets_stagnation():
    guardrails = ToolCallGuardrailController()
    old_state = _browser_state()
    new_state = _browser_state(document=2, page=2)

    guardrails.after_call(
        "browser_switch_tab",
        {"tab_id": "t0"},
        _replan_result(),
        failed=False,
        browser_state_before=old_state,
        browser_state_after=old_state,
    )
    progressed = guardrails.after_call(
        "browser_navigate",
        {"url": "https://example.com"},
        json.dumps(
            {
                "effect": "navigation",
                "dom": "[page: Example · https://example.com/]",
            }
        ),
        failed=False,
        browser_state_before=old_state,
        browser_state_after=new_state,
    )
    next_stall = guardrails.after_call(
        "browser_switch_tab",
        {"tab_id": "t0"},
        _replan_result("https://example.com/"),
        failed=False,
        browser_state_before=new_state,
        browser_state_after=new_state,
    )

    assert progressed.action == "allow"
    assert next_stall.action == "allow"
    assert next_stall.count == 1


def test_dom_change_counts_as_progress_without_a_document_revision_change():
    guardrails = ToolCallGuardrailController()
    state = _browser_state()

    guardrails.after_call(
        "browser_click",
        {"index": 1},
        json.dumps({"effect": "snapshot-refresh", "dom": "[page: App · https://app.test/]\nClosed"}),
        failed=False,
        browser_state_before=state,
        browser_state_after=state,
    )
    progressed = guardrails.after_call(
        "browser_click",
        {"index": 2},
        json.dumps({"effect": "snapshot-refresh", "dom": "[page: App · https://app.test/]\nDialog open"}),
        failed=False,
        browser_state_before=state,
        browser_state_after=state,
    )
    next_stall = guardrails.after_call(
        "browser_switch_tab",
        {"tab_id": "t0"},
        _replan_result("https://app.test/"),
        failed=False,
        browser_state_before=state,
        browser_state_after=state,
    )

    assert progressed.action == "allow"
    assert next_stall.count == 1


def test_view_and_selector_generation_do_not_count_as_business_progress():
    guardrails = ToolCallGuardrailController()
    before = _browser_state(view=1, selectors=1)
    after = _browser_state(view=9, selectors=12)

    first = guardrails.after_call(
        "browser_click",
        {"index": 3},
        _replan_result(),
        failed=False,
        browser_state_before=before,
        browser_state_after=after,
    )
    second = guardrails.after_call(
        "browser_click",
        {"index": 3},
        _replan_result(),
        failed=False,
        browser_state_before=after,
        browser_state_after=after,
    )

    assert first.count == 1
    assert second.action == "warn"


def test_deferred_same_snapshot_steps_do_not_spend_no_progress_budget():
    guardrails = ToolCallGuardrailController()
    state = _browser_state()

    for index in (10, 11, 12):
        decision = guardrails.after_call(
            "browser_click",
            {"index": index},
            json.dumps(
                {
                    "effect": "dom-structure",
                    "same_snapshot_continue": True,
                    "result": {"clicked": index},
                }
            ),
            failed=False,
            browser_state_before=state,
            browser_state_after=state,
        )
        assert decision.action == "allow"
        assert decision.count == 0


def test_successful_select_readback_resets_stagnation_but_repeat_does_not():
    guardrails = ToolCallGuardrailController()
    state = _browser_state()
    guardrails.after_call(
        "browser_click",
        {"index": 1},
        json.dumps({"effect": "none", "result": {"clicked": 1}}),
        failed=False,
        browser_state_before=state,
        browser_state_after=state,
    )
    select_result = json.dumps(
        {
            "effect": "dom-structure",
            "result": {"selected": 4, "value": "112", "text": "CHINA P. R."},
        }
    )

    progressed = guardrails.after_call(
        "browser_select",
        {"index": 4, "text": "CHINA P. R."},
        select_result,
        failed=False,
        browser_state_before=state,
        browser_state_after=state,
    )
    repeated = guardrails.after_call(
        "browser_select",
        {"index": 4, "text": "CHINA P. R."},
        select_result,
        failed=False,
        browser_state_before=state,
        browser_state_after=state,
    )

    assert progressed.action == "allow"
    assert progressed.count == 0
    assert repeated.count == 1


def test_guardrail_guidance_preserves_multimodal_result_shape():
    result = {"_multimodal": True, "content": [{"type": "text", "text": "page"}]}
    decision = ToolGuardrailDecision(
        action="warn",
        code="browser_no_progress_warning",
        message="change strategy",
        tool_name="browser_observe",
        count=2,
    )

    annotated = append_toolguard_guidance(result, decision)

    assert annotated["_multimodal"] is True
    assert annotated["tool_loop_guardrail"]["code"] == "browser_no_progress_warning"
    assert "Tool loop warning" in annotated["content"][0]["text"]


def _program_result(
    body: str,
    *,
    methods: tuple[str, ...],
    status: str = "completed",
    error: dict | None = None,
    run_effect: dict | None = None,
) -> str:
    payload = {
        "status": status,
        "trace": [
            {"step": index, "method": method, "status": "completed"}
            for index, method in enumerate(methods, start=1)
        ],
        "effect": "snapshot-refresh",
        "final_snapshot": (
            "<page_observation>\n"
            "[page: Program · https://app.test/]\n"
            f"{body}\n"
            "</page_observation>"
        ),
    }
    if error is not None:
        payload["error"] = error
        if payload["trace"]:
            payload["trace"][-1]["status"] = "failed"
            payload["trace"][-1]["error"] = error
    if run_effect is not None:
        payload["run_effect"] = run_effect
    return json.dumps(payload, ensure_ascii=False)


def test_program_failed_before_effect_allows_changed_input_recovery():
    guardrails = ToolCallGuardrailController()
    state = _browser_state()

    first_args = {
        "intent": "upload temporary file",
        "code": "await fan.upload(fan.ref(19), ['/tmp/fan-upload-e2e.txt'])",
    }
    second_args = {
        "intent": "upload copied file",
        "code": "await fan.upload(fan.ref(19), ['~/Downloads/fan-upload-e2e.txt'])",
    }
    recovered_args = {
        "intent": "upload copied file by absolute path",
        "code": (
            "await fan.upload(fan.ref(19), "
            "['/Users/test/Downloads/fan-upload-e2e.txt'])"
        ),
    }

    for args, message in (
        (first_args, "upload path is outside the allowed directories"),
        (second_args, "upload file does not exist"),
    ):
        guardrails.after_call(
            "browser_run",
            args,
            _program_result(
                "No file selected",
                methods=("upload",),
                status="failed_before_effect",
                error={"code": "BROWSER_PROGRAM_FAILED", "message": message},
            ),
            failed=True,
            browser_state_before=state,
            browser_state_after=state,
        )

    decision = guardrails.before_call(
        "browser_run",
        recovered_args,
        browser_state=state,
    )

    assert decision.allows_execution is True
    assert decision.action == "allow"


def test_program_same_failed_before_effect_path_still_opens_exact_path_circuit():
    guardrails = ToolCallGuardrailController()
    state = _browser_state()
    args = {
        "intent": "upload temporary file",
        "code": "await fan.upload(fan.ref(19), ['/tmp/fan-upload-e2e.txt'])",
    }
    result = _program_result(
        "No file selected",
        methods=("upload",),
        status="failed_before_effect",
        error={
            "code": "BROWSER_PROGRAM_FAILED",
            "message": "upload path is outside the allowed directories",
        },
    )

    guardrails.after_call(
        "browser_run",
        args,
        result,
        failed=True,
        browser_state_before=state,
        browser_state_after=state,
    )
    guardrails.after_call(
        "browser_run",
        args,
        result,
        failed=True,
        browser_state_before=state,
        browser_state_after=state,
    )

    decision = guardrails.before_call(
        "browser_run",
        args,
        browser_state=state,
    )

    assert decision.allows_execution is False
    assert decision.should_halt is True
    assert decision.code == "browser_no_progress_circuit_open"


def test_program_nonretryable_failure_still_opens_tool_circuit():
    guardrails = ToolCallGuardrailController()
    state = _browser_state()
    guardrails.after_call(
        "browser_run",
        {"intent": "navigate", "code": "await fan.navigate('https://app.test')"},
        _program_result(
            "Runtime unavailable",
            methods=("navigate",),
            status="failed_before_effect",
            error={
                "code": "BROWSER_RUNTIME_UNAVAILABLE",
                "message": "browser runtime is unavailable",
                "retryable": False,
            },
        ),
        failed=True,
        browser_state_before=state,
        browser_state_after=state,
    )

    decision = guardrails.before_call(
        "browser_run",
        {"intent": "observe", "code": "return await fan.observe()"},
        browser_state=state,
    )

    assert decision.allows_execution is False
    assert decision.should_halt is False
    assert decision.code == "browser_path_circuit_open"
    assert "BROWSER_RUNTIME_UNAVAILABLE" in decision.message


def test_program_final_snapshot_dom_change_resets_browser_stagnation():
    guardrails = ToolCallGuardrailController()
    state = _browser_state()

    stalled = guardrails.after_call(
        "browser_run",
        {"intent": "click", "code": "await fan.click(fan.ref(1))"},
        _program_result("Unchecked", methods=("click",)),
        failed=False,
        browser_state_before=state,
        browser_state_after=state,
    )
    progressed = guardrails.after_call(
        "browser_run",
        {"intent": "click", "code": "await fan.click(fan.ref(2))"},
        _program_result("Checked", methods=("click",)),
        failed=False,
        browser_state_before=state,
        browser_state_after=state,
    )
    next_stall = guardrails.after_call(
        "browser_run",
        {"intent": "click", "code": "await fan.click(fan.ref(3))"},
        _program_result("Checked", methods=("click",)),
        failed=False,
        browser_state_before=state,
        browser_state_after=state,
    )

    assert stalled.count == 1
    assert progressed.action == "allow"
    assert progressed.count == 0
    assert next_stall.count == 1


def test_program_recovery_calls_halt_after_three_unchanged_steps():
    guardrails = ToolCallGuardrailController()
    state = _browser_state()
    unchanged = "iframe [16], checkbox still below viewport"

    first = guardrails.after_call(
        "browser_run",
        {
            "intent": "scroll frame",
            "code": "await fan.scroll({target: fan.ref(16), down: true})",
        },
        _program_result(
            unchanged,
            methods=("scroll",),
            status="failed_before_effect",
            error={
                "code": "BROWSER_PROGRAM_OPTION_NOT_ALLOWED",
                "message": "scroll option target is not allowed",
            },
        ),
        failed=True,
        browser_state_before=state,
        browser_state_after=state,
    )
    second = guardrails.after_call(
        "browser_run",
        {"intent": "inspect frame", "code": "return await fan.observe()"},
        _program_result(unchanged, methods=("observe",)),
        failed=False,
        browser_state_before=state,
        browser_state_after=state,
    )
    third = guardrails.after_call(
        "browser_run",
        {
            "intent": "find frame text",
            "code": "await fan.scrollToText('Fourth row')",
        },
        _program_result(
            unchanged,
            methods=("scrollToText",),
            status="failed_before_effect",
            error={
                "code": "BROWSER_PROGRAM_FAILED",
                "message": "text not found",
            },
        ),
        failed=True,
        browser_state_before=state,
        browser_state_after=state,
    )

    assert first.count == 1
    assert second.action == "warn"
    assert second.code == "browser_no_progress_warning"
    assert third.action == "halt"
    assert third.code == "browser_no_progress_halt"
    assert third.count == 3


def _snapshot_result(body: str) -> str:
    return json.dumps(
        {
            "status": "completed",
            "snapshot": (
                "<page_observation>\n"
                "[page: Program · https://app.test/]\n"
                f"{body}\n"
                "</page_observation>"
            ),
        },
        ensure_ascii=False,
    )


def _seed_browser_snapshot(
    guardrails: ToolCallGuardrailController,
    state: dict,
    body: str,
) -> None:
    guardrails.after_call(
        "browser_snapshot",
        {},
        _snapshot_result(body),
        failed=False,
        browser_state_before=state,
        browser_state_after=state,
    )


def test_unknown_program_requires_snapshot_before_corrected_program():
    guardrails = ToolCallGuardrailController()
    state = _browser_state()
    _seed_browser_snapshot(guardrails, state, "Search form")
    original = {
        "intent": "submit search",
        "code": "await fan.click(fan.ref(9))",
    }
    guardrails.after_call(
        "browser_run",
        original,
        _program_result(
            "Search results loaded",
            methods=("click",),
            status="unknown_after_effect",
            error={
                "code": "ACTION_TIMEOUT_PENDING",
                "retryable": False,
                "message": "click timed out while the page was settling",
            },
            run_effect={
                "occurred": True,
                "uncertain": True,
                "kinds": ["navigation"],
            },
        ),
        failed=True,
        browser_state_before=state,
        browser_state_after=state,
    )

    before_recovery = guardrails.before_call(
        "browser_run",
        {
            "intent": "inspect the loaded results",
            "code": "return (await fan.observe()).text",
        },
        browser_state=state,
    )
    recovery = guardrails.after_call(
        "browser_snapshot",
        {},
        _snapshot_result("Search results loaded"),
        failed=False,
        browser_state_before=state,
        browser_state_after=state,
    )
    replay = guardrails.before_call(
        "browser_run",
        {**original, "intent": "retry the click"},
        browser_state=state,
    )
    corrected = guardrails.before_call(
        "browser_run",
        {
            "intent": "inspect the loaded results",
            "code": "return (await fan.observe()).text",
        },
        browser_state=state,
    )

    assert replay.code == "browser_program_effect_replay_blocked"
    assert before_recovery.code == "browser_path_circuit_open"
    assert recovery.action == "allow"
    assert recovery.count == 0
    assert corrected.allows_execution is True


def test_unknown_program_without_changed_snapshot_requests_passive_recovery():
    guardrails = ToolCallGuardrailController()
    state = _browser_state()
    _seed_browser_snapshot(guardrails, state, "Search form")
    guardrails.after_call(
        "browser_run",
        {
            "intent": "submit search",
            "code": "await fan.click(fan.ref(9))",
        },
        _program_result(
            "Search form",
            methods=("click",),
            status="unknown_after_effect",
            error={
                "code": "ACTION_TIMEOUT_PENDING",
                "retryable": False,
                "message": "click timed out while the page was settling",
            },
        ),
        failed=True,
        browser_state_before=state,
        browser_state_after=state,
    )

    decision = guardrails.before_call(
        "browser_run",
        {
            "intent": "use a different program",
            "code": "return await fan.observe()",
        },
        browser_state=state,
    )

    assert decision.code == "browser_path_circuit_open"
    assert "browser_snapshot" in decision.message

    recovery = guardrails.after_call(
        "browser_snapshot",
        {},
        _snapshot_result("Search form"),
        failed=False,
        browser_state_before=state,
        browser_state_after=state,
    )
    recovered = guardrails.before_call(
        "browser_run",
        {
            "intent": "inspect before choosing another action",
            "code": "return await fan.observe()",
        },
        browser_state=state,
    )

    assert recovery.action == "allow"
    assert recovery.count == 0
    assert recovered.allows_execution is True


def test_unknown_program_is_not_recovered_by_failed_snapshot_or_other_browser_read():
    guardrails = ToolCallGuardrailController()
    state = _browser_state()
    original = {
        "intent": "submit search",
        "code": "await fan.click(fan.ref(9))",
    }
    guardrails.after_call(
        "browser_run",
        original,
        _program_result(
            "Search results may have loaded",
            methods=("click",),
            status="unknown_after_effect",
            error={
                "code": "ACTION_TIMEOUT_PENDING",
                "retryable": False,
            },
        ),
        failed=True,
        browser_state_before=state,
        browser_state_after=state,
    )

    guardrails.after_call(
        "browser_observe",
        {},
        json.dumps({"status": "completed", "dom": "Search results"}),
        failed=False,
        browser_state_before=state,
        browser_state_after=state,
    )
    after_other_read = guardrails.before_call(
        "browser_run",
        {
            "intent": "inspect settled results",
            "code": "return await fan.observe()",
        },
        browser_state=state,
    )
    guardrails.after_call(
        "browser_snapshot",
        {},
        _failure("BROWSER_SNAPSHOT_MISSING", False),
        failed=True,
        browser_state_before=state,
        browser_state_after=state,
    )
    after_failed_snapshot = guardrails.before_call(
        "browser_run",
        {
            "intent": "inspect settled results another way",
            "code": "return (await fan.observe()).url",
        },
        browser_state=state,
    )
    replay = guardrails.before_call(
        "browser_run",
        {**original, "intent": "retry with new narration"},
        browser_state=state,
    )

    assert after_other_read.code == "browser_path_circuit_open"
    assert "browser_snapshot" in after_other_read.message
    assert after_failed_snapshot.code == "browser_no_progress_blocked_path_repeated"
    assert after_failed_snapshot.should_halt is True
    assert replay.code == "browser_program_effect_replay_blocked"


def test_repeated_block_after_unknown_program_keeps_original_user_context():
    guardrails = ToolCallGuardrailController()
    state = _browser_state()
    _seed_browser_snapshot(guardrails, state, "Search form")
    guardrails.after_call(
        "browser_run",
        {
            "intent": "提交搜索条件并等待结果",
            "code": "await fan.click(fan.ref(9))",
        },
        _program_result(
            "Search form",
            methods=("click",),
            status="unknown_after_effect",
            error={
                "code": "ACTION_TIMEOUT_PENDING",
                "retryable": False,
                "message": "click timed out while the page was settling",
            },
        ),
        failed=True,
        browser_state_before=state,
        browser_state_after=state,
    )

    changed_program = {
        "intent": "重新打开搜索页",
        "code": "await fan.navigate('https://app.test/search')",
    }
    first = guardrails.before_call(
        "browser_run",
        changed_program,
        browser_state=state,
    )
    second = guardrails.before_call(
        "browser_run",
        changed_program,
        browser_state=state,
    )

    assert first.code == "browser_path_circuit_open"
    assert second.code == "browser_no_progress_blocked_path_repeated"
    assert second.user_context == {
        "attempted_action": "提交搜索条件并等待结果",
        "status": "unknown_after_effect",
        "error_code": "ACTION_TIMEOUT_PENDING",
        "error_message": "click timed out while the page was settling",
        "page_url": "https://app.test/",
    }


def test_failed_after_effect_blocks_only_the_same_program_replay():
    guardrails = ToolCallGuardrailController()
    state = _browser_state()
    original = {
        "intent": "enable the field and type",
        "code": "await fan.click(fan.ref(4)); await fan.type(fan.ref(7), 'hello')",
        "timeout_ms": 20_000,
    }
    guardrails.after_call(
        "browser_run",
        original,
        _program_result(
            "Textbox is now enabled",
            methods=("click", "type"),
            status="failed_after_effect",
            error={
                "code": "ELEMENT_DISABLED",
                "message": "textbox was disabled before the page settled",
                "retryable": False,
            },
            run_effect={
                "occurred": True,
                "uncertain": False,
                "kinds": ["dom-structure"],
            },
        ),
        failed=True,
        browser_state_before=state,
        browser_state_after=state,
    )

    replay_with_new_narration = {
        "intent": "try the same operation again",
        "code": original["code"],
        "timeout_ms": 60_000,
    }
    first_replay = guardrails.before_call(
        "browser_run",
        replay_with_new_narration,
        browser_state=state,
    )
    corrected = guardrails.before_call(
        "browser_run",
        {
            "intent": "type now that the field is enabled",
            "code": "await fan.type(fan.ref(7), 'hello')",
        },
        browser_state=state,
    )
    second_replay = guardrails.before_call(
        "browser_run",
        replay_with_new_narration,
        browser_state=state,
    )

    assert first_replay.action == "skip"
    assert first_replay.code == "browser_program_effect_replay_blocked"
    assert corrected.action == "allow"
    assert second_replay.action == "halt"
    assert second_replay.code == "browser_program_effect_replay_repeated"

    guardrails.reset_for_turn()
    assert guardrails.before_call(
        "browser_run",
        replay_with_new_narration,
        browser_state=state,
    ).allows_execution


def test_failed_after_effect_without_final_snapshot_requires_snapshot_recovery():
    guardrails = ToolCallGuardrailController()
    state = _browser_state()
    original = {
        "intent": "submit the form once",
        "code": "await fan.click(fan.ref(9))",
    }
    failed_payload = json.loads(
        _program_result(
            "Submission may have landed",
            methods=("click",),
            status="failed_after_effect",
            error={
                "code": "BROWSER_FINAL_SNAPSHOT_FAILED",
                "message": "the authoritative final snapshot was unavailable",
                "retryable": False,
            },
            run_effect={
                "occurred": True,
                "uncertain": False,
                "kinds": ["external-submit"],
            },
        )
    )
    failed_payload.pop("final_snapshot", None)
    guardrails.after_call(
        "browser_run",
        original,
        json.dumps(failed_payload, ensure_ascii=False),
        failed=True,
        browser_state_before=state,
        browser_state_after=state,
    )

    corrected = {
        "intent": "inspect and continue without resubmitting",
        "code": "const page = await fan.observe(); return page.url",
    }
    blocked = guardrails.before_call(
        "browser_run",
        corrected,
        browser_state=state,
    )
    assert blocked.code == "browser_path_circuit_open"
    assert "browser_snapshot" in blocked.message

    guardrails.after_call(
        "browser_snapshot",
        {},
        _snapshot_result("Submission result page"),
        failed=False,
        browser_state_before=state,
        browser_state_after=state,
    )

    assert guardrails.before_call(
        "browser_run",
        corrected,
        browser_state=state,
    ).allows_execution
    replay = guardrails.before_call(
        "browser_run",
        {**original, "intent": "same submit with new narration"},
        browser_state=state,
    )
    assert replay.code == "browser_program_effect_replay_blocked"


def test_program_replay_identity_includes_task_space_but_ignores_intent_and_timeout():
    guardrails = ToolCallGuardrailController()
    state = _browser_state()
    code = "await fan.click(fan.ref(2))"
    guardrails.after_call(
        "browser_run",
        {
            "intent": "remove item",
            "code": code,
            "task_space_id": "space-a",
            "timeout_ms": 1_000,
        },
        _program_result(
            "Item removed",
            methods=("click",),
            status="unknown_after_effect",
            error={"code": "BROWSER_PROGRAM_OUTCOME_UNKNOWN"},
        ),
        failed=True,
        browser_state_before=state,
        browser_state_after=state,
    )

    same_program = guardrails.before_call(
        "browser_run",
        {
            "intent": "different explanation",
            "code": code,
            "task_space_id": "space-a",
            "timeout_ms": 90_000,
        },
        browser_state=state,
    )
    other_space = guardrails.before_call(
        "browser_run",
        {
            "intent": "same action in another isolated page",
            "code": code,
            "task_space_id": "space-b",
        },
        browser_state=state,
    )

    assert same_program.code == "browser_program_effect_replay_blocked"
    assert other_space.allows_execution


def test_effectful_needs_replan_program_cannot_be_replayed():
    guardrails = ToolCallGuardrailController()
    state = _browser_state()
    args = {
        "intent": "remove the row and wait for confirmation",
        "code": (
            "await fan.click(fan.ref(9)); "
            "await fan.waitForElement({text: \"It's gone!\"})"
        ),
    }
    guardrails.after_call(
        "browser_run",
        args,
        _program_result(
            "Row removed but confirmation text was not exposed",
            methods=("click", "waitForElement"),
            status="needs_replan",
            run_effect={
                "occurred": True,
                "uncertain": False,
                "kinds": ["dom-structure"],
            },
        ),
        failed=False,
        browser_state_before=state,
        browser_state_after=state,
    )

    decision = guardrails.before_call(
        "browser_run",
        {**args, "intent": "retry after replan"},
        browser_state=state,
    )

    assert decision.action == "skip"
    assert decision.code == "browser_program_effect_replay_blocked"


def test_effectful_needs_human_program_cannot_be_replayed():
    guardrails = ToolCallGuardrailController()
    state = _browser_state()
    args = {
        "intent": "submit once and stop for verification",
        "code": "await fan.click(fan.ref(9))",
    }
    guardrails.after_call(
        "browser_run",
        args,
        _program_result(
            "Human verification required",
            methods=("click",),
            status="needs_human",
            run_effect={
                "occurred": True,
                "uncertain": False,
                "kinds": ["external-submit"],
            },
        ),
        failed=False,
        browser_state_before=state,
        browser_state_after=state,
    )

    decision = guardrails.before_call(
        "browser_run",
        {**args, "intent": "try the same submit again"},
        browser_state=state,
    )

    assert decision.action == "skip"
    assert decision.code == "browser_program_effect_replay_blocked"


def test_unchanged_program_snapshot_keeps_page_level_circuit_open():
    guardrails = ToolCallGuardrailController()
    state = _browser_state()
    _seed_browser_snapshot(guardrails, state, "Textbox disabled")
    guardrails.after_call(
        "browser_select",
        {"index": 7, "value": "enabled"},
        _failure("ACTION_TIMEOUT_PENDING", False),
        failed=True,
        browser_state_before=state,
        browser_state_after=state,
    )

    guardrails.after_call(
        "browser_snapshot",
        {},
        _snapshot_result("Textbox disabled"),
        failed=False,
        browser_state_before=state,
        browser_state_after=state,
    )

    decision = guardrails.before_call(
        "browser_select",
        {"index": 7, "value": "enabled"},
        browser_state=state,
    )
    assert decision.action == "skip"
    assert decision.code == "browser_path_circuit_open"


def test_changed_program_snapshot_clears_page_level_circuit_and_hits():
    guardrails = ToolCallGuardrailController()
    state = _browser_state()
    _seed_browser_snapshot(guardrails, state, "Textbox disabled")
    guardrails.after_call(
        "browser_select",
        {"index": 7, "value": "enabled"},
        _failure("ACTION_TIMEOUT_PENDING", False),
        failed=True,
        browser_state_before=state,
        browser_state_after=state,
    )

    guardrails.after_call(
        "browser_snapshot",
        {},
        _snapshot_result("Textbox enabled"),
        failed=False,
        browser_state_before=state,
        browser_state_after=state,
    )

    decision = guardrails.before_call(
        "browser_select",
        {"index": 7, "value": "enabled"},
        browser_state=state,
    )
    assert decision.action == "allow"


def test_changed_snapshot_does_not_clear_effectful_program_replay_lock():
    guardrails = ToolCallGuardrailController()
    state = _browser_state()
    _seed_browser_snapshot(guardrails, state, "Textbox disabled")
    args = {
        "intent": "enable then type",
        "code": "await fan.click(fan.ref(4)); await fan.type(fan.ref(7), 'hello')",
    }
    guardrails.after_call(
        "browser_run",
        args,
        _program_result(
            "Textbox disabled",
            methods=("click", "type"),
            status="failed_after_effect",
            error={"code": "ELEMENT_DISABLED", "retryable": False},
        ),
        failed=True,
        browser_state_before=state,
        browser_state_after=state,
    )
    guardrails.after_call(
        "browser_snapshot",
        {},
        _snapshot_result("Textbox enabled"),
        failed=False,
        browser_state_before=state,
        browser_state_after=state,
    )

    decision = guardrails.before_call(
        "browser_run",
        {**args, "intent": "same code after a fresh snapshot"},
        browser_state=state,
    )
    assert decision.action == "skip"
    assert decision.code == "browser_program_effect_replay_blocked"


def test_changed_snapshot_keeps_persistent_capability_circuit_open():
    guardrails = ToolCallGuardrailController()
    state = _browser_state()
    _seed_browser_snapshot(guardrails, state, "Initial page")
    guardrails.after_call(
        "browser_find_visual",
        {"description": "submit"},
        _failure("VISION_PROVIDER_UNAVAILABLE", False),
        failed=True,
        browser_state_before=state,
        browser_state_after=state,
    )

    guardrails.after_call(
        "browser_snapshot",
        {},
        _snapshot_result("Page content changed"),
        failed=False,
        browser_state_before=state,
        browser_state_after=state,
    )

    decision = guardrails.before_call(
        "browser_find_visual",
        {"description": "close"},
        browser_state=state,
    )
    assert decision.action == "skip"
    assert decision.code == "browser_path_circuit_open"
