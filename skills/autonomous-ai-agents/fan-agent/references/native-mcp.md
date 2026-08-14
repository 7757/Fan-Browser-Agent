# Native MCP Client

Fan Agent can connect to configured MCP servers, discover their tools, and expose those tools to the agent runtime. Treat MCP as an optional extension path, not as part of the browser-agent core. Before giving setup instructions, verify that the current build includes MCP support and that the user actually wants external tools.

## When To Use

Use MCP when the user wants to:

- Connect Fan to an external tool server.
- Add capabilities that are not built into the browser agent.
- Use local stdio-based MCP servers through commands such as `npx` or `uvx`.
- Use remote HTTP or Streamable HTTP MCP servers.
- Make discovered tools available during Fan conversations.

Do not present MCP as required for ordinary browser automation, web research, or built-in tool use.

## Prerequisites

- The `mcp` Python package is required. If it is not installed, MCP discovery is skipped.
- Node.js is required for `npx`-based MCP servers.
- `uv` is required for `uvx`-based MCP servers.
- The MCP server must be trusted, especially when it can read files, call APIs, or access credentials.

Install the MCP SDK when needed:

```bash
pip install mcp
```

or:

```bash
uv pip install mcp
```

## Quick Start

Add an MCP server to `~/.fan/config.yaml`:

```yaml
mcp_servers:
  time:
    command: "uvx"
    args: ["mcp-server-time"]
```

Restart Fan Agent. On startup it will:

1. Read `mcp_servers` from the Fan config.
2. Connect to configured servers.
3. Discover available tools.
4. Register tools with names such as `mcp_time_get_current_time`.

The user can then ask Fan to use the newly available tool naturally.

## Managing Servers

The `fan mcp` CLI has been removed. Manage MCP servers through one of these paths:

- Edit the `mcp_servers` section of `~/.fan/config.yaml` directly. When Fan has file tools, it can read and patch this file itself. Restart or reload the agent afterward.
- Use the desktop app / local dashboard REST API where surfaced: `/api/mcp/servers` supports listing, adding, removing, testing, and enabling/disabling servers.

OAuth-based remote MCP servers support browser authorization with PKCE. Set `auth: oauth`; optional OAuth client fields may be supplied in an `oauth` mapping. Servers authenticated through static `headers` (bearer tokens or API keys) also work normally.

## Configuration Reference

Each entry under `mcp_servers` is a server name mapped to its config. A server config uses either stdio transport or HTTP transport.

### Stdio Transport

```yaml
mcp_servers:
  server_name:
    command: "npx"
    args: ["-y", "package-name"]
    env:
      SOME_API_KEY: "value"
    timeout: 120
    connect_timeout: 60
```

### HTTP Transport

```yaml
mcp_servers:
  server_name:
    url: "https://mcp.example.com/mcp"
    auth: oauth
    timeout: 180
    connect_timeout: 60
```

For a server that uses a static token instead:

```yaml
mcp_servers:
  server_name:
    url: "https://mcp.example.com/mcp"
    headers:
      Authorization: "Bearer sk-..."
    timeout: 180
    connect_timeout: 60
```

### Options

| Option | Type | Default | Description |
|---|---:|---:|---|
| `command` | string | none | Executable for stdio transport. |
| `args` | list | `[]` | Arguments passed to the command. |
| `env` | dict | `{}` | Extra environment variables for the subprocess. |
| `url` | string | none | HTTP MCP server URL. |
| `auth` | string | none | Set to `oauth` for browser-based OAuth authorization with PKCE. |
| `oauth` | dict | `{}` | Optional OAuth client metadata such as a client ID, secret, scopes, or callback port. |
| `headers` | dict | `{}` | HTTP headers sent with each request. |
| `transport` | string | streamable HTTP | Set to `sse` for servers using the SSE protocol. |
| `timeout` | int | `120` | Per-tool-call timeout in seconds. |
| `connect_timeout` | int | `60` | Initial connection and discovery timeout. |
| `supports_parallel_tool_calls` | bool | `false` | Allow tools from this server to run concurrently. |

A server must define either `command` or `url`, not both.

## Tool Naming

MCP tools are registered as:

```text
mcp_{server_name}_{tool_name}
```

Hyphens and dots are replaced with underscores for model compatibility.

Examples:

