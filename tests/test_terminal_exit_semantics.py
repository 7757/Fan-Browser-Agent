"""Regression coverage for expected non-zero terminal exit codes."""

import json

from agent.display import _detect_tool_failure
from agent.tool_guardrails import classify_tool_failure
from tools.terminal_tool import (
    _exit_code_context,
    _interpret_exit_code,
    _last_shell_status_segment,
)


EXAMPLE_APP_LOOKUP_COMMAND = (
    'mdfind "kMDItemKind == \'Application\'" | '
    'grep -i "exampleapp\\|example app" 2>/dev/null; '
    'ls /Applications/ | grep -i "exampleapp\\|example app" 2>/dev/null; '
    'ls ~/Applications/ 2>/dev/null | grep -i "exampleapp\\|example app"'
)


def test_last_shell_status_segment_ignores_quoted_grep_alternation():
    assert _last_shell_status_segment(EXAMPLE_APP_LOOKUP_COMMAND) == (
        'grep -i "exampleapp\\|example app"'
    )


def test_expected_grep_exit_is_recognized_after_compound_lookup():
    assert _interpret_exit_code(EXAMPLE_APP_LOOKUP_COMMAND, 1) == (
        "No matches found (not an error)"
    )
    assert _exit_code_context(EXAMPLE_APP_LOOKUP_COMMAND, 1) == (
        "No matches found (not an error)",
        True,
    )


def test_shell_operators_inside_quotes_or_escaped_are_not_split():
    command = r'''printf '%s' "a|b;c&&d"; grep 'x\|y' file'''
    assert _last_shell_status_segment(command) == r"grep 'x\|y' file"


def test_expected_nonzero_terminal_result_is_not_classified_as_failure():
    result = json.dumps(
        {
            "output": "ExampleApp.app",
            "exit_code": 1,
            "error": None,
            "exit_code_meaning": "No matches found (not an error)",
            "exit_code_expected": True,
        }
    )

    assert _detect_tool_failure("terminal", result) == (False, "")
    assert classify_tool_failure("terminal", result) == (False, "")


def test_unexpected_nonzero_terminal_result_remains_a_failure():
    result = json.dumps({"output": "boom", "exit_code": 2, "error": None})

    assert _detect_tool_failure("terminal", result) == (True, " [exit 2]")
    assert classify_tool_failure("terminal", result) == (True, " [exit 2]")
