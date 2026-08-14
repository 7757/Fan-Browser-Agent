from __future__ import annotations

import time
from types import SimpleNamespace

import pytest

from agent import context_compressor as compressor_module
from agent.auxiliary_client import (
    _aux_interrupt_protected,
    aux_interrupt_protection,
)
from agent.context_compressor import (
    SUMMARY_PREFIX,
    ContextCompressor,
    _estimate_msg_budget_tokens,
)
from agent.conversation_compression import compress_context, _ensure_compressed_has_user_turn
from agent.model_metadata import (
    is_output_cap_error,
    parse_available_output_tokens_from_error,
)


def _bare_compressor() -> ContextCompressor:
    compressor = ContextCompressor.__new__(ContextCompressor)
    compressor.model = "qwen-test"
    compressor.provider = "alibaba"
    compressor.base_url = ""
    compressor.api_key = ""
    compressor.api_mode = "chat_completions"
    compressor.summary_model = ""
    compressor.max_summary_tokens = 10_000
    compressor.quiet_mode = True
    compressor.protect_first_n = 3
    compressor.compression_count = 0
    compressor._previous_summary = None
    compressor._summary_failure_cooldown_until = 0.0
    compressor._summary_model_fallen_back = False
    compressor._last_summary_error = None
    compressor._last_summary_auth_failure = False
    compressor._last_summary_network_failure = False
    compressor._last_aux_model_failure_error = None
    compressor._last_aux_model_failure_model = None
    compressor._ineffective_compression_count = 0
    return compressor


@pytest.mark.parametrize(
    ("context_length", "configured", "expected_percent"),
    [
        (128_000, 0.50, 0.75),
        (128_000, 0.85, 0.85),
        (511_999, 0.50, 0.75),
        (512_000, 0.50, 0.50),
        (1_000_000, 0.50, 0.50),
    ],
)
def test_small_context_threshold_floor_is_raise_only(
    context_length: int,
    configured: float,
    expected_percent: float,
):
    effective = ContextCompressor._effective_threshold_percent(
        context_length,
        configured,
    )
    assert effective == expected_percent


def test_minimum_window_threshold_remains_reachable():
    threshold = ContextCompressor._compute_threshold_tokens(64_000, 0.75)
    assert 0 < threshold < 64_000


def test_summary_cooldown_suppresses_automatic_compression():
    compressor = _bare_compressor()
    compressor.threshold_tokens = 100
    compressor._summary_failure_cooldown_until = time.monotonic() + 30

    assert compressor.should_compress(1_000) is False


def test_session_end_clears_transient_state_but_preserves_lineage_count():
    compressor = _bare_compressor()
    compressor.compression_count = 2
    compressor._previous_summary = "old session"
    compressor._last_summary_error = "failure"
    compressor._last_summary_dropped_count = 8
    compressor._last_summary_fallback_used = True
    compressor._last_compress_aborted = True
    compressor._last_summary_auth_failure = True
    compressor._last_summary_network_failure = True
    compressor._last_compression_savings_pct = 1.0
    compressor._context_probed = True
    compressor._context_probe_persistable = True
    compressor.last_real_prompt_tokens = 123
    compressor.last_compression_rough_tokens = 456
    compressor.last_rough_tokens_when_real_prompt_fit = 789
    compressor.awaiting_real_usage_after_compression = True

    compressor.on_session_end("old", [])

    assert compressor.compression_count == 2
    assert compressor._previous_summary is None
    assert compressor._last_summary_error is None
    assert compressor._last_compress_aborted is False
    assert compressor._last_summary_auth_failure is False
    assert compressor._last_summary_network_failure is False
    assert compressor._ineffective_compression_count == 0
    assert compressor.awaiting_real_usage_after_compression is False


def test_protect_first_n_decays_after_first_compaction():
    compressor = _bare_compressor()
    messages = [{"role": "system", "content": "system"}]

    assert compressor._protect_head_size(messages) == 4
    compressor.compression_count = 1
    assert compressor._protect_head_size(messages) == 1


@pytest.mark.parametrize(
    "message",
    [
        {"content": "dict-shaped summary"},
        "string-shaped summary",
        SimpleNamespace(content="object-shaped summary"),
    ],
)
def test_summary_accepts_compatible_message_shapes(monkeypatch, message):
    compressor = _bare_compressor()
    monkeypatch.setattr(
        compressor_module,
        "call_llm",
        lambda **_kwargs: SimpleNamespace(
            choices=[SimpleNamespace(message=message)],
        ),
    )

    summary = compressor._generate_summary(
        [{"role": "user", "content": "summarize this"}],
    )

    assert summary is not None
    assert summary.startswith(SUMMARY_PREFIX)
    assert "summary" in summary


def test_empty_summary_is_a_failure_not_a_prefix_only_handoff(monkeypatch):
    compressor = _bare_compressor()
    monkeypatch.setattr(
        compressor_module,
        "call_llm",
        lambda **_kwargs: SimpleNamespace(
            choices=[SimpleNamespace(message={"content": "   "})],
        ),
    )

    assert compressor._generate_summary(
        [{"role": "user", "content": "do not lose this"}],
    ) is None
    assert "empty content" in compressor._last_summary_error.lower()


def test_reasoning_trace_is_not_serialized_for_summary():
    compressor = _bare_compressor()

    serialized = compressor._serialize_for_summary([
        {
            "role": "assistant",
            "content": "<think>private scratch work</think>Visible conclusion",
        },
    ])

    assert "private scratch work" not in serialized
    assert "Visible conclusion" in serialized