- Server `filesystem`, tool `read_file` becomes `mcp_filesystem_read_file`.
- Server `time`, tool `get-current-time` becomes `mcp_time_get_current_time`.
- Server `company_api`, tool `fetch.data` becomes `mcp_company_api_fetch_data`.

## Runtime Behavior

- MCP discovery is run during startup paths that initialize configured MCP servers.
- Each server runs through a background MCP event loop.
- Connections are intended to persist for the process lifetime.
- If a connection drops, the runtime attempts reconnection with backoff.
- Adding or removing servers normally requires a reload or restart before tools appear.

## Security

### Environment Variables

For stdio servers, Fan does not pass the full shell environment to MCP subprocesses. Only a safe baseline environment is inherited, plus any variables explicitly listed under `env`.

Use explicit `env` entries for secrets:

```yaml
mcp_servers:
  private_api:
    command: "npx"
    args: ["-y", "private-mcp-server"]
    env:
      PRIVATE_API_TOKEN: "token-value"
```

Only configure secrets for servers the user trusts.

### Credential Redaction

If an MCP tool call fails, credential-like patterns in error messages are redacted before being shown to the model. This includes bearer tokens and generic patterns such as `token=`, `key=`, `API_KEY=`, `password=`, and `secret=`.

### Trust Boundary

MCP servers can expose powerful tools. Before enabling one, understand:

- What files, APIs, or accounts it can access.
- Whether it can write or delete data.
- Whether it receives secrets through `env` or headers.
- Whether tool descriptions could influence the agent's behavior.

## Troubleshooting

### MCP SDK not available

Install or upgrade the SDK:

```bash
pip install --upgrade mcp
```

### No MCP servers configured

Check `~/.fan/config.yaml` for a non-empty `mcp_servers` section.

### Failed to connect to a server

Common causes:

- The command binary is not on `PATH`.
- An `npx` or `uvx` package cannot be installed or found.
- The server took too long to start.
- The HTTP URL is unreachable.
- Required credentials are missing.

### Tools not appearing

Check:

- The server is listed under `mcp_servers`.
- YAML indentation is correct.
- The agent process has restarted or MCP has been reloaded.
- Tool names use the `mcp_{server}_{tool}` prefix.

## Examples

### Time Server

```yaml
mcp_servers:
  time:
    command: "uvx"
    args: ["mcp-server-time"]
```

Registers tools such as `mcp_time_get_current_time`.

### Filesystem Server

```yaml
mcp_servers:
  filesystem:
    command: "npx"
    args: ["-y", "@modelcontextprotocol/server-filesystem", "/home/user/documents"]
    timeout: 30
```

Registers tools such as `mcp_filesystem_read_file`, `mcp_filesystem_write_file`, and `mcp_filesystem_list_directory`.

### Remote HTTP Server

```yaml
mcp_servers:
  company_api:
    url: "https://mcp.example.com/v1/mcp"
    headers:
      Authorization: "Bearer sk-xxxxxxxxxxxxxxxxxxxx"
    timeout: 180
    connect_timeout: 30
```

### Multiple Servers

```yaml
mcp_servers:
  time:
    command: "uvx"
    args: ["mcp-server-time"]

  filesystem:
    command: "npx"
    args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]

  company_api:
    url: "https://mcp.example.com/mcp"
    headers:
      Authorization: "Bearer sk-xxxxxxxxxxxxxxxxxxxx"
    timeout: 300
```

Each server's tools are prefixed with the server name to avoid collisions.

## Sampling

Fan supports MCP server-initiated sampling when the installed MCP SDK exposes that capability. Sampling lets an MCP server request model completions during tool execution.

Sampling is enabled by default when supported. Configure it per server:

```yaml
mcp_servers:
  my_server:
    command: "npx"
    args: ["-y", "my-mcp-server"]
    sampling:
      enabled: true
      model: "model-override-if-needed"
      max_tokens_cap: 4096
      timeout: 30
      max_rpm: 10
      allowed_models: []
      max_tool_rounds: 5
      log_level: "info"
```

Disable sampling for untrusted servers:

```yaml
sampling:
  enabled: false
```

## Notes

- MCP tools are called synchronously from the agent's perspective, while the MCP runtime manages async work internally.
- Tool results are returned as JSON-like results or errors.
- Server connections are shared across conversations in the same process.
- Restart or reload MCP after adding, removing, or changing servers.
