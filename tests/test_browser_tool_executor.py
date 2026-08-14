from __future__ import annotations

import json
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

from agent.tool_executor import execute_tool_calls_sequential
from agent.tool_guardrails import ToolGuardrailDecision
from agent.browser_tool_protocol import (
    browser_observation_content_fingerprint,
    coalesce_browser_type_calls,
)
import tools.electron_browser_tool as browser_tool
from tools.electron_browser_tool import current_browser_decision_token


def _tool_call(call_id: str, name: str, arguments: dict):
    return SimpleNamespace(
        id=call_id,
        function=SimpleNamespace(
            name=name,
            arguments=json.dumps(arguments, ensure_ascii=False),
        ),
    )


def _agent() -> SimpleNamespace:
    agent = SimpleNamespace()
    agent._interrupt_requested = False
    agent._turns_since_memory = 0
    agent._iters_since_skill = 0
    agent.log_prefix = ""
    agent.log_prefix_chars = 200
    agent.verbose_logging = False
    agent.tool_progress_mode = "off"
    agent.tool_progress_callback = None
    agent.tool_start_callback = None
    agent.tool_complete_callback = None
    agent.tool_delay = 0
    agent._current_tool = None
    agent._current_turn_id = "turn-1"
    agent._current_api_request_id = "request-1"
    agent.session_id = "session-a"
    agent._checkpoint_mgr = SimpleNamespace(enabled=False)
    agent._context_engine_tool_names = frozenset()
    agent._memory_manager = None
    agent.collect_callback = lambda _payload: json.dumps(
        {"status": "submitted", "answer": "ready"}
    )
    agent.quiet_mode = False
    agent.valid_tool_names = {"browser_click", "browser_fill_form", "browser_observe", "browser_wait", "browser_settle", "browser_search", "browser_search_page", "browser_page_content", "browser_navigate", "browser_switch_tab", "test_tool"}
    agent.enabled_toolsets = None
    agent.disabled_toolsets = None
    agent._browser_decision_token = {
        "version": 1,
        "sessionId": "session-a",
        "activeTabId": "session-a",
        "pageGeneration": 2,
        "selectorGeneration": 8,
        "tabListGeneration": 0,
    }
    agent._tool_guardrails = SimpleNamespace(
        before_call=lambda *_args, **_kwargs: SimpleNamespace(allows_execution=True)
    )
    agent._subdirectory_hints = SimpleNamespace(check_tool_call=lambda *_args: "")
    agent._touch_activity = MagicMock()
    agent._should_emit_quiet_tool_messages = lambda: False
    agent._vprint = MagicMock()
    agent._apply_pending_steer_to_tool_results = MagicMock()
    agent._tool_result_content_for_active_model = lambda _name, value: value
    agent._append_guardrail_observation = lambda _name, _args, value, **_kwargs: value
    agent._record_file_mutation_result = MagicMock()
    agent._turn_unresolved_browser_action = {}
    agent._turn_browser_navigation_failure = None
    agent._tool_guardrail_halt_decision = None

    def _guardrail_block_result(decision):
        agent._tool_guardrail_halt_decision = decision
        return json.dumps(
            {
                "error": decision.message,
                "tool_loop_guardrail": decision.to_metadata(),
            },
            ensure_ascii=False,
        )
    agent._guardrail_block_result = _guardrail_block_result
    return agent


def _run(agent, calls, dispatch):
    messages: list[dict] = []
    assistant = SimpleNamespace(tool_calls=calls)
    with (
        patch("run_agent.handle_function_call", side_effect=dispatch),
        patch(
            "agent.tool_executor.maybe_persist_tool_result",
            side_effect=lambda **kwargs: kwargs["content"],
        ),
        patch("agent.tool_executor.get_active_env", return_value=None),
        patch("agent.tool_executor.enforce_turn_budget"),
    ):
        execute_tool_calls_sequential(agent, assistant, messages, "session-a")
    return messages


def test_first_browser_mutation_executes_and_later_browser_call_is_skipped():
    agent = _agent()
    executed: list[str] = []
    tokens: list[dict | None] = []

    def dispatch(name, _arguments, *_args, **_kwargs):
        executed.append(name)
        tokens.append(current_browser_decision_token())
        return json.dumps({"ok": True})

    messages = _run(
        agent,
        [
            _tool_call("click-1", "browser_click", {"index": 137}),
            _tool_call("click-2", "browser_click", {"index": 144}),
            _tool_call("other-1", "test_tool", {"value": 1}),
        ],
        dispatch,
    )

    assert executed == ["browser_click", "test_tool"]
    assert tokens[0] == agent._browser_decision_token
    assert tokens[1] is None
    assert [message["tool_call_id"] for message in messages] == ["click-1", "click-2", "other-1"]
    assert '"executed": false' in messages[1]["content"]
    assert '"replan_required": true' in messages[1]["content"]


