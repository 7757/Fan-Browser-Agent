import pytest

from tools.mcp_tool import MCPServerTask, _DEFAULT_TOOL_TIMEOUT


def test_mcp_tool_calls_allow_long_running_servers_by_default():
    server = MCPServerTask("default-timeout")

    assert _DEFAULT_TOOL_TIMEOUT == 300
    assert server.tool_timeout == 300


@pytest.mark.asyncio
async def test_mcp_server_timeout_override_remains_supported(monkeypatch):
    server = MCPServerTask("custom-timeout")

    async def stop_after_connect(_server, _config):
        server._shutdown_event.set()

    monkeypatch.setattr(MCPServerTask, "_run_stdio", stop_after_connect)

    await server.run({"command": "unused", "timeout": 180})

    assert server.tool_timeout == 180
