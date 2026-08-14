from __future__ import annotations

import json

import pytest

from tools.registry import ToolRegistry


def _schema(name: str) -> dict:
    return {
        "name": name,
        "description": name,
        "parameters": {"type": "object", "properties": {}},
    }


@pytest.mark.parametrize("invalid", [{"ok": True}, b"bytes", None, 42])
def test_unsupported_handler_results_become_structured_text_errors(invalid):
    registry = ToolRegistry()
    registry.register(
        name="bad_result",
        toolset="test",
        schema=_schema("bad_result"),
        handler=lambda _args, _value=invalid, **_kwargs: _value,
    )

    raw = registry.dispatch("bad_result", {})
    assert isinstance(raw, str)
    result = json.loads(raw)
    assert result["error_type"] == "tool_result_contract"
    assert result["result_type"] == type(invalid).__name__


def test_supported_multimodal_envelope_keeps_identity():
    registry = ToolRegistry()
    value = {
        "_multimodal": True,
        "content": [{"type": "text", "text": "captured"}],
        "text_summary": "captured",
    }
    registry.register(
        name="capture",
        toolset="test",
        schema=_schema("capture"),
        handler=lambda _args, **_kwargs: value,
    )

    assert registry.dispatch("capture", {}) is value