def test_multiple_read_only_browser_calls_can_share_one_decision_snapshot():
    agent = _agent()
    executed: list[str] = []

    def dispatch(name, _arguments, *_args, **_kwargs):
        executed.append(name)
        assert current_browser_decision_token() == agent._browser_decision_token
        return json.dumps({"ok": True})

    messages = _run(
        agent,
        [
            _tool_call("search-1", "browser_search_page", {"pattern": "Fan"}),
            _tool_call("content-1", "browser_page_content", {"format": "text"}),
        ],
        dispatch,
    )

    assert executed == ["browser_search_page", "browser_page_content"]
    assert len(messages) == 2


def test_adjacent_indexed_actions_execute_with_live_same_snapshot_validation():
    agent = _agent()
    dispatched: list[tuple[str, dict]] = []

    def dispatch(name, arguments, *_args, **_kwargs):
        dispatched.append((name, dict(arguments)))
        if arguments.get("_fan_same_snapshot_continue"):
            return json.dumps(
                {
                    "effect": "dom-structure",
                    "same_snapshot_continue": True,
                    "result": {"selected": arguments["index"]},
                }
            )
        return json.dumps(
            {
                "effect": "snapshot-refresh",
                "result": {"clicked": arguments["index"]},
                "dom": "<page_observation>final</page_observation>",
            }
        )

    messages = _run(
        agent,
        [
            _tool_call("select-1", "browser_select", {"index": 10, "text": "CHINA P. R."}),
            _tool_call("click-1", "browser_click", {"index": 12}),
        ],
        dispatch,
    )

    assert [name for name, _args in dispatched] == ["browser_select", "browser_click"]
    assert dispatched[0][1]["_fan_same_snapshot_continue"] is True
    assert "_fan_same_snapshot_continue" not in dispatched[1][1]
    assert [message["tool_call_id"] for message in messages] == ["select-1", "click-1"]


def test_same_snapshot_batch_stops_when_runtime_reports_navigation():
    agent = _agent()
    dispatch = MagicMock(
        return_value=json.dumps(
            {
                "effect": "navigation",
                "same_snapshot_continue": True,
                "result": {"clicked": 10},
            }
        )
    )

    messages = _run(
        agent,
        [
            _tool_call("click-1", "browser_click", {"index": 10}),
            _tool_call("click-2", "browser_click", {"index": 12}),
        ],
        dispatch,
    )

    dispatch.assert_called_once()
    assert '"replan_required": true' in messages[1]["content"]


def test_navigation_failure_is_retained_as_turn_evidence_without_halting():
    agent = _agent()
    agent._turn_browser_navigation_failure = None

    def dispatch(name, _arguments, *_args, **_kwargs):
        assert name == "browser_navigate"
        return json.dumps(
            {
                "error": "Navigation failed: ERR_CONNECTION_TIMED_OUT",
                "code": "NAVIGATION_FAILED",
                "details": {
                    "networkErrorCode": -118,
                    "errorDescription": "ERR_CONNECTION_TIMED_OUT",
                    "requestedUrl": "https://www.immigration.govt.nz/",
                    "retryable": False,
                    "replanRequired": False,
                },
            }
        )

    messages = _run(
        agent,
        [_tool_call("navigate-1", "browser_navigate", {"url": "https://www.immigration.govt.nz/"})],
        dispatch,
    )

    assert len(messages) == 1
    assert agent._turn_browser_navigation_failure == {
        "code": "NAVIGATION_FAILED",
        "error": "Navigation failed: ERR_CONNECTION_TIMED_OUT",
        "networkErrorCode": -118,
        "errorDescription": "ERR_CONNECTION_TIMED_OUT",
        "requestedUrl": "https://www.immigration.govt.nz/",
        "retryable": False,
    }


