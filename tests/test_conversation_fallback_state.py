"""Regression tests for conversation-loop fallback state management."""

from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from agent.conversation_loop import _prepare_tool_turn_fallback_state
from run_agent import AIAgent


def _tool_defs(*names):
    return [
        {
            "type": "function",
            "function": {
                "name": name,
                "description": "test tool",
                "parameters": {"type": "object", "properties": {}},
            },
        }
        for name in names
    ]


def _tool_call(name, call_id):
    return SimpleNamespace(
        id=call_id,
        type="function",
        function=SimpleNamespace(name=name, arguments="{}"),
    )


def _response(*, content, finish_reason, tool_calls=None):
    message = SimpleNamespace(content=content, tool_calls=tool_calls)
    choice = SimpleNamespace(message=message, finish_reason=finish_reason)
    return SimpleNamespace(choices=[choice], model="test/model", usage=None)


def _make_agent(*tool_names):
    with (
        patch("run_agent.get_tool_definitions", return_value=_tool_defs(*tool_names)),
        patch("run_agent.check_toolset_requirements", return_value={}),
        patch("run_agent.OpenAI"),
    ):
        agent = AIAgent(
            api_key="test-key",
            base_url="https://openrouter.ai/api/v1/",
            quiet_mode=True,
            skip_context_files=True,
            skip_memory=True,
        )

    agent._cached_system_prompt = "You are helpful."
    agent._use_prompt_caching = False
    agent.tool_delay = 0
    agent.compression_enabled = False
    agent.save_trajectories = False
    agent.valid_tool_names = set(tool_names)
    agent.client = MagicMock()
    return agent


def test_substantive_tool_turn_clears_fallback_and_unmutes_progress():
    agent = SimpleNamespace(
        _last_content_with_tools="old housekeeping response",
        _last_content_tools_all_housekeeping=True,
        _mute_post_response=True,
    )

    all_housekeeping = _prepare_tool_turn_fallback_state(
        agent,
        [_tool_call("web_search", "search-1")],
    )

    assert all_housekeeping is False
    assert agent._last_content_with_tools is None
    assert agent._last_content_tools_all_housekeeping is False
    assert agent._mute_post_response is False


def test_substantive_tool_only_turn_does_not_reuse_older_fallback():
    agent = _make_agent("todo", "web_search")
    agent.client.chat.completions.create.side_effect = [
        _response(
            content="I'll begin the work.",
            finish_reason="tool_calls",
            tool_calls=[_tool_call("todo", "todo-1")],
        ),
        _response(
            content="",
            finish_reason="tool_calls",
            tool_calls=[_tool_call("web_search", "search-1")],
        ),
        _response(content="", finish_reason="stop"),
        _response(content="Recovered after nudge.", finish_reason="stop"),
    ]

    with (
        patch("run_agent.handle_function_call", return_value="ok"),
        patch.object(agent, "_persist_session"),
        patch.object(agent, "_save_trajectory"),
        patch.object(agent, "_cleanup_task_resources"),
        patch.object(agent, "_flush_messages_to_session_db"),
    ):
        result = agent.run_conversation("do the full task")

    assert result["final_response"] == "Recovered after nudge."
    assert result["api_calls"] == 4
    assert result["turn_exit_reason"].startswith("text_response")


def test_housekeeping_only_turn_still_uses_its_fallback():
    agent = _make_agent("memory")
    agent.client.chat.completions.create.side_effect = [
        _response(
            content="You're welcome!",
            finish_reason="tool_calls",
            tool_calls=[_tool_call("memory", "memory-1")],
        ),
        _response(content="", finish_reason="stop"),
    ]

    with (
        patch("run_agent.handle_function_call", return_value="ok"),
        patch.object(agent, "_persist_session"),
        patch.object(agent, "_save_trajectory"),
        patch.object(agent, "_cleanup_task_resources"),
        patch.object(agent, "_flush_messages_to_session_db"),
    ):
        result = agent.run_conversation("save this")

    assert result["final_response"] == "You're welcome!"
    assert "fallback_prior_turn_content" in result["turn_exit_reason"]
