from __future__ import annotations

import json
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

from agent.tool_executor import (
    _parse_tool_arguments,
    execute_tool_calls_concurrent,
    execute_tool_calls_sequential,
)


@pytest.mark.parametrize("raw", ["not-json", '"scalar"', "[]", "", '{"x":'])
def test_parser_rejects_every_non_object_shape(raw: str):
    arguments, error = _parse_tool_arguments(raw)
    assert arguments == {}
    assert error is not None
    assert json.loads(error)["error"] == "Invalid tool arguments"


def _tool_call(call_id: str, arguments: str):
    return SimpleNamespace(
        id=call_id,
        function=SimpleNamespace(name="test_tool", arguments=arguments),
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
    agent._current_turn_id = ""
    agent._current_api_request_id = ""
    agent.session_id = ""
    agent._checkpoint_mgr = SimpleNamespace(enabled=False)
    agent._context_engine_tool_names = frozenset()
    agent._memory_manager = None
    agent.quiet_mode = True
    agent.valid_tool_names = {"test_tool"}
    agent.enabled_toolsets = None
    agent.disabled_toolsets = None
    agent._tool_guardrails = SimpleNamespace(
        before_call=lambda *_args, **_kwargs: SimpleNamespace(allows_execution=True)
    )
    agent._tool_worker_threads_lock = __import__("threading").Lock()
    agent._tool_worker_threads = set()
    agent._subdirectory_hints = SimpleNamespace(check_tool_call=lambda *_args: "")
    agent._touch_activity = MagicMock()
    agent._should_emit_quiet_tool_messages = lambda: False
    agent._should_start_quiet_spinner = lambda: False
    agent._apply_pending_steer_to_tool_results = MagicMock()
    agent._tool_result_content_for_active_model = lambda _name, value: value
    agent._append_guardrail_observation = lambda _name, _args, value, **_kwargs: value
    agent._record_file_mutation_result = MagicMock()
    return agent


@pytest.mark.parametrize(
    "executor", [execute_tool_calls_sequential, execute_tool_calls_concurrent]
)
def test_invalid_arguments_never_dispatch_but_valid_sibling_still_runs(executor):
    agent = _agent()
    assistant = SimpleNamespace(
        tool_calls=[
            _tool_call("bad", "not-json"),
            _tool_call("good", '{"value": 7}'),
        ]
    )
    messages: list[dict] = []
    executed: list[tuple[str, dict]] = []

    def dispatch(name, arguments, *_args, **_kwargs):
        executed.append((name, arguments))
        return json.dumps({"ok": arguments["value"]})

    agent._invoke_tool = dispatch
    with (
        patch("run_agent.handle_function_call", side_effect=dispatch),
        patch(
            "agent.tool_executor.maybe_persist_tool_result",
            side_effect=lambda **kwargs: kwargs["content"],
        ),
        patch("agent.tool_executor.get_active_env", return_value=None),
        patch("agent.tool_executor.enforce_turn_budget"),
    ):
        executor(agent, assistant, messages, "task-1")

    assert executed == [("test_tool", {"value": 7})]
    assert [message["tool_call_id"] for message in messages] == ["bad", "good"]
    assert "Invalid tool arguments" in messages[0]["content"]
    assert json.loads(messages[1]["content"]) == {"ok": 7}