def test_successful_navigation_clears_older_navigation_failure_evidence():
    agent = _agent()
    agent._turn_browser_navigation_failure = {
        "code": "NAVIGATION_TIMEOUT",
        "errorDescription": "ERR_CONNECTION_TIMED_OUT",
    }

    _run(
        agent,
        [_tool_call("navigate-1", "browser_navigate", {"url": "https://example.com/"})],
        lambda *_args, **_kwargs: json.dumps(
            {"navigated": "https://example.com/", "result": {"settled": True}}
        ),
    )

    assert agent._turn_browser_navigation_failure is None


def test_non_retryable_navigation_failure_halts_followup_observe_without_dispatch():
    agent = _agent()
    agent._turn_browser_navigation_failure = {
        "code": "NAVIGATION_FAILED",
        "error": "ERR_CONNECTION_TIMED_OUT (-118)",
        "networkErrorCode": -118,
        "errorDescription": "ERR_CONNECTION_TIMED_OUT",
        "requestedUrl": "https://www.immigration.govt.nz/",
        "retryable": False,
    }
    dispatch = MagicMock()

    messages = _run(
        agent,
        [_tool_call("observe-1", "browser_observe", {})],
        dispatch,
    )

    dispatch.assert_not_called()
    assert len(messages) == 1
    assert agent._tool_guardrail_halt_decision.code == (
        "browser_navigation_failure_circuit_open"
    )
    assert agent._tool_guardrail_halt_decision.tool_name == "browser_observe"
    assert "ERR_CONNECTION_TIMED_OUT" in messages[0]["content"]


def test_retryable_navigation_failure_still_allows_followup_observe():
    agent = _agent()
    agent._turn_browser_navigation_failure = {
        "code": "NAVIGATION_FAILED",
        "retryable": True,
    }
    dispatch = MagicMock(return_value=json.dumps({"dom": "current page"}))

    _run(
        agent,
        [_tool_call("observe-1", "browser_observe", {})],
        dispatch,
    )

    dispatch.assert_called_once()


def test_alternate_navigation_remains_allowed_after_terminal_navigation_failure():
    agent = _agent()
    agent._turn_browser_navigation_failure = {
        "code": "NAVIGATION_FAILED",
        "retryable": False,
    }
    dispatch = MagicMock(
        return_value=json.dumps(
            {"navigated": "https://alternate.example/", "result": {"settled": True}}
        )
    )

    _run(
        agent,
        [
            _tool_call(
                "navigate-2",
                "browser_navigate",
                {"url": "https://alternate.example/"},
            )
        ],
        dispatch,
    )

    dispatch.assert_called_once()
    assert agent._turn_browser_navigation_failure is None


def test_switching_to_another_tab_clears_navigation_failure_for_the_old_tab():
    agent = _agent()
    agent._turn_browser_navigation_failure = {
        "code": "NAVIGATION_FAILED",
        "retryable": False,
    }

    _run(
        agent,
        [_tool_call("switch-1", "browser_switch_tab", {"tab_id": "t1"})],
        MagicMock(return_value=json.dumps({"switched": "t1"})),
    )

    assert agent._turn_browser_navigation_failure is None


def test_adjacent_form_fill_and_submit_lower_to_one_runtime_transaction():
    agent = _agent()
    agent.tool_start_callback = MagicMock()
    agent.tool_complete_callback = MagicMock()
    dispatch = MagicMock()
    transaction = MagicMock(
        return_value=(
            json.dumps(
                {
                    "effect": "value-only",
                    "result": {"status": "completed", "completedCount": 1},
                }
            ),
            json.dumps(
                {
                    "effect": "snapshot-refresh",
                    "result": {"status": "completed", "executed": True},
                    "dom": "<page_observation>done</page_observation>",
                }
            ),
        )
    )
    calls = [
        _tool_call("fill-1", "browser_fill_form", {"fields": [{"index": 1, "text": "Ada"}]}),
        _tool_call("submit-1", "browser_click", {"index": 9, "expected_text": "Submit"}),
    ]

    with patch.object(
        browser_tool,
        "_browser_form_submit_transaction",
        transaction,
    ):
        messages = _run(agent, calls, dispatch)

    dispatch.assert_not_called()
    transaction.assert_called_once_with(
        "browser_fill_form",
        {"fields": [{"index": 1, "text": "Ada"}]},
        {"index": 9, "expected_text": "Submit"},
        task_id="session-a",
    )
    assert len(messages) == 2
    assert [message["tool_call_id"] for message in messages] == ["fill-1", "submit-1"]
    assert '"executed": true' in messages[1]["content"]
    assert [call.args[0] for call in agent.tool_start_callback.call_args_list] == [
        "fill-1",
        "submit-1",
    ]
    assert [call.args[0] for call in agent.tool_complete_callback.call_args_list] == [
        "fill-1",
        "submit-1",
    ]


