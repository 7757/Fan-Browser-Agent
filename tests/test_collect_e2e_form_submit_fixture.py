from __future__ import annotations

from html.parser import HTMLParser
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
FIXTURE = ROOT / "testbed" / "collect-e2e" / "form-submit.html"
INDEX = ROOT / "testbed" / "collect-e2e" / "index.html"


class _ElementIndex(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.by_id: dict[str, tuple[str, dict[str, str | None]]] = {}
        self.id_counts: dict[str, int] = {}

    def handle_starttag(
        self,
        tag: str,
        attrs: list[tuple[str, str | None]],
    ) -> None:
        attributes = dict(attrs)
        element_id = attributes.get("id")
        if element_id:
            self.id_counts[element_id] = self.id_counts.get(element_id, 0) + 1
            self.by_id[element_id] = (tag, attributes)

def _fixture_source() -> str:
    return FIXTURE.read_text(encoding="utf-8")


def _fixture_parser() -> _ElementIndex:
    parser = _ElementIndex()
    parser.feed(_fixture_source())
    return parser


def _fixture_elements() -> dict[str, tuple[str, dict[str, str | None]]]:
    return _fixture_parser().by_id


def test_collect_e2e_index_links_to_form_submit_fixture() -> None:
    assert 'href="/form-submit.html"' in INDEX.read_text(encoding="utf-8")


def test_form_submit_fixture_has_unique_element_ids() -> None:
    duplicates = {
        element_id: count
        for element_id, count in _fixture_parser().id_counts.items()
        if count > 1
    }
    assert duplicates == {}


def test_stable_fixture_starts_with_an_enabled_native_submit_button() -> None:
    elements = _fixture_elements()
    input_tag, input_attrs = elements["stable-code-input"]
    submit_tag, submit_attrs = elements["stable-submit"]

    assert input_tag == "input"
    assert input_attrs["data-form-behavior"] == "stable"
    assert submit_tag == "button"
    assert submit_attrs["type"] == "submit"
    assert "disabled" not in submit_attrs

    source = _fixture_source()
    stable_input_handler = source.split(
        "stableInput.addEventListener('input'", 1
    )[1].split("stableForm.addEventListener('submit'", 1)[0]
    assert "state.stable.inputEvents += 1" in stable_input_handler
    assert "renderStableMetrics" not in stable_input_handler


def test_dynamic_fixture_replaces_submit_and_exposes_mis_submit_counters() -> None:
    elements = _fixture_elements()
    input_tag, input_attrs = elements["dynamic-city-input"]
    submit_tag, submit_attrs = elements["dynamic-submit"]

    assert input_tag == "input"
    assert input_attrs["data-form-behavior"] == "dynamic"
    assert input_attrs["aria-autocomplete"] == "list"
    assert input_attrs["aria-haspopup"] == "listbox"
    assert input_attrs["aria-controls"] == "dynamic-suggestions"
    assert submit_tag == "button"
    assert submit_attrs["type"] == "submit"
    assert "disabled" not in submit_attrs

    source = _fixture_source()
    dynamic_input_handler = source.split(
        "dynamicInput.addEventListener('input'", 1
    )[1].split("dynamicForm.addEventListener('submit'", 1)[0]
    assert "renderSuggestions(value)" in dynamic_input_handler
    assert "replaceDynamicSubmit('确认（尚未选择建议）'" in dynamic_input_handler
    assert "current.replaceWith(replacement)" in source
    assert "state.dynamic.prematureSubmits += 1" in source
    assert 'id="dynamic-premature-submits"' in source
    assert "__fanFormFixtureState" in source
