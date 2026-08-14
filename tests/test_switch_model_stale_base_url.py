from __future__ import annotations

from types import SimpleNamespace

import pytest

from agent.agent_runtime_helpers import switch_model


def _agent(provider: str = "old", base_url: str = "https://old.example/v1"):
    agent = SimpleNamespace(
        model="old-model",
        provider=provider,
        base_url=base_url,
        api_mode="chat_completions",
        api_key="old-key",
        client=object(),
        _config_context_length=None,
        _client_kwargs={"api_key": "old-key", "base_url": base_url},
        _transport_cache={},
        context_compressor=None,
        _fallback_chain=[],
    )
    agent._create_openai_client = lambda kwargs, **_kw: {"kwargs": kwargs}
    agent._prompt_cache_policy = lambda **_kw: False
    agent._ensure_lmstudio_runtime_loaded = lambda: None
    return agent


def test_provider_change_without_endpoint_fails_and_rolls_back():
    agent = _agent()
    old_client = agent.client

    with pytest.raises(ValueError, match="no base_url resolved"):
        switch_model(
            agent,
            "new-model",
            "new-provider",
            api_key="new-key",
            base_url="",
            api_mode="chat_completions",
        )

    assert (agent.model, agent.provider, agent.base_url, agent.api_key) == (
        "old-model",
        "old",
        "https://old.example/v1",
        "old-key",
    )
    assert agent.client is old_client


def test_same_provider_may_reuse_endpoint_for_credential_refresh():
    agent = _agent(provider="same")
    switch_model(
        agent,
        "new-model",
        "same",
        api_key="new-key",
        base_url="",
        api_mode="chat_completions",
    )

    assert agent.base_url == "https://old.example/v1"
    assert agent._primary_runtime["base_url"] == "https://old.example/v1"


def test_provider_change_with_resolved_endpoint_persists_coherent_pair():
    agent = _agent()
    switch_model(
        agent,
        "new-model",
        "new-provider",
        api_key="new-key",
        base_url="https://new.example/v1",
        api_mode="chat_completions",
    )

    assert (agent.provider, agent.base_url) == (
        "new-provider",
        "https://new.example/v1",
    )
    assert agent._primary_runtime["provider"] == "new-provider"
    assert agent._primary_runtime["base_url"] == "https://new.example/v1"