@pytest.mark.parametrize("blocked_by", ["plugin", "guardrail"])
def test_blocked_form_input_safely_settles_adjacent_click_without_dispatch(blocked_by):
    agent = _agent()
    agent.tool_start_callback = MagicMock()
    agent.tool_complete_callback = MagicMock()
    dispatch = MagicMock()
    terminal_post = MagicMock()

    if blocked_by == "plugin":
        pre_hook = MagicMock(
            side_effect=lambda name, *_args, **_kwargs: (
                "input policy blocked" if name == "browser_type" else None
            )
        )
    else:
        pre_hook = MagicMock(return_value=None)

        def before_call(name, *_args, **_kwargs):
            if name == "browser_type":
                return ToolGuardrailDecision(
                    action="block",
                    code="test-input-block",
                    message="input guardrail blocked",
                    tool_name=name,
                    count=1,
                )
            return ToolGuardrailDecision()

        agent._tool_guardrails.before_call = MagicMock(side_effect=before_call)

    with (
        patch(
            "fan_cli.plugins.get_pre_tool_call_block_message",
            pre_hook,
        ),
        patch.object(
            browser_tool,
            "_browser_form_submit_transaction",
        ) as transaction,
        patch(
            "agent.tool_executor._emit_terminal_post_tool_call",
            terminal_post,
        ),
    ):
        messages = _run(
            agent,
            [
                _tool_call("type-1", "browser_type", {"index": 1, "text": "1234"}),
                _tool_call("submit-1", "browser_click", {"index": 9}),
            ],
            dispatch,
        )

    dispatch.assert_not_called()
    transaction.assert_not_called()
    assert [message["tool_call_id"] for message in messages] == ["type-1", "submit-1"]
    click_content = messages[1]["content"]
    assert '"status": "skipped"' in click_content
    assert '"executed": false' in click_content
    assert '"replan_required": true' in click_content
    assert [call.kwargs["tool_call_id"] for call in pre_hook.call_args_list] == [
        "type-1",
        "submit-1",
    ]
    assert [call.kwargs["tool_call_id"] for call in terminal_post.call_args_list] == [
        "type-1",
        "submit-1",
    ]
    assert terminal_post.call_args_list[1].kwargs["status"] == "skipped"
    assert [call.args[0] for call in agent.tool_start_callback.call_args_list] == [
        "submit-1"
    ]
    assert [call.args[0] for call in agent.tool_complete_callback.call_args_list] == [
        "submit-1"
    ]


def test_interrupt_after_click_preflight_block_still_settles_that_click_hook():
    agent = _agent()
    pre_hook = MagicMock(
        side_effect=lambda name, *_args, **_kwargs: (
            "click policy blocked" if name == "browser_click" else None
        )
    )
    terminal_post = MagicMock()

    def dispatch(name, *_args, **_kwargs):
        assert name == "browser_type"
        agent._interrupt_requested = True
        return json.dumps({"effect": "value-only", "ok": True})

    with (
        patch("fan_cli.plugins.get_pre_tool_call_block_message", pre_hook),
        patch("agent.tool_executor._emit_terminal_post_tool_call", terminal_post),
    ):
        messages = _run(
            agent,
            [
                _tool_call("type-1", "browser_type", {"index": 1, "text": "1234"}),
                _tool_call("submit-1", "browser_click", {"index": 9}),
            ],
            dispatch,
        )

    assert [message["tool_call_id"] for message in messages] == ["type-1", "submit-1"]
    assert "click policy blocked" in messages[1]["content"]
    assert [call.kwargs["tool_call_id"] for call in pre_hook.call_args_list] == [
        "type-1",
        "submit-1",
    ]
    terminal_post.assert_called_once()
    assert terminal_post.call_args.kwargs["tool_call_id"] == "submit-1"
    assert terminal_post.call_args.kwargs["status"] == "blocked"


