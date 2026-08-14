from __future__ import annotations

import re
from pathlib import Path

from tools.electron_browser_tool_catalog import register_electron_browser_tools
from toolsets import TOOLSETS


ROOT = Path(__file__).resolve().parents[1]
REMOVED_BROWSER_TOOLS = frozenset(
    {
        "browser_console",
        "browser_fill",
        "browser_get_images",
        "browser_press",
        "browser_take_screenshot",
        "browser_vision",
    }
)


class _Registry:
    def __init__(self) -> None:
        self.entries: list[dict] = []

    def register(self, **entry) -> None:
        self.entries.append(entry)


class _Handlers(dict):
    def __missing__(self, key):
        def handler(_args, **_kwargs):
            return None

        self[key] = handler
        return handler


def _catalog_entries() -> list[dict]:
    registry = _Registry()
    register_electron_browser_tools(
        registry,
        _Handlers(),
        check_fn=lambda: True,
        check_visual_fn=lambda: True,
    )
    return registry.entries


def test_browser_catalog_toolsets_and_ui_names_stay_aligned() -> None:
    entries = _catalog_entries()
    catalog_names = [entry["name"] for entry in entries]
    assert len(catalog_names) == len(set(catalog_names))

    toolset_names = TOOLSETS["electron_browser"]["tools"]
    assert set(toolset_names) == set(catalog_names)

    ui_source = (
        ROOT
        / "apps/desktop/src/components/assistant-ui/tool-fallback-model.ts"
    ).read_text(encoding="utf-8")
    meta_block = ui_source.split("const TOOL_META:", 1)[1].split("\n}", 1)[0]
    ui_names = set(re.findall(r"^\s{2}(browser_[a-z0-9_]+):", meta_block, re.MULTILINE))
    assert ui_names == set(catalog_names) | set(
        TOOLSETS["browser_program"]["tools"]
    )

    for entry in entries:
        schema = entry["schema"]
        parameters = schema["parameters"]
        assert schema["name"] == entry["name"]
        assert set(parameters.get("required", ())) <= set(parameters["properties"])


def test_browser_navigate_contract_defaults_to_usable_load_mode() -> None:
    navigate = next(
        entry for entry in _catalog_entries() if entry["name"] == "browser_navigate"
    )
    properties = navigate["schema"]["parameters"]["properties"]

    wait_description = properties["wait_until"]["description"]
    assert properties["wait_until"]["enum"] == ["settle", "load", "none"]
    assert properties["wait_until"]["default"] == "load"
    assert "load (default" in wait_description
    assert "without requiring network idle" in wait_description
    assert "NAVIGATION_TIMEOUT" in properties["wait_timeout_ms"]["description"]


def test_browser_text_input_contract_distinguishes_single_and_multi_field_steps() -> None:
    entries = {entry["name"]: entry for entry in _catalog_entries()}
    click_schema = entries["browser_click"]["schema"]
    type_schema = entries["browser_type"]["schema"]
    fill_schema = entries["browser_fill_form"]["schema"]

    type_description = type_schema["description"]
    assert "exactly one indexed field" in type_description
    assert "Never emit multiple calls" in type_description
    assert "same assistant response" in type_description
    assert "browser_fill_form" not in type_description
    assert "collect" not in type_description
    assert "collect" not in type_schema["parameters"]["properties"]["value_ref"]["description"]

    fill_description = fill_schema["description"]
    assert "same latest observation" in fill_description
    assert "two or more fields" in fill_description
    assert "do not split" in fill_description
    assert "browser_type" not in fill_description
    fields = fill_schema["parameters"]["properties"]["fields"]
    assert fields["minItems"] == 1
    assert "two or more" in fields["description"]

    for description in (
        click_schema["description"],
        type_description,
        fill_description,
    ):
        assert "normal stable form" in description
        assert "exactly one indexed" in description
        assert "same assistant response" in description
        assert "already present and enabled" in description
        assert "dynamic" in description
        assert "cascading" in description
        assert "combobox" in description
        assert "autocomplete" in description
        assert "dropdown" in description
        assert "appears, becomes enabled, or changes after input" in description

    assert "do not insert an observation between them" in type_description
    assert "do not insert an observation between them" in fill_description
    assert "wait for a new observation before clicking" in click_schema["description"].lower()
    assert "next assistant turn" not in fill_description


def test_browser_catalog_does_not_add_a_public_form_submit_tool() -> None:
    names = {entry["name"] for entry in _catalog_entries()}
    assert "browser_form_submit" not in names


def test_removed_browser_tool_names_do_not_reenter_active_contracts() -> None:
    active_contract_files = (
        "agent/browser_action_outcome.py",
        "agent/context_compressor.py",
        "agent/display.py",
        "agent/llm_io_log.py",
        "agent/tool_dispatch_helpers.py",
        "agent/tool_guardrails.py",
        "agent/tool_result_classification.py",
        "apps/desktop/src/components/assistant-ui/tool-fallback-model.ts",
        "fan_cli/config.py",
        "fan_cli/tips.py",
        "model_tools.py",
    )

    for relative_path in active_contract_files:
        source = (ROOT / relative_path).read_text(encoding="utf-8")
        for removed_name in REMOVED_BROWSER_TOOLS:
            assert not re.search(rf"\b{re.escape(removed_name)}\b", source), (
                relative_path,
                removed_name,
            )