def test_auth_abort_flag_survives_cooldown_reentry(monkeypatch):
    compressor = _bare_compressor()

    class AuthFailure(RuntimeError):
        status_code = 401

    monkeypatch.setattr(
        compressor_module,
        "call_llm",
        lambda **_kwargs: (_ for _ in ()).throw(AuthFailure("unauthorized")),
    )

    assert compressor._generate_summary(
        [{"role": "user", "content": "preserve me"}],
    ) is None
    assert compressor._last_summary_auth_failure is True
    assert compressor._generate_summary(
        [{"role": "user", "content": "preserve me"}],
    ) is None
    assert compressor._last_summary_auth_failure is True


def test_fallback_does_not_relabel_latest_ask_as_pending_three_times():
    compressor = _bare_compressor()
    ask = "PLEASE_KEEP_THIS_UNIQUE_ASK"

    summary = compressor._build_static_fallback_summary([
        {"role": "user", "content": ask},
        {"role": "assistant", "content": "working"},
    ])

    assert summary.count(f"User asked: {ask!r}") <= 1


def test_context_summary_marker_is_not_the_last_real_user_anchor():
    compressor = _bare_compressor()
    messages = [
        {"role": "user", "content": "real request"},
        {"role": "assistant", "content": "answer"},
        {"role": "user", "content": f"{SUMMARY_PREFIX}\nold handoff"},
    ]

    assert compressor._find_last_user_message_idx(messages, 0) == 0


def test_turn_pair_cut_includes_assistant_and_tool_results():
    messages = [
        {"role": "user", "content": "do it"},
        {"role": "assistant", "content": "", "tool_calls": [{"id": "c1"}]},
        {"role": "tool", "tool_call_id": "c1", "content": "done"},
        {"role": "assistant", "content": "later turn"},
    ]

    assert ContextCompressor._find_turn_pair_end(messages, 0) == 3


def test_orphan_tool_calls_are_stripped_instead_of_stubbed():
    compressor = _bare_compressor()
    messages = [
        {
            "role": "assistant",
            "content": "",
            "tool_calls": [{"id": "missing", "function": {"name": "x"}}],
        },
        {"role": "tool", "tool_call_id": "orphan-result", "content": "old"},
    ]

    sanitized = compressor._sanitize_tool_pairs(messages)

    assert len(sanitized) == 1
    assert "tool_calls" not in sanitized[0]
    assert sanitized[0]["content"] == "(tool call removed)"


def test_codex_replay_fields_count_toward_tail_budget():
    visible_only = {"role": "assistant", "content": "ok"}
    with_replay = {
        **visible_only,
        "codex_reasoning_items": [{"encrypted_content": "x" * 4_000}],
    }

    assert _estimate_msg_budget_tokens(with_replay) > _estimate_msg_budget_tokens(
        visible_only,
    )


def test_rotation_guard_restores_user_without_persistence_marker():
    original = [
        {
            "role": "user",
            "content": "latest real request",
            "_db_persisted": {"session_id": "parent"},
        },
        {"role": "assistant", "content": "answer"},
    ]
    compressed = [{"role": "assistant", "content": "handoff"}]

    _ensure_compressed_has_user_turn(original, compressed)

    assert compressed[-1]["role"] == "user"
    assert compressed[-1]["content"] == "latest real request"
    assert "_db_persisted" not in compressed[-1]


@pytest.mark.parametrize("mutate_live_messages", [False, True])
def test_semantic_compression_noop_does_not_rewrite_session(mutate_live_messages):
    original = [
        {"role": "user", "content": "keep this request"},
        {"role": "assistant", "content": "working"},
    ]
    messages = [dict(message) for message in original]

    class NoopCompressor:
        _last_compress_aborted = False
        _last_summary_error = None

        def compress(self, incoming, **_kwargs):
            snapshot = [dict(message) for message in incoming]
            if mutate_live_messages:
                incoming.append({"role": "assistant", "content": "transient mutation"})
            return snapshot

    agent = SimpleNamespace(
        _compression_feasibility_checked=True,
        session_id="semantic-noop",
        model="test-model",
        _session_db=None,
        _memory_manager=None,
        context_compressor=NoopCompressor(),
        _cached_system_prompt="existing prompt",
        _emit_status=lambda _message: None,
        _build_system_prompt=lambda _message: pytest.fail(
            "semantic no-op should reuse the existing system prompt"
        ),
    )

    returned, system_prompt = compress_context(
        agent,
        messages,
        "system",
        approx_tokens=10_000,
    )

    assert returned is messages
    assert messages == original
    assert system_prompt == "existing prompt"


def test_dashscope_output_cap_is_parsed_without_compression():
    error = "Range of max_tokens should be [1, 65536]"

    assert parse_available_output_tokens_from_error(error) == 65_536
    assert is_output_cap_error(error) is True


def test_generic_output_cap_classifier_does_not_mask_input_overflow():
    error = "max_tokens must be lower because the prompt is too long"

    assert is_output_cap_error(error) is False


def test_aux_interrupt_protection_is_reentrant_and_restores_state():
    assert _aux_interrupt_protected() is False
    with aux_interrupt_protection():
        assert _aux_interrupt_protected() is True
        with aux_interrupt_protection():
            assert _aux_interrupt_protected() is True
        assert _aux_interrupt_protected() is True
    assert _aux_interrupt_protected() is False