def test_form_submit_dynamic_change_completes_input_and_skips_click_with_replan():
    agent = _agent()
    dispatch = MagicMock()
    transaction = MagicMock(
        return_value=(
            json.dumps(
                {"effect": "value-only", "result": {"status": "completed"}}
            ),
            json.dumps(
                {
                    "effect": "snapshot-refresh",
                    "result": {
                        "status": "skipped",
                        "executed": False,
                        "replan_required": True,
                        "code": "FORM_PAGE_CHANGED",
                    },
                    "dom": "<page_observation>changed</page_observation>",
                }
            ),
        )
    )

    with patch.object(browser_tool, "_browser_form_submit_transaction", transaction):
        messages = _run(
            agent,
            [
                _tool_call("type-1", "browser_type", {"index": 1, "text": "1234"}),
                _tool_call("submit-1", "browser_click", {"index": 9}),
            ],
            dispatch,
        )

    dispatch.assert_not_called()
    assert '"status": "completed"' in messages[0]["content"]
    assert '"executed": false' in messages[1]["content"]
    assert '"replan_required": true' in messages[1]["content"]
    assert "BROWSER_REPLAN_REQUIRED" not in messages[1]["content"]


def test_form_submit_runtime_failure_settles_both_original_call_ids_once():
    agent = _agent()
    agent.tool_complete_callback = MagicMock()
    dispatch = MagicMock()

    with patch.object(
        browser_tool,
        "_browser_form_submit_transaction",
        return_value=(
            json.dumps({"error": "runtime failed", "code": "FORM_SUBMIT_FAILED"}),
            json.dumps(
                {
                    "effect": "dom-structure",
                    "result": {
                        "status": "skipped",
                        "executed": False,
                        "replan_required": True,
                    },
                }
            ),
        ),
    ):
        messages = _run(
            agent,
            [
                _tool_call("type-1", "browser_type", {"index": 1, "text": "1234"}),
                _tool_call("submit-1", "browser_click", {"index": 9}),
            ],
            dispatch,
        )

    dispatch.assert_not_called()
    assert [message["tool_call_id"] for message in messages] == ["type-1", "submit-1"]
    assert [call.args[0] for call in agent.tool_complete_callback.call_args_list] == [
        "type-1",
        "submit-1",
    ]


def test_form_submit_python_exception_marks_both_steps_unknown_and_non_retryable():
    agent = _agent()
    dispatch = MagicMock()

    with patch.object(
        browser_tool,
        "_browser_form_submit_transaction",
        side_effect=RuntimeError("split failed after RPC"),
    ):
        messages = _run(
            agent,
            [
                _tool_call("type-1", "browser_type", {"index": 1, "text": "1234"}),
                _tool_call("submit-1", "browser_click", {"index": 9}),
            ],
            dispatch,
        )

    dispatch.assert_not_called()
    assert [message["tool_call_id"] for message in messages] == ["type-1", "submit-1"]
    for message in messages:
        content = message["content"]
        assert '"status": "unknown"' in content
        assert '"executed": null' in content
        assert '"do_not_retry": true' in content
        assert '"code": "FORM_SUBMIT_EXECUTOR_EXCEPTION"' in content


@pytest.mark.parametrize(
    "type_args",
    [
        {"index": 1, "text": "1234", "unknown_option": True},
        {"index": 1, "text": "1234", "autocomplete_wait": True},
    ],
)
def test_form_submit_lowering_fails_closed_for_unknown_or_autocomplete_input(type_args):
    agent = _agent()
    dispatch = MagicMock(return_value=json.dumps({"effect": "value-only", "ok": True}))

    with patch.object(
        browser_tool,
        "_browser_form_submit_transaction",
    ) as transaction:
        _run(
            agent,
            [
                _tool_call("type-1", "browser_type", type_args),
                _tool_call("submit-1", "browser_click", {"index": 9}),
            ],
            dispatch,
        )

    transaction.assert_not_called()
    assert [call.args[0] for call in dispatch.call_args_list] == [
        "browser_type",
        "browser_click",
    ]


@pytest.mark.parametrize(
    "disabled_option",
    [
        {"autocomplete_wait": False},
        {"autocompleteWait": False},
        {"autocomplete_wait_ms": 0},
        {"autocompleteWaitMs": 0},
    ],
)
def test_disabled_autocomplete_option_allows_form_submit_lowering(disabled_option):
    agent = _agent()
    dispatch = MagicMock()
    transaction = MagicMock(
        return_value=(
            json.dumps({"effect": "value-only", "result": {"status": "completed"}}),
            json.dumps(
                {
                    "effect": "snapshot-refresh",
                    "result": {"status": "completed", "executed": True},
                }
            ),
        )
    )

    with patch.object(
        browser_tool,
        "_browser_form_submit_transaction",
        transaction,
    ):
        messages = _run(
            agent,
            [
                _tool_call(
                    "type-1",
                    "browser_type",
                    {"index": 1, "text": "1234", **disabled_option},
                ),
                _tool_call("submit-1", "browser_click", {"index": 9}),
            ],
            dispatch,
        )

    dispatch.assert_not_called()
    transaction.assert_called_once()
    assert [message["tool_call_id"] for message in messages] == ["type-1", "submit-1"]


