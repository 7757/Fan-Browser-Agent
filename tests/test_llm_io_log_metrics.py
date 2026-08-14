from __future__ import annotations

import json
from unittest.mock import patch

from agent import llm_io_log


def test_browser_turn_metrics_distinguish_failures_retries_and_protocol_skips():
    emitted = []

    with (
        patch.object(llm_io_log, "enabled", return_value=True),
        patch.object(
            llm_io_log,
            "_emit",
            side_effect=lambda banner, body, sep="=": emitted.append((banner, body, sep)),
        ),
    ):
        llm_io_log.log_turn_start("Complete the form", {"task_id": "task-1", "model": "test-model"})
        llm_io_log.log_tool(
            "browser_fill_form",
            {"fields": [{"index": 1}, {"index": 2}, {"index": 3}]},
            {
                "effect": "snapshot-refresh",
                "result": {"status": "completed", "effect": "value-only"},
            },
            duration_ms=120,
        )
        failure = {
            "error": "target changed",
            "error_code": "CLICK_TARGET_MISMATCH",
            "error_details": {"retryable": True},
        }
        llm_io_log.log_tool(
            "browser_click",
            {"index": 9, "expected_text": "Submit"},
            failure,
            duration_ms=80,
        )
        llm_io_log.log_tool(
            "browser_click",
            {"index": 10, "expected_text": "Submit"},
            failure,
            duration_ms=90,
        )
        llm_io_log.log_tool(
            "browser_click",
            {"index": 11},
            {"executed": False, "status": "skipped", "error": "replan required"},
            duration_ms=1,
        )
        llm_io_log.log_tool(
            "browser_observe",
            {},
            {
                "dom": "[1]<input>",
                "warnings": [{"code": "SCREENSHOT_FAILED", "message": "capture failed"}],
            },
            duration_ms=40,
        )
        llm_io_log.log_turn_end(
            "done",
            {
                "outcome": "completed",
                "duration_ms": 500,
                "input_tokens": 100,
                "prompt_tokens": 500,
                "cache_read_tokens": 400,
                "cache_hit_ratio": 0.8,
                "output_tokens": 20,
                "total_tokens": 120,
                "estimated_cost_usd": None,
                "cost_status": "unknown",
            },
        )

    metric_body = next(body for banner, body, _sep in emitted if banner == "📊 浏览器任务效率")
    metrics = json.loads(metric_body)
    assert metrics["task_id"] == "task-1"
    assert metrics["browser_tool_calls"] == 5
    assert metrics["executed_browser_tool_calls"] == 4
    assert metrics["skipped_browser_tool_calls"] == 1
    assert metrics["failed_browser_tool_calls"] == 2
    assert metrics["degraded_browser_tool_calls"] == 1
    assert metrics["retry_count"] == 1
    assert metrics["errors_by_code"] == {"CLICK_TARGET_MISMATCH": 2}
    assert metrics["warnings_by_code"] == {"SCREENSHOT_FAILED": 1}
    assert metrics["effects"] == {"snapshot-refresh": 1}
    assert metrics["fill_form_fields"] == 3
    assert metrics["submit_count"] == 2
    assert metrics["slowest_tool"] == "browser_fill_form"
    assert metrics["slowest_tool_ms"] == 120
    assert metrics["total_tokens"] == 120
    assert metrics["prompt_tokens"] == 500
    assert metrics["cache_read_tokens"] == 400
    assert metrics["cache_hit_ratio"] == 0.8
    assert metrics["estimated_cost_usd"] is None
    assert metrics["cost_status"] == "unknown"


