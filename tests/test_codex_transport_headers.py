import re

from agent.transports.codex import ResponsesApiTransport


def _build(**params):
    return ResponsesApiTransport().build_kwargs(
        model="gpt-5.4",
        messages=[{"role": "user", "content": "hello"}],
        tools=[],
        instructions="You are Fan.",
        **params,
    )


def _assert_static_cache_key(value: str) -> None:
    assert re.fullmatch(r"pck_[0-9a-f]{24}", value)


def test_codex_backend_routes_with_a_static_content_cache_key():
    kwargs = _build(is_codex_backend=True, session_id="session-123")

    cache_key = kwargs["prompt_cache_key"]
    _assert_static_cache_key(cache_key)
    assert cache_key != "session-123"
    assert kwargs["extra_headers"]["session_id"] == cache_key
    assert kwargs["extra_headers"]["x-client-request-id"] == cache_key


def test_codex_backend_shares_the_static_cache_scope_without_a_session_id():
    kwargs = _build(is_codex_backend=True)

    cache_key = kwargs["prompt_cache_key"]
    _assert_static_cache_key(cache_key)
    assert kwargs["extra_headers"] == {
        "session_id": cache_key,
        "x-client-request-id": cache_key,
    }


def test_codex_backend_preserves_caller_headers_and_owns_routing_headers():
    kwargs = _build(
        is_codex_backend=True,
        session_id="session-123",
        request_overrides={
            "extra_headers": {
                "x-client-request-id": "caller-value",
                "x-test": "kept",
            }
        },
    )

    cache_key = kwargs["prompt_cache_key"]
    _assert_static_cache_key(cache_key)
    assert kwargs["extra_headers"] == {
        "session_id": cache_key,
        "x-client-request-id": cache_key,
        "x-test": "kept",
    }


def test_non_codex_responses_does_not_add_codex_routing_headers():
    kwargs = _build(is_codex_backend=False, session_id="session-123")

    _assert_static_cache_key(kwargs["prompt_cache_key"])
    assert "extra_headers" not in kwargs