def test_form_submit_lowering_refuses_allow_occluded_click():
    agent = _agent()
    dispatch = MagicMock(return_value=json.dumps({"effect": "value-only", "ok": True}))

    with patch.object(
        browser_tool,
        "_browser_form_submit_transaction",
    ) as transaction:
        _run(
            agent,
            [
                _tool_call("type-1", "browser_type", {"index": 1, "text": "1234"}),
                _tool_call(
                    "submit-1",
                    "browser_click",
                    {"index": 9, "allow_occluded": True},
                ),
            ],
            dispatch,
        )

    transaction.assert_not_called()
    assert [call.args[0] for call in dispatch.call_args_list] == [
        "browser_type",
        "browser_click",
    ]


def test_interrupt_after_physical_form_submit_still_settles_cached_click_result():
    agent = _agent()
    agent.tool_start_callback = MagicMock()
    dispatch = MagicMock()

    def transaction(*_args, **_kwargs):
        agent._interrupt_requested = True
        return (
            json.dumps({"effect": "value-only", "result": {"status": "completed"}}),
            json.dumps(
                {
                    "effect": "snapshot-refresh",
                    "result": {"status": "completed", "executed": True},
                    "dom": "<page_observation>submitted</page_observation>",
                }
            ),
        )

    with patch.object(
        browser_tool,
        "_browser_form_submit_transaction",
        side_effect=transaction,
    ):
        messages = _run(
            agent,
            [
                _tool_call("type-1", "browser_type", {"index": 1, "text": "1234"}),
                _tool_call("submit-1", "browser_click", {"index": 9}),
            ],
            dispatch,
        )

    assert [message["tool_call_id"] for message in messages] == ["type-1", "submit-1"]
    assert "not started" not in messages[1]["content"]
    assert '"executed": true' in messages[1]["content"]
    assert [call.args[0] for call in agent.tool_start_callback.call_args_list] == [
        "type-1",
        "submit-1",
    ]


def test_keyboard_interrupt_settles_both_form_submit_hooks_with_unknown_results():
    agent = _agent()
    agent.tool_start_callback = MagicMock()
    terminal_post = MagicMock()
    pre_hook = MagicMock(return_value=None)

    with (
        patch.object(
            browser_tool,
            "_browser_form_submit_transaction",
            side_effect=KeyboardInterrupt,
        ),
        patch(
            "fan_cli.plugins.get_pre_tool_call_block_message",
            pre_hook,
        ),
        patch(
            "agent.tool_executor._emit_terminal_post_tool_call",
            terminal_post,
        ),
    ):
        messages = _run(
            agent,
            [
                _tool_call("type-1", "browser_type", {"index": 1, "text": "1234"}),
                _tool_call("submit-1", "browser_click", {"index": 9}),
            ],
            MagicMock(),
        )

    assert [call.args[0] for call in agent.tool_start_callback.call_args_list] == [
        "type-1",
        "submit-1",
    ]
    assert [message["tool_call_id"] for message in messages] == ["type-1", "submit-1"]
    assert all('"execution_state": "unknown"' in message["content"] for message in messages)
    assert [call.kwargs["tool_call_id"] for call in terminal_post.call_args_list] == [
        "type-1",
        "submit-1",
    ]
    assert all(call.kwargs["status"] == "cancelled" for call in terminal_post.call_args_list)
    assert [call.kwargs["tool_call_id"] for call in pre_hook.call_args_list] == [
        "type-1",
        "submit-1",
    ]


