from __future__ import annotations

import pytest

from agent.agent_init import _validate_interactive_tool_contract
from model_tools import get_tool_definitions
from tools.registry import registry


def _tool_names(enabled_toolsets: list[str]) -> set[str]:
    definitions = get_tool_definitions(
        enabled_toolsets=enabled_toolsets,
        quiet_mode=True,
        skip_tool_search_assembly=True,
    )
    return {definition["function"]["name"] for definition in definitions}


def test_collect_is_registered_and_legacy_clarify_schema_is_not() -> None:
    assert registry.get_entry("collect") is not None
    assert registry.get_entry("clarify") is None


def test_desktop_default_toolset_exposes_collect() -> None:
    names = _tool_names(["fan-cli"])

    assert "collect" in names
    assert "clarify" not in names


def test_browser_desktop_toolsets_keep_collect_available() -> None:
    names = _tool_names(["fan-cli", "electron_browser"])

    assert "collect" in names
    assert "clarify" not in names


def test_interactive_browser_contract_rejects_missing_collect() -> None:
    with pytest.raises(RuntimeError, match="collect"):
        _validate_interactive_tool_contract(
            {"browser_observe", "browser_click"},
            collect_callback=lambda _payload: "",
        )


def test_noninteractive_browser_context_may_omit_collect() -> None:
    _validate_interactive_tool_contract(
        {"browser_observe", "browser_click"},
        collect_callback=None,
    )
