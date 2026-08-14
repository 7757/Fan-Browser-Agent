"""Malformed model tool arguments must not crash compression or display."""

import json
from unittest.mock import patch

from agent.context_compressor import _summarize_tool_result
from agent.display import build_tool_preview, get_cute_tool_message


def test_tool_result_summaries_accept_non_string_arguments():
    cases = [
        ("terminal", {"command": True}, "True"),
        ("terminal", {"command": 42}, "42"),
        ("write_file", {"path": "test.txt", "content": 123}, "write_file"),
        ("delegate_task", {"goal": False}, "False"),
        ("execute_code", {"code": 0}, "0"),
        ("vision_analyze", {"question": ["what"]}, "vision_analyze"),
    ]

    for tool_name, args, expected in cases:
        result = _summarize_tool_result(
            tool_name,
            json.dumps(args),
            '{"exit_code": 0}',
        )
        assert expected in result


def test_tool_result_summary_accepts_non_object_json():
    for args in (json.dumps([1, 2]), json.dumps("bare"), "null"):
        result = _summarize_tool_result("terminal", args, "output")
        assert isinstance(result, str)
        assert "terminal" in result


def test_tool_result_summary_backstop_never_raises():
    with patch(
        "agent.context_compressor._summarize_tool_result_unguarded",
        side_effect=TypeError("boom"),
    ):
        result = _summarize_tool_result("terminal", "{}", "x" * 300)

    assert result == "[terminal] (300 chars result)"


def test_normal_tool_result_summary_is_unchanged():
    result = _summarize_tool_result(
        "terminal",
        json.dumps({"command": "npm test"}),
        '{"exit_code": 0}\nsecond line',
    )

    assert result == "[terminal] ran `npm test` -> exit 0, 2 lines output"


def test_process_preview_coerces_non_string_fields():
    assert build_tool_preview(
        "process",
        {"action": "submit", "session_id": 123, "data": 42},
    ) == 'submit 123 "42"'


def test_tool_preview_backstop_hides_malformed_preview():
    with patch(
        "agent.display._build_tool_preview_unguarded",
        side_effect=TypeError("boom"),
    ):
        assert build_tool_preview("process", {"session_id": 123}) is None


def test_completion_display_accepts_hostile_argument_shapes():
    hostile_values = [None, True, 42, 3.14, ["a"], {"key": "value"}]
    tools = [
        "process",
        "browser_navigate",
        "todo",
        "session_search",
        "memory",
        "execute_code",
        "delegate_task",
    ]
    keys = [
        "action",
        "session_id",
        "data",
        "url",
        "todos",
        "query",
        "content",
        "code",
        "goal",
    ]

    for tool_name in tools:
        for value in hostile_values:
            args = {key: value for key in keys}
            result = get_cute_tool_message(tool_name, args, 0.1)
            assert isinstance(result, str) and result


def test_process_completion_keeps_numeric_session_id_visible():
    result = get_cute_tool_message(
        "process",
        {"action": "poll", "session_id": 123},
        0.1,
    )

    assert "poll 123" in result
