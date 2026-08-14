"""Zero-event response streams should retry without duplicating partial text."""

from types import SimpleNamespace

import pytest

from agent import chat_completion_helpers
from agent.errors import EmptyStreamError
from fan_constants import PARTIAL_STREAM_STUB_ID


def _chunk(*, content=None, finish_reason=None):
    delta = SimpleNamespace(
        content=content,
        reasoning_content=None,
        reasoning=None,
        tool_calls=None,
    )
    return SimpleNamespace(
        choices=[SimpleNamespace(delta=delta, finish_reason=finish_reason)],
        model="empty-stream-model",
        usage=None,
    )


class _FakeStream:
    response = None

    def __init__(self, chunks):
        self._chunks = chunks

    def __iter__(self):
        return iter(self._chunks)


class _SequencedStreamAgent:
    api_mode = "chat_completions"
    provider = "test-provider"
    model = "empty-stream-model"
    base_url = "https://provider.example.test/v1"
    stream_delta_callback = None
    log_prefix = ""
    _interrupt_requested = False
    _current_streamed_assistant_text = ""

    def __init__(self, attempts):
        self._attempts = list(attempts)
        self.create_calls = 0
        self.streamed = []
        self.statuses = []
        self.stream_drops = []
        self.exhausted_logs = []

    def _create_request_openai_client(self, **_kwargs):
        chunks = self._attempts[self.create_calls]
        self.create_calls += 1
        stream = _FakeStream(chunks)
        completions = SimpleNamespace(create=lambda **_call_kwargs: stream)
        return SimpleNamespace(chat=SimpleNamespace(completions=completions))

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

    def _fire_reasoning_delta(self, _text):
        return None

    def _fire_tool_gen_started(self, _name):
        return None

    def _replace_primary_openai_client(self, **_kwargs):
        return None

    def _buffer_status(self, message):
        self.statuses.append(message)

    def _emit_stream_drop(self, **kwargs):
        self.stream_drops.append(kwargs)

    def _log_stream_retry(self, **kwargs):
        self.exhausted_logs.append(kwargs)

    def _safe_print(self, _message):
        return None


def _complete(monkeypatch, agent, retries):
    monkeypatch.setenv("FAN_STREAM_RETRIES", str(retries))
    monkeypatch.setattr(
        chat_completion_helpers,
        "get_provider_request_timeout",
        lambda *_args: None,
    )
    monkeypatch.setattr(
        chat_completion_helpers,
        "get_provider_stale_timeout",
        lambda *_args: None,
    )
    return chat_completion_helpers.interruptible_streaming_api_call(
        agent,
        {
            "model": "empty-stream-model",
            "messages": [{"role": "user", "content": "test"}],
        },
    )


def test_empty_stream_retries_and_returns_next_complete_response(monkeypatch):
    agent = _SequencedStreamAgent(
        [
            [],
            [_chunk(content="recovered", finish_reason="stop")],
        ]
    )

    response = _complete(monkeypatch, agent, retries=1)

    assert response.choices[0].message.content == "recovered"
    assert response.choices[0].finish_reason == "stop"
    assert agent.create_calls == 2
    assert len(agent.stream_drops) == 1


def test_exhausted_empty_streams_report_provider_empty_response(monkeypatch):
    agent = _SequencedStreamAgent([[], []])

    with pytest.raises(EmptyStreamError):
        _complete(monkeypatch, agent, retries=1)

    assert agent.create_calls == 2
    assert len(agent.exhausted_logs) == 1
    assert any("empty response stream" in status for status in agent.statuses)
    assert all("Connection to provider failed" not in status for status in agent.statuses)


def test_partial_text_stream_is_not_retried(monkeypatch):
    agent = _SequencedStreamAgent(
        [
            [_chunk(content="partial text")],
            [_chunk(content="must not run", finish_reason="stop")],
        ]
    )

    response = _complete(monkeypatch, agent, retries=1)

    assert response.id == PARTIAL_STREAM_STUB_ID
    assert response.choices[0].message.content == "partial text"
    assert agent.create_calls == 1