def test_coalesced_browser_types_dispatch_as_one_form_transaction_without_skip():
    agent = _agent()
    calls = coalesce_browser_type_calls(
        [
            _tool_call("name", "browser_type", {"index": 205, "text": "张三"}),
            _tool_call(
                "identity",
                "browser_type",
                {"index": 210, "text": "11010519491231002X"},
            ),
        ],
        available_tool_names={"browser_type", "browser_fill_form"},
    )
    dispatch = MagicMock(
        return_value=json.dumps(
            {
                "effect": "snapshot-refresh",
                "result": {
                    "status": "completed",
                    "completedCount": 2,
                    "effect": "value-only",
                },
                "dom": "[205]<input value=张三>\n[210]<input value=11010519491231002X>",
            },
            ensure_ascii=False,
        )
    )

    messages = _run(agent, calls, dispatch)

    dispatch.assert_called_once()
    assert dispatch.call_args.args[0] == "browser_fill_form"
    assert dispatch.call_args.args[1] == {
        "fields": [
            {"index": 205, "text": "张三"},
            {"index": 210, "text": "11010519491231002X"},
        ]
    }
    assert len(messages) == 1
    assert "BROWSER_REPLAN_REQUIRED" not in messages[0]["content"]


def test_browser_error_stops_remaining_browser_calls():
    agent = _agent()
    executed: list[str] = []

    def dispatch(name, _arguments, *_args, **_kwargs):
        executed.append(name)
        return json.dumps({"error": "page unavailable"})

    messages = _run(
        agent,
        [
            _tool_call("search-1", "browser_search_page", {"pattern": "Fan"}),
            _tool_call("click-1", "browser_click", {"index": 9}),
        ],
        dispatch,
    )

    assert executed == ["browser_search_page"]
    assert "BROWSER_REPLAN_REQUIRED" in messages[1]["content"]


def test_failed_click_is_not_cleared_by_a_later_observe():
    agent = _agent()

    failed_messages = _run(
        agent,
        [_tool_call("click-1", "browser_click", {"index": 342})],
        lambda *_args, **_kwargs: json.dumps(
            {"error": "this._pageTargetIds is not a function"}
        ),
    )

    assert agent._turn_unresolved_browser_action["tool"] == "browser_click"
    assert '"state": "failed"' in failed_messages[0]["content"]

    observed_messages = _run(
        agent,
        [_tool_call("observe-1", "browser_observe", {})],
        lambda *_args, **_kwargs: json.dumps(
            {"url": "https://www.v2ex.com/", "text": "今日热议 TOP 10"}
        ),
    )

    assert agent._turn_unresolved_browser_action["tool"] == "browser_click"
    assert '"state": "unresolved"' in observed_messages[0]["content"]

    _run(
        agent,
        [_tool_call("click-2", "browser_click", {"index": 342})],
        lambda *_args, **_kwargs: json.dumps({"clicked": 342}),
    )
    assert agent._turn_unresolved_browser_action == {}


def test_exact_two_click_batch_dispatches_only_the_first_real_browser_rpc():
    agent = _agent()
    rpc_calls: list[tuple[str, dict]] = []

    class Client:
        def call(self, action, *, workbench_id, params, **_kwargs):
            rpc_calls.append((action, params))
            if action == "click":
                return {
                    "clicked": params["index"],
                    "__fanDecisionToken": {
                        **agent._browser_decision_token,
                        "activeTabId": f"{workbench_id}#t1",
                        "selectorGeneration": 9,
                        "tabListGeneration": 1,
                    },
                }
            if action == "observe":
                return {
                    "text": "[9]<button>New tab result",
                    "url": "https://new.example/",
                    "title": "New tab",
                    "tabs": [],
                    "__fanDecisionToken": {
                        **agent._browser_decision_token,
                        "activeTabId": f"{workbench_id}#t1",
                        "selectorGeneration": 10,
                        "tabListGeneration": 1,
                    },
                }
            raise AssertionError(action)

    def dispatch(name, arguments, *_args, **kwargs):
        assert name == "browser_click"
        return browser_tool._browser_click(arguments, task_id=kwargs.get("task_id") or "session-a")

    with patch("tools.electron_browser_tool._client", Client):
        messages = _run(
            agent,
            [
                _tool_call("click-1", "browser_click", {"index": 137}),
                _tool_call("click-2", "browser_click", {"index": 144}),
            ],
            dispatch,
        )

    assert [action for action, _params in rpc_calls].count("click") == 1
    assert rpc_calls[0][1]["index"] == 137
    assert '"executed": false' in messages[1]["content"]


