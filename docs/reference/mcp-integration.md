# Reference: MCP Integration

Brewva integrates MCP client-first. Hosted sessions connect to external MCP
servers, discover tools, and adapt those tools into Brewva hosted tool
definitions.

## Config Surface

MCP is disabled by default:

```json
{
  "integrations": {
    "mcp": {
      "enabled": false,
      "servers": []
    }
  }
}
```

Server entries support `stdio` and `streamable_http`:

```json
{
  "integrations": {
    "mcp": {
      "enabled": true,
      "servers": [
        {
          "id": "repo",
          "enabled": true,
          "transport": "stdio",
          "command": "bunx",
          "args": ["@modelcontextprotocol/server-filesystem", "."],
          "env": {},
          "timeoutMs": 30000,
          "includeToolNames": ["search"],
          "toolPolicies": {
            "search": {
              "actionClass": "workspace_read"
            }
          }
        }
      ]
    }
  }
}
```

## Security Model

External MCP servers are untrusted boundaries. MCP annotations such as
`readOnlyHint` are descriptive only and cannot lower Brewva admission risk.

Default action class:

```text
external_side_effect
```

Lower-risk classes require an explicit Brewva `toolPolicies` override. The
hosted tool surface still enforces runtime-bound capability checks, so a policy
override does not create undeclared runtime authority.

For stdio transports, environment inheritance is allowlist-only. `inheritEnv`
is fixed to `false`; setting it to `true` is invalid. Brewva starts the child
process with only:

- explicit `env` values from the MCP server config
- host environment keys named in `envAllowlist`

The adapter does not spread `process.env` and then remove known secrets.
Blacklist sanitization is not an accepted model for MCP stdio execution.

MCP tools can also be capability-gated by hosted tool surface policy. A
capability selection receipt explains why an external MCP authority was exposed;
tool policy and effect governance still decide each action.

## Hosted Names

MCP tools become hosted tools named:

```text
mcp__{serverId}__{toolName}
```

Names are normalized to provider-safe syntax and bounded to 64 characters.
Duplicate hosted names fail startup or refresh.

## Lifecycle And Receipts

The hosted MCP bundle owns adapter cleanup. Session disposal closes MCP
adapters so stdio subprocesses and HTTP clients do not outlive their hosted
session.

Operational events are recorded for inspect/debug:

- `mcp_server_connected`
- `mcp_server_disconnected`
- `mcp_tool_list_refreshed`
- `mcp_tool_call_failed`

These events are operational receipts only. The runtime event tape remains the
replay authority.
