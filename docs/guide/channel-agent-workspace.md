# Guide: Channel Agent Workspace

`brewva --channel telegram` can run with workspace-first orchestration when
`channels.orchestration.enabled=true`.
The default is now `false`; set it explicitly to enable multi-agent workspace
orchestration. Leaving it `false` routes turns to a single default agent session.
This page focuses on channel-workspace behavior and recovery boundaries, not on
the full command or runtime-plugin contract.

## What It Enables

- Multi-agent registry under `.brewva/agents/<agentId>/`
- Per-agent runtime state isolation (`.brewva/agents/<agentId>/state/*`)
- In-channel command routing (`/agents`, `/cost`, `/questions`, `/answer`,
  `/inspect`, `/insights`, `/update`, `/new-agent`, `/del-agent`, `/focus`,
  `/run`, `/discuss`, `@agent ...`)
- Fan-out and bounded discussion loops
- Optional A2A tools (`agent_send`, `agent_broadcast`, `agent_list`)

## Key Config

```json
{
  "channels": {
    "orchestration": {
      "enabled": true,
      "scopeStrategy": "chat",
      "aclModeWhenOwnersEmpty": "open",
      "owners": { "telegram": ["123456789", "@ops_admin"] },
      "limits": {
        "fanoutMaxAgents": 4,
        "maxDiscussionRounds": 3,
        "a2aMaxDepth": 4,
        "a2aMaxHops": 6,
        "maxLiveRuntimes": 8,
        "idleRuntimeTtlMs": 900000
      }
    }
  }
}
```

## Runtime Isolation Guarantees

Worker runtimes force these paths per agent:

- `ledger.path -> .brewva/agents/<agentId>/state/ledger/evidence.jsonl`
- `projection.dir -> .brewva/agents/<agentId>/state/projection`
- `infrastructure.events.dir -> .brewva/agents/<agentId>/state/events`
- `infrastructure.recoveryWal.dir -> .brewva/agents/<agentId>/state/recovery-wal` (WAL-backed recovery mechanism)
- `schedule.projectionPath -> .brewva/agents/<agentId>/state/schedule/intents.jsonl`
- `schedule.enabled -> false`

This override happens in runtime manager code and cannot be bypassed by agent-local config.

## Recovery and Lifecycle

- Channel workspace agent/focus state persists in `.brewva/channel/agent-registry.json`.
  This is channel orchestration workspace state, not runtime replay truth.
- Telegram inline approval callbacks route by exact `requestId` match against
  live sessions that still expose a replayable effect-commitment request.
  Matching prefers the current scope, then other live scopes; there is no
  fallback that blindly routes approval callbacks to the current focus.
- Telegram screen state is process-local cache only. There is no durable `.brewva/channel/approval-state*` or `.brewva/channel/approval-routing.json` recovery contract.
- Worker runtimes are lazy-created on first routing hit.
- Runtime pool uses `maxLiveRuntimes` + idle TTL eviction.
- `/del-agent` performs soft delete and tears down active sessions for that agent.

## Related Docs

- CLI and channel command surface: `docs/guide/cli.md`,
  `docs/reference/commands.md`
- Hosted and channel lifecycle semantics: `docs/guide/orchestration.md`,
  `docs/reference/session-lifecycle.md`
- Operator channel walkthrough: `docs/journeys/operator/channel-gateway-and-turn-flow.md`
- Runtime plugin wiring: `docs/reference/runtime-plugins.md`
- Workspace artifacts and durability classes: `docs/reference/artifacts-and-paths.md`
