"""Late MCP discovery must update an existing Agent at a turn boundary."""

from __future__ import annotations

from types import SimpleNamespace

from tools import mcp_tool


def _tool(name: str) -> dict:
    return {
        "type": "function",
        "function": {"name": name, "description": "", "parameters": {}},
    }


def test_refresh_agent_mcp_tools_adds_late_registered_tool(monkeypatch):
    original = _tool("read_file")
    late = _tool("mcp_demo_search")
    agent = SimpleNamespace(
        tools=[original],
        valid_tool_names={"read_file"},
        enabled_toolsets=None,
        disabled_toolsets=None,
    )

    import model_tools

    monkeypatch.setattr(
        model_tools,
        "get_tool_definitions",
        lambda **_kwargs: [original, late],
    )

    added = mcp_tool.refresh_agent_mcp_tools(agent)

    assert added == {"mcp_demo_search"}
    assert agent.valid_tool_names == {"read_file", "mcp_demo_search"}
    assert agent.tools == [original, late]


def test_refresh_agent_mcp_tools_does_not_churn_unchanged_snapshot(monkeypatch):
    original_snapshot = [_tool("read_file")]
    agent = SimpleNamespace(
        tools=original_snapshot,
        valid_tool_names={"read_file"},
        enabled_toolsets=None,
        disabled_toolsets=None,
    )

    import model_tools

    monkeypatch.setattr(
        model_tools,
        "get_tool_definitions",
        lambda **_kwargs: [_tool("read_file")],
    )

    assert mcp_tool.refresh_agent_mcp_tools(agent) == set()
    assert agent.tools is original_snapshot


def test_refresh_preserves_post_build_memory_and_context_tools(monkeypatch):
    memory_schema = {
        "name": "memory_external_search",
        "description": "",
        "parameters": {},
    }
    context_schema = {
        "name": "lcm_grep",
        "description": "",
        "parameters": {},
    }
    agent = SimpleNamespace(
        tools=[
            _tool("read_file"),
            {"type": "function", "function": memory_schema},
            {"type": "function", "function": context_schema},
        ],
        valid_tool_names={"read_file", "memory_external_search", "lcm_grep"},
        enabled_toolsets=None,
        disabled_toolsets=None,
        _memory_manager=SimpleNamespace(
            get_all_tool_schemas=lambda: [memory_schema]
        ),
        context_compressor=SimpleNamespace(
            get_tool_schemas=lambda: [context_schema]
        ),
        _context_engine_tool_names={"lcm_grep"},
    )

    import model_tools

    monkeypatch.setattr(
        model_tools,
        "get_tool_definitions",
        lambda **_kwargs: [_tool("read_file"), _tool("mcp_demo_search")],
    )
    monkeypatch.setattr(
        "agent.memory_manager.memory_provider_tools_enabled",
        lambda _enabled: True,
    )

    mcp_tool.refresh_agent_mcp_tools(agent)

    assert agent.valid_tool_names == {
        "read_file",
        "mcp_demo_search",
        "memory_external_search",
        "lcm_grep",
    }
    assert agent._context_engine_tool_names == {"lcm_grep"}
