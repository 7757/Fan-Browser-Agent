"""Output-cap recovery must not depend on context compression."""

from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from agent.model_metadata import parse_available_output_tokens_from_error
from run_agent import AIAgent


def _response(content: str):
    message = SimpleNamespace(content=content, tool_calls=None)
    choice = SimpleNamespace(message=message, finish_reason="stop")
    return SimpleNamespace(choices=[choice], model="test/model", usage=None)


def _make_agent() -> AIAgent:
    with (
        patch("run_agent.get_tool_definitions", return_value=[]),
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
    agent.api_mode = "chat_completions"
    agent.provider = "openrouter"
    agent.model = "test/model"
    agent.max_tokens = 65_536
    agent.compression_enabled = False
    agent.context_compressor.context_length = 200_000
    agent.context_compressor.should_compress = MagicMock(return_value=False)
    agent.save_trajectories = False
    agent.client = MagicMock()
    return agent


def _api_error(message: str) -> Exception:
    error = Exception(message)
    error.status_code = 400
    error.code = 400
    return error


def _run_with_compression_spy(agent: AIAgent):
    compress = MagicMock()
    with (
        patch.object(agent, "_persist_session"),
        patch.object(agent, "_save_trajectory"),
        patch.object(agent, "_cleanup_task_resources"),
        patch.object(agent, "_flush_messages_to_session_db"),
        patch.object(agent.context_compressor, "update_model"),
        patch.object(agent, "_compress_context", compress),
    ):
        result = agent.run_conversation("hello")
    return result, compress


def test_parseable_output_cap_retries_when_compression_is_disabled():
    agent = _make_agent()
    agent.client.chat.completions.create.side_effect = [
        _api_error(
            "max_tokens: 65536 > context_window: 200000 "
            "- input_tokens: 199000 = available_tokens: 1000"
        ),
        _response("done"),
    ]

    result, compress = _run_with_compression_spy(agent)

    calls = agent.client.chat.completions.create.call_args_list
    assert result["completed"] is True
    assert len(calls) == 2
    assert calls[1].kwargs["max_tokens"] == 936
    assert result.get("compaction_disabled") is None
    assert agent.context_compressor.context_length == 200_000
    compress.assert_not_called()


def test_vllm_output_cap_format_retries_without_compression():
    agent = _make_agent()
    agent.context_compressor.context_length = 131_072
    error_message = (
        "This model's maximum context length is 131072 tokens. "
        "However, you requested 1024 output tokens and your prompt "
        "contains at least 65537 input tokens, for a total of at least "
        "66561 tokens."
    )
    assert parse_available_output_tokens_from_error(error_message) == 65_535
    agent.client.chat.completions.create.side_effect = [
        _api_error(error_message),
        _response("done"),
    ]

    result, compress = _run_with_compression_spy(agent)

    calls = agent.client.chat.completions.create.call_args_list
    assert result["completed"] is True
    assert len(calls) == 2
    assert 1 <= calls[1].kwargs["max_tokens"] < agent.max_tokens
    assert result.get("compaction_disabled") is None
    assert agent.context_compressor.context_length == 131_072
    compress.assert_not_called()


def test_true_input_overflow_still_honors_disabled_compression():
    agent = _make_agent()
    agent.client.chat.completions.create.side_effect = [
        _api_error(
            "This model's maximum context length is 4096 tokens. "
            "Your messages resulted in 5000 input tokens."
        )
    ]

    result, compress = _run_with_compression_spy(agent)

    assert result["completed"] is False
    assert result["compaction_disabled"] is True
    assert len(agent.client.chat.completions.create.call_args_list) == 1
    compress.assert_not_called()
