from __future__ import annotations

from types import SimpleNamespace

from agent.conversation_loop import (
    _browser_guardrail_blocked_response,
    _finalize_turn_status,
)


def _decision(
    code: str,
    tool_name: str = "browser_observe",
    *,
    count: int = 0,
    user_context: dict | None = None,
) -> SimpleNamespace:
    return SimpleNamespace(
        code=code,
        tool_name=tool_name,
        count=count,
        user_context=user_context or {},
    )


def test_normal_text_response_remains_completed():
    completed, failed, blocked = _finalize_turn_status(
        final_response="Done.",
        failed=False,
        unresolved_browser_action={},
        api_call_count=2,
        max_iterations=10,
        turn_exit_reason="text_response(finish_reason=stop)",
        guardrail_decision=None,
        navigation_failure=None,
    )

    assert completed is True
    assert failed is False
    assert blocked is False


def test_every_guardrail_halt_is_non_completed():
    completed, failed, blocked = _finalize_turn_status(
        final_response="Stopped retrying.",
        failed=False,
        unresolved_browser_action={},
        api_call_count=2,
        max_iterations=10,
        turn_exit_reason="guardrail_halt",
        guardrail_decision=_decision("same_tool_failure_halt", "terminal"),
        navigation_failure=None,
    )

    assert completed is False
    assert failed is False
    assert blocked is False


def test_browser_no_progress_halt_is_failed_and_blocked():
    completed, failed, blocked = _finalize_turn_status(
        final_response="Browser stopped.",
        failed=False,
        unresolved_browser_action={},
        api_call_count=8,
        max_iterations=20,
        turn_exit_reason="guardrail_halt",
        guardrail_decision=_decision("browser_no_progress_halt"),
        navigation_failure=None,
    )

    assert completed is False
    assert failed is True
    assert blocked is True


def test_browser_no_progress_halt_explains_manual_takeover_steps():
    response = _browser_guardrail_blocked_response(
        _decision(
            "browser_no_progress_halt",
            "browser_run",
            count=3,
            user_context={
                "attempted_action": "点击追踪按钮并等待结果",
                "status": "needs_replan",
                "error_code": "BROWSER_REPLAN_REQUIRED",
                "error_message": "Cannot find tracking button",
                "page_url": "https://www.ups.com/track",
            },
        ),
        None,
    )

    assert "当前任务还没有完成" in response
    assert "点击追踪按钮并等待结果" in response
    assert "没有找到完成这一步所需的控件或内容" in response
    assert "当前页面：https://www.ups.com/track" in response
    assert "左侧浏览器" in response
    assert "回到聊天框输入“继续”" in response
    assert "重新读取当前页面" in response
    assert "换一种方式重试" in response
    assert "最后一条工具错误" not in response
    assert "BROWSER_REPLAN_REQUIRED" not in response


def test_browser_timeout_handoff_warns_user_to_check_before_repeating():
    response = _browser_guardrail_blocked_response(
        _decision(
            "browser_no_progress_blocked_path_repeated",
            "browser_run",
            count=2,
            user_context={
                "attempted_action": "提交公司筛选条件",
                "status": "unknown_after_effect",
                "error_code": "ACTION_TIMEOUT_PENDING",
                "error_message": "underlying action is still settling",
            },
        ),
        None,
    )

    assert "页面操作等待超时" in response
    assert "确认「提交公司筛选条件」是否已经生效" in response
    assert "不要重复提交已经成功的操作" in response
    assert "ACTION_TIMEOUT_PENDING" not in response


def test_browser_no_progress_halt_without_context_still_gives_concrete_resume_flow():
    response = _browser_guardrail_blocked_response(
        _decision("browser_no_progress_halt", count=3),
        None,
    )

    assert "连续 3 次尝试" in response
    assert "完成刚才未成功的页面操作" in response
    assert "回到聊天框输入“继续”" in response
    assert "收到“继续”后" in response


def test_browser_navigation_failure_survives_into_exact_halt_message():
    failure = {
        "code": "NAVIGATION_FAILED",
        "networkErrorCode": -118,
        "errorDescription": "ERR_CONNECTION_TIMED_OUT",
        "requestedUrl": "https://www.immigration.govt.nz/",
        "retryable": False,
    }

    completed, failed, blocked = _finalize_turn_status(
        final_response="Browser stopped.",
        failed=False,
        unresolved_browser_action={},
        api_call_count=8,
        max_iterations=20,
        turn_exit_reason="guardrail_halt",
        guardrail_decision=_decision("browser_no_progress_blocked_path_repeated"),
        navigation_failure=failure,
    )
    response = _browser_guardrail_blocked_response(
        _decision("browser_no_progress_blocked_path_repeated"),
        failure,
    )

    assert completed is False
    assert failed is True
    assert blocked is True
    assert "连接目标网站超时" in response
    assert "ERR_CONNECTION_TIMED_OUT" in response
    assert "-118" in response
    assert "https://www.immigration.govt.nz/" in response
    assert "当前任务还没有完成" in response
    assert "检查网络或代理配置" in response
    assert "回到聊天框输入“继续”" in response


def test_terminal_navigation_failure_recovery_halt_is_failed_immediately():
    failure = {
        "code": "NAVIGATION_FAILED",
        "networkErrorCode": -130,
        "errorDescription": "ERR_PROXY_CONNECTION_FAILED",
        "requestedUrl": "https://overseas.example/",
        "retryable": False,
    }
    decision = _decision("browser_navigation_failure_circuit_open", "browser_wait")

    completed, failed, blocked = _finalize_turn_status(
        final_response="Browser stopped.",
        failed=False,
        unresolved_browser_action={},
        api_call_count=2,
        max_iterations=20,
        turn_exit_reason="guardrail_halt",
        guardrail_decision=decision,
        navigation_failure=failure,
    )
    response = _browser_guardrail_blocked_response(decision, failure)

    assert completed is False
    assert failed is True
    assert blocked is True
    assert "无法连接代理服务器" in response
    assert "继续等待当前错误页" in response
    assert "ERR_PROXY_CONNECTION_FAILED" in response
