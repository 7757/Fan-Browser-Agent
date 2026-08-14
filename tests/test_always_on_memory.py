import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def test_memory_toggles_are_absent_from_the_config_contract():
    from fan_cli.config import DEFAULT_CONFIG
    from fan_cli.web_server import CONFIG_SCHEMA

    assert "memory_enabled" not in DEFAULT_CONFIG["memory"]
    assert "user_profile_enabled" not in DEFAULT_CONFIG["memory"]
    assert "memory.memory_enabled" not in CONFIG_SCHEMA
    assert "memory.user_profile_enabled" not in CONFIG_SCHEMA


@pytest.mark.parametrize(
    "memory_config",
    [
        """
memory:
  memory_enabled: false
  user_profile_enabled: false
  provider: ""
""",
        """
memory: false
""",
        """
memory:
  nudge_interval: invalid
  provider: ""
""",
    ],
)
def test_legacy_or_malformed_config_cannot_disable_product_memory(
    tmp_path,
    monkeypatch,
    memory_config,
):
    fan_home = tmp_path / "fan-home"
    fan_home.mkdir()
    (fan_home / "config.yaml").write_text(
        memory_config.lstrip(),
        encoding="utf-8",
    )
    monkeypatch.setenv("FAN_HOME", str(fan_home))

    from run_agent import AIAgent

    agent = AIAgent(
        provider="custom",
        base_url="http://127.0.0.1:1/v1",
        api_key="unused",
        model="test-model",
        quiet_mode=True,
        skip_context_files=True,
        enabled_toolsets=[],
    )
    try:
        assert agent._memory_enabled is True
        assert agent._user_profile_enabled is True
        assert agent._memory_store is not None
    finally:
        agent.client.close()


def test_internal_skip_memory_still_disables_built_in_memory(tmp_path, monkeypatch):
    fan_home = tmp_path / "fan-home"
    fan_home.mkdir()
    monkeypatch.setenv("FAN_HOME", str(fan_home))

    from run_agent import AIAgent

    agent = AIAgent(
        provider="custom",
        base_url="http://127.0.0.1:1/v1",
        api_key="unused",
        model="test-model",
        quiet_mode=True,
        skip_context_files=True,
        skip_memory=True,
        enabled_toolsets=[],
    )
    try:
        assert agent._memory_enabled is False
        assert agent._user_profile_enabled is False
        assert agent._memory_store is None
    finally:
        agent.client.close()
