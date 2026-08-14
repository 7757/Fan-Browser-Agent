import os
import re
import sys
from pathlib import Path

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from fan_cli.auth import AuthError, PROVIDER_REGISTRY
from fan_cli.providers import determine_api_mode
from fan_cli.runtime_provider import _detect_api_mode_for_url, _parse_api_mode
from agent.agent_runtime_helpers import prompt_cache_policy
from agent.file_safety import _fan_home_path, build_write_denied_paths, get_read_block_error
from agent.prompt_caching import apply_cache_control
from tools.environments.local import _FAN_PROVIDER_ENV_BLOCKLIST


def test_product_provider_registry_is_limited_to_fan_and_bailian():
    assert set(PROVIDER_REGISTRY) == {"fan", "alibaba", "alibaba-coding-plan"}


@pytest.mark.parametrize("mode", ["chat_completions", "codex_responses"])
def test_supported_api_modes_round_trip(mode):
    assert _parse_api_mode(mode) == mode


def test_unknown_api_mode_fails_closed():
    with pytest.raises(AuthError) as caught:
        _parse_api_mode("vendor_messages")

    assert caught.value.code == "unsupported_api_mode"


def test_custom_endpoint_stays_openai_compatible_without_url_guessing():
    assert _detect_api_mode_for_url("https://gateway.example/v1") is None
    assert determine_api_mode("custom", "https://gateway.example/v1") == "chat_completions"
    assert determine_api_mode("custom:company", "https://gateway.example/v1") == "chat_completions"


@pytest.mark.parametrize("provider", ["alibaba", "alibaba-coding-plan"])
def test_qwen_cache_markers_are_limited_to_bailian_endpoints(provider):
    agent = type("Agent", (), {"provider": provider, "model": "qwen3-max"})()
    assert prompt_cache_policy(agent) is True
    assert prompt_cache_policy(agent, provider="custom", model="qwen3-max") is False
    assert prompt_cache_policy(agent, provider=provider, model="other-model") is False


def test_bailian_agent_initializes_without_removed_transport_state():
    from run_agent import AIAgent

    agent = AIAgent(
        provider="alibaba-coding-plan",
        base_url="https://coding-intl.dashscope.aliyuncs.com/v1",
        api_key="unused",
        model="qwen3-max",
        quiet_mode=True,
        skip_memory=True,
        enabled_toolsets=[],
    )
    try:
        assert agent.api_mode == "chat_completions"
        assert agent._use_prompt_caching is True
        assert not hasattr(agent, "_anth" + "ropic_client")
    finally:
        agent.client.close()


def test_cache_markers_skip_tool_results_and_do_not_mutate_history():
    original = [
        {"role": "system", "content": "system"},
        {"role": "user", "content": "first"},
        {"role": "assistant", "content": "working"},
        {"role": "assistant", "content": None, "tool_calls": [{"id": "1"}]},
        {"role": "tool", "content": "result", "tool_call_id": "1"},
        {"role": "assistant", "content": "done"},
    ]

    marked = apply_cache_control(original)

    assert original[0]["content"] == "system"
    assert marked[3]["content"] is None
    assert "cache_control" not in marked[3]
    assert marked[4]["content"] == "result"
    assert "cache_control" not in marked[4]
    assert marked[0]["content"][-1]["cache_control"] == {"type": "ephemeral"}
    assert marked[1]["content"][-1]["cache_control"] == {"type": "ephemeral"}
    assert marked[2]["content"][-1]["cache_control"] == {"type": "ephemeral"}
    assert marked[5]["content"][-1]["cache_control"] == {"type": "ephemeral"}


def test_retired_provider_credentials_remain_quarantined():
    company = ("anth" + "ropic").upper()
    model_brand = ("clau" + "de").upper()
    expected = {
        company + "_API_KEY",
        company + "_TOKEN",
        company + "_BASE_URL",
        model_brand + "_CODE_OAUTH_TOKEN",
    }
    assert expected <= _FAN_PROVIDER_ENV_BLOCKLIST

    retired_store = _fan_home_path() / ("." + company.lower() + "_oauth.json")
    assert str(retired_store.resolve()) in build_write_denied_paths(str(Path.home()))
    assert get_read_block_error(str(retired_store)) is not None


def test_removed_provider_transport_and_model_special_cases_do_not_return():
    root = Path(__file__).resolve().parents[1]
    source_roots = [
        root / "agent",
        root / "fan_cli",
        root / "providers",
        root / "tools",
        root / "apps" / "desktop" / "src",
    ]
    files = [root / "run_agent.py", root / "cli.py", root / "utils.py"]
    for source_root in source_roots:
        files.extend(source_root.rglob("*.py"))
        files.extend(source_root.rglob("*.ts"))
        files.extend(source_root.rglob("*.tsx"))

    company = "anth" + "ropic"
    model_brand = "clau" + "de"
    forbidden_literals = (
        company + "_messages",
        "api." + company + ".com",
        "x-" + company,
        "import " + company,
        company + "/" + model_brand,
    )
    model_families = ("op" + "us", "son" + "net", "hai" + "ku")
    forbidden_model = re.compile(
        model_brand + r"-(?:" + "|".join(model_families) + r")",
        re.IGNORECASE,
    )

    # These files only catalogue neutral model metadata for another supported
    # broker. They do not add an SDK, endpoint, auth flow, or transport for the
    # retired provider, so model-name strings inside their static tables are
    # intentionally allowed.
    static_model_metadata = {
        root / "agent" / "reasoning_timeouts.py",
        root / "agent" / "usage_pricing.py",
    }
    violations = []
    for path in files:
        text = path.read_text(encoding="utf-8")
        lowered = text.lower()
        if path not in static_model_metadata and (
            any(marker in lowered for marker in forbidden_literals) or forbidden_model.search(text)
        ):
            violations.append(str(path.relative_to(root)))

    assert violations == []
