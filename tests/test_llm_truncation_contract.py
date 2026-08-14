from __future__ import annotations

from types import SimpleNamespace

import pytest

from agent import chat_completion_helpers as completion_helpers
from agent.conversation_loop import (
    MAX_TRUNCATION_RECOVERY_RETRIES,
    _claim_truncation_retry,
    _get_continuation_prompt,
)
from fan_constants import PARTIAL_STREAM_STUB_ID


def _chunk(*, content=None, reasoning=None, tool_calls=None, finish_reason=None):
    delta = SimpleNamespace(
        content=content,
        reasoning_content=reasoning,
        reasoning=None,
        tool_calls=tool_calls,
    )
    return SimpleNamespace(
        choices=[SimpleNamespace(delta=delta, finish_reason=finish_reason)],
        model="contract-model",
        usage=None,
    )


def _tool_delta(*, arguments: str, name: str = "write_file", call_id: str = "call-1"):
    return SimpleNamespace(
        index=0,
        id=call_id,
        function=SimpleNamespace(name=name, arguments=arguments),
        extra_content=None,
    )


class _FakeStream:
    response = None

    def __init__(self, chunks):
        self._chunks = chunks

    def __iter__(self):
        return iter(self._chunks)


class _FakeAgent:
    api_mode = "chat_completions"
    provider = "contract-provider"
    model = "contract-model"
    base_url = "https://provider.example.test/v1"
    stream_delta_callback = None
    log_prefix = ""
    _interrupt_requested = False
    _current_streamed_assistant_text = ""

    def __init__(self, chunks):
        stream = _FakeStream(chunks)
        completions = SimpleNamespace(create=lambda **_kwargs: stream)
        self._client = SimpleNamespace(chat=SimpleNamespace(completions=completions))
        self.streamed = []
        self.reasoning = []
        self.started_tools = []

    def _create_request_openai_client(self, **_kwargs):
        return self._client

    def _close_request_openai_client(self, _client, **_kwargs):
        return None

    def _abort_request_openai_client(self, _client, **_kwargs):
        return None

    def _capture_rate_limits(self, _response):
        return None

    def _check_openrouter_cache_status(self, _response):
        return None

    def _stream_diag_init(self):
        return {}

    def _stream_diag_capture_response(self, _diag, _response):
        return None

    def _touch_activity(self, _message):
        return None

    def _fire_stream_delta(self, text):
        self.streamed.append(text)
        self._current_streamed_assistant_text += text

    def _record_streamed_assistant_text(self, _text):
        return None

    def _fire_reasoning_delta(self, text):
        self.reasoning.append(text)

    def _fire_tool_gen_started(self, name):
        self.started_tools.append(name)

    def _is_provider_stream_parse_error(self, _error):
        return False

    def _replace_primary_openai_client(self, **_kwargs):
        return None

    def _buffer_status(self, _message):
        return None

    def _emit_stream_drop(self, **_kwargs):
        return None

    def _log_stream_retry(self, **_kwargs):
        return None

    def _safe_print(self, _message):
        return None


def _complete(monkeypatch, chunks):
    monkeypatch.setenv("FAN_STREAM_RETRIES", "0")
    monkeypatch.setattr(completion_helpers, "get_provider_request_timeout", lambda *_args: None)
    monkeypatch.setattr(completion_helpers, "get_provider_stale_timeout", lambda *_args: None)
    return completion_helpers.interruptible_streaming_api_call(
        _FakeAgent(chunks),
        {"model": "contract-model", "messages": [{"role": "user", "content": "test"}]},
    )


def test_truncation_recovery_budget_allows_exactly_three_follow_up_requests():
    retry = 0
    observed = []
    while (retry := _claim_truncation_retry(retry)) is not None:
        observed.append(retry)

    assert MAX_TRUNCATION_RECOVERY_RETRIES == 3
    assert observed == [1, 2, 3]


def test_continuation_prompts_distinguish_output_cap_network_drop_and_dropped_tool():
    assert "output length limit" in _get_continuation_prompt(False)
    assert "network error mid-stream" in _get_continuation_prompt(True)
    dropped = _get_continuation_prompt(True, ["write_file"])
    assert "write_file" in dropped
    assert "multiple smaller tool calls" in dropped


def test_stream_preserves_normal_stop_and_valid_tool_arguments(monkeypatch):
    response = _complete(
        monkeypatch,
        [
            _chunk(tool_calls=[_tool_delta(arguments='{"path":"a')]),
            _chunk(tool_calls=[_tool_delta(arguments='.txt"}', name="", call_id="")], finish_reason="stop"),
        ],
    )

    choice = response.choices[0]
    assert choice.finish_reason == "stop"
    assert choice.message.tool_calls[0].function.name == "write_file"
    assert choice.message.tool_calls[0].function.arguments == '{"path":"a.txt"}'


def test_output_cap_and_reasoning_only_completion_stay_classified_as_length(monkeypatch):
    text_response = _complete(monkeypatch, [_chunk(content="partial", finish_reason="length")])
    reasoning_response = _complete(monkeypatch, [_chunk(reasoning="hidden work", finish_reason="length")])

    assert text_response.choices[0].finish_reason == "length"
    assert text_response.choices[0].message.content == "partial"
    assert reasoning_response.choices[0].finish_reason == "length"
    assert reasoning_response.choices[0].message.content is None
    assert reasoning_response.choices[0].message.reasoning_content == "hidden work"


def test_truncated_tool_arguments_with_length_are_never_classified_as_complete(monkeypatch):
    response = _complete(
        monkeypatch,
        [_chunk(tool_calls=[_tool_delta(arguments='{"path":"unfinished')], finish_reason="length")],
    )

    assert response.choices[0].finish_reason == "length"
    assert response.choices[0].message.tool_calls


def test_clean_stream_drop_mid_tool_call_returns_non_executable_partial_stub(monkeypatch):
    response = _complete(
        monkeypatch,
        [_chunk(tool_calls=[_tool_delta(arguments='{"path":"unfinished')])],
    )

    assert response.id == PARTIAL_STREAM_STUB_ID
    assert response.choices[0].finish_reason == "length"
    assert response.choices[0].message.tool_calls is None
    assert response._dropped_tool_names == ["write_file"]


def test_clean_text_only_stream_drop_requests_continuation(monkeypatch):
    response = _complete(
        monkeypatch,
        [
            _chunk(content="Let me compare the "),
            _chunk(content="vision configs:"),
        ],
    )

    assert response.id == PARTIAL_STREAM_STUB_ID
    assert response.choices[0].finish_reason == "length"
    assert response.choices[0].message.content == "Let me compare the vision configs:"
    assert response.choices[0].message.tool_calls is None
    assert getattr(response, "_dropped_tool_names", None) is None


def test_empty_stream_without_finish_reason_is_an_error(monkeypatch):
    with pytest.raises(RuntimeError, match="empty stream with no finish_reason"):
        _complete(monkeypatch, [])