def test_program_and_skill_metrics_report_real_trace_work_separately():
    emitted = []

    with (
        patch.object(llm_io_log, "enabled", return_value=True),
        patch.object(
            llm_io_log,
            "_emit",
            side_effect=lambda banner, body, sep="=": emitted.append((banner, body, sep)),
        ),
    ):
        llm_io_log.log_turn_start("Complete the form", {"task_id": "program-1"})
        llm_io_log.log_tool(
            "skill_view",
            {"name": "browser-form-filling"},
            "name: browser-form-filling\ncontent:\n" + ("x" * 120),
            duration_ms=2,
        )
        llm_io_log.log_tool(
            "browser_run",
            {"intent": "fill and submit", "code": "/* omitted */"},
            {
                "status": "completed",
                "trace": [
                    {"step": 1, "method": "type", "status": "completed"},
                    {"step": 2, "method": "select", "status": "completed"},
                    {"step": 3, "method": "click", "status": "completed"},
                    {
                        "step": 4,
                        "method": "formSubmit",
                        "status": "completed",
                        "result": {"completedCount": 2},
                    },
                    {"step": 5, "method": "settle", "status": "completed"},
                    {"step": 6, "method": "observe", "status": "completed"},
                ],
                "effect": "snapshot-refresh",
                "final_snapshot": "[page: Submitted · https://example.test/done]",
            },
            duration_ms=300,
        )
        llm_io_log.log_tool(
            "browser_run",
            {"intent": "wait for input", "code": "/* omitted */"},
            {
                "status": "needs_replan",
                "replan_required": True,
                "trace": [{"step": 1, "method": "observe", "status": "completed"}],
                "effect": "snapshot-refresh",
            },
            duration_ms=10,
        )
        llm_io_log.log_turn_end("done", {"outcome": "completed"})

    metric_body = next(
        body for banner, body, _sep in emitted if banner == "📊 浏览器任务效率"
    )
    metrics = json.loads(metric_body)
    assert metrics["browser_tool_calls"] == 2
    assert metrics["program_steps"] == 7
    assert metrics["program_methods"] == {
        "type": 1,
        "select": 1,
        "click": 1,
        "formSubmit": 1,
        "settle": 1,
        "observe": 2,
    }
    assert metrics["program_input_actions"] == 4
    assert metrics["fill_form_fields"] == 4
    assert metrics["program_submit_actions"] == 1
    assert metrics["submit_count"] == 1
    assert metrics["program_click_actions"] == 1
    assert metrics["program_settle_steps"] == 1
    assert metrics["program_observe_steps"] == 2
    assert metrics["program_final_observe_steps"] == 2
    assert metrics["replan_count"] == 1
    assert metrics["skill_view_calls"] == 1
    assert metrics["loaded_skills"] == ["browser-form-filling"]
    assert metrics["skill_result_chars"] > 120


def test_program_failure_statuses_are_counted_as_failed_browser_calls():
    emitted = []

    with (
        patch.object(llm_io_log, "enabled", return_value=True),
        patch.object(
            llm_io_log,
            "_emit",
            side_effect=lambda banner, body, sep="=": emitted.append((banner, body, sep)),
        ),
    ):
        llm_io_log.log_turn_start("Edit the iframe", {"task_id": "program-failure"})
        llm_io_log.log_tool(
            "browser_run",
            {"intent": "edit iframe", "code": "/* omitted */"},
            {
                "status": "failed_after_effect",
                "error": {
                    "code": "BROWSER_PROGRAM_FAILED",
                    "message": "key is required",
                },
                "trace": [
                    {"step": 1, "method": "keys", "status": "completed"},
                    {"step": 2, "method": "keys", "status": "failed"},
                ],
            },
            duration_ms=20,
        )
        llm_io_log.log_turn_end("failed", {"outcome": "failed"})

    metric_body = next(
        body for banner, body, _sep in emitted if banner == "📊 浏览器任务效率"
    )
    metrics = json.loads(metric_body)
    assert metrics["browser_tool_calls"] == 1
    assert metrics["executed_browser_tool_calls"] == 1
    assert metrics["failed_browser_tool_calls"] == 1
    assert metrics["errors_by_code"] == {"BROWSER_PROGRAM_FAILED": 1}