def test_model_visible_observation_records_its_post_tool_decision_token():
    agent = _agent()
    agent._browser_force_observe = True
    fresh_token = {**agent._browser_decision_token, "selectorGeneration": 9}

    def dispatch(name, _arguments, *_args, **_kwargs):
        assert name == "browser_observe"
        browser_tool._refresh_browser_decision_token(fresh_token)
        browser_tool._refresh_browser_observation_token(fresh_token)
        return json.dumps(
            {
                "dom": "<page_observation>\n[9]<button>Fresh</button>\n</page_observation>"
            }
        )

    messages = _run(agent, [_tool_call("observe-1", "browser_observe", {})], dispatch)

    assert agent._browser_model_visible_observation_token == fresh_token
    assert agent._browser_model_visible_observation_fingerprint == (
        browser_observation_content_fingerprint(messages[0]["content"])
    )
    assert not getattr(agent, "_browser_force_observe", False)


def test_self_healed_click_reuses_its_attached_observation_on_next_model_turn():
    agent = _agent()
    agent._browser_force_observe = True
    fresh_token = {
        **agent._browser_decision_token,
        "activeTabId": "session-a#t1",
        "selectorGeneration": 1,
        "tabListGeneration": 1,
    }

    def dispatch(name, _arguments, *_args, **_kwargs):
        assert name == "browser_click"
        browser_tool._refresh_browser_decision_token(fresh_token)
        browser_tool._refresh_browser_observation_token(fresh_token)
        return json.dumps(
            {
                "effect": "snapshot-refresh",
                "recovery_outcome": "superseded_by_page_transition",
                "result": {
                    "code": "STALE_ELEMENT_REFERENCE",
                    "executed": False,
                    "replan_required": True,
                    "state_changes": ["active-tab"],
                },
                "dom": (
                    "<page_observation>\n"
                    "[9]<button>Fresh page</button>\n"
                    "</page_observation>"
                ),
            }
        )

    messages = _run(agent, [_tool_call("click-1", "browser_click", {"index": 3})], dispatch)

    assert "Fresh page" in messages[0]["content"]
    assert agent._browser_model_visible_observation_token == fresh_token
    assert agent._browser_model_visible_observation_fingerprint == (
        browser_observation_content_fingerprint(messages[0]["content"])
    )
    assert not getattr(agent, "_browser_force_observe", False)


def test_browser_result_without_page_observation_does_not_claim_snapshot_binding():
    agent = _agent()
    prior_visible_token = {**agent._browser_decision_token, "selectorGeneration": 7}
    agent._browser_model_visible_observation_token = prior_visible_token
    newer_runtime_token = {**agent._browser_decision_token, "selectorGeneration": 9}

    def dispatch(name, _arguments, *_args, **_kwargs):
        assert name == "browser_search_page"
        browser_tool._refresh_browser_decision_token(newer_runtime_token)
        return json.dumps({"matches": ["Fan"]})

    _run(
        agent,
        [_tool_call("search-1", "browser_search_page", {"pattern": "Fan"})],
        dispatch,
    )

    assert agent._browser_model_visible_observation_token == prior_visible_token
    assert not getattr(agent, "_browser_force_observe", False)


def test_unsettled_navigation_observation_forces_refresh_before_next_model_request():
    agent = _agent()
    transition_token = {**agent._browser_decision_token, "selectorGeneration": 9}

    def dispatch(name, _arguments, *_args, **_kwargs):
        assert name == "browser_navigate"
        browser_tool._refresh_browser_decision_token(transition_token)
        browser_tool._refresh_browser_observation_token(transition_token)
        return json.dumps(
            {
                "result": {
                    "loadCompleted": False,
                    "documentStable": False,
                    "settled": False,
                },
                "dom": "<page_observation>\n[346]<a>Transition</a>\n</page_observation>",
            }
        )

    _run(
        agent,
        [_tool_call("navigate-1", "browser_navigate", {"url": "https://example.test/"})],
        dispatch,
    )

    assert agent._browser_model_visible_observation_token is None
    assert agent._browser_force_observe is True


def test_collect_resume_invalidates_old_browser_calls_in_same_batch():
    agent = _agent()
    executed: list[str] = []

    def dispatch(name, _arguments, *_args, **_kwargs):
        executed.append(name)
        return json.dumps({"ok": True})

    messages = _run(
        agent,
        [
            _tool_call("collect-1", "collect", {"question": "Passport number?"}),
            _tool_call("type-1", "browser_click", {"index": 12}),
        ],
        dispatch,
    )

    assert executed == []
    assert agent._browser_force_observe is True
    assert agent._browser_decision_token is None
    assert '"replan_required": true' in messages[1]["content"]
    assert "人工输入或审批等待已经结束" in messages[1]["content"]
