# Control And Data Flow

This document models governance-first runtime flow and persistence boundaries.

## Default Session Flow (Extensions Enabled)

```mermaid
sequenceDiagram
  participant U as User
  participant CLI as brewva-cli
  participant COMP as "Provider Compatibility"
  participant RT as BrewvaRuntime
  participant EXT as brewva-gateway/runtime-plugins
  participant TOOLS as brewva-tools
  participant STORE as Event/Ledger/Projection Stores

  U->>CLI: submit turn
  CLI->>EXT: before_agent_start
  EXT->>RT: context.observeUsage + context.buildInjection
  RT->>STORE: read/update working projection state (units + working)
  CLI->>COMP: provider request payload
  COMP->>COMP: resolve capability profile + patch request
  COMP-->>CLI: normalized provider request
  CLI->>COMP: assistant completion
  COMP->>COMP: normalize structured tool call or fail fast
  COMP-->>CLI: admitted completion event
  CLI->>EXT: tool_call
  EXT->>RT: tools.start (policy + budget + compaction gate)
  CLI->>TOOLS: execute
  TOOLS-->>EXT: tool_result
  EXT->>RT: tools.finish + ledger append + event record
  RT->>STORE: event tape + evidence ledger + snapshots
```

## Direct Managed Tools Flow (`--managed-tools direct`)

```mermaid
flowchart TD
  A["create runtime"] --> B["create hosted turn pipeline"]
  B --> C["install hosted provider compatibility"]
  C --> D["host provides managed tools directly"]
  D --> E["before_agent_start: hosted context + tool surface"]
  E --> F["provider request patch + pre-parse normalization"]
  F --> G["tool_call: tool gate + invocation spine"]
  G --> H["tool_result: ledger + event stream + distillation"]
```

## Persistence Flow

```mermaid
flowchart LR
  IN["Prompt / Tool IO / Usage"] --> RT["BrewvaRuntime"]
  RT --> EV["event tape (.orchestrator/events/*.jsonl)"]
  RT --> LD["evidence ledger (.orchestrator/ledger/evidence.jsonl)"]
  RT --> MEM["working projection (.orchestrator/projection/units.jsonl + sessions/sess_<id>/working.md)"]
  RT --> SNAP["rollback snapshots (.orchestrator/snapshots/<session>/*)"]
```

## Hosted Event Surfaces

```mermaid
flowchart LR
  LIVE["Hosted live stream"] --> L1["message_update"]
  LIVE --> L2["tool_execution_update"]
  LIVE --> L3["assistant text/thinking deltas"]

  AUDIT["Durable audit tape"] --> A1["message_end summary"]
  AUDIT --> A2["tool_execution_end summary"]
  AUDIT --> A4["approval + delegation lifecycle"]

  OPS["Durable ops tape (level >= ops)"] --> O1["tool_call_normalized / tool_call_normalization_failed"]
```

Live activity stays channel-oriented and ephemeral. Durable tape keeps replay,
evidence, and recovery semantics.

## Hosted Provider Compatibility Flow

```mermaid
flowchart TD
  A["hosted session bootstrap"] --> B["install provider compatibility layer"]
  B --> C["register session-scoped runtime + registry"]
  C --> D["provider request patching"]
  D --> E["model/provider response"]
  E --> F{"structured tool call admissible?"}
  F -->|yes| G["emit normalized completion into Pi session"]
  F -->|no| H["emit normalization failure error"]
  G --> I["quality-gate tool_call admission"]
```

The compatibility seam sits before runtime authority. It can repair structural
shape, but it cannot grant permission, invent semantic intent, or bypass the
tool gate.

## Working Projection Flow

```mermaid
flowchart TD
  EVT["event append"] --> EX["ProjectionExtractor (deterministic rules)"]
  EX --> U["units.jsonl upsert/resolve"]
  U --> W["session working snapshot refresh"]
  W --> INJ["inject brewva.projection-working"]
```

## Recovery Flow

```mermaid
flowchart TD
  A["startup"] --> B["load event tape"]
  B --> C["TurnReplayEngine (checkpoint + delta)"]
  C --> D["hydrate task/truth/cost/verification/projection state"]
  D --> E["if projection files missing: rebuild projection from tape"]
```

## Rollback Flow

### Patchset-based rollback (`rollback_last_patch` / `--undo`)

```mermaid
flowchart TD
  A["rollback_last_patch / --undo"] --> B["resolve session"]
  B --> C["restore tracked snapshot set"]
  C --> D{"restore ok?"}
  D -->|yes| E["emit rollback + verification_state_reset"]
  D -->|no| F["emit no_patchset or restore_failed"]
```

### Receipt-based mutation rollback (`runtime.tools.rollbackLastMutation(...)`)

```mermaid
flowchart TD
  A["rollbackLastMutation(sessionId)"] --> B["resolve latest rollback candidate"]
  B --> C{"strategy?"}
  C -->|workspace_patchset| D["rollback tracked patch set"]
  C -->|task_state_journal| E["restore prior task state + emit verification_state_reset"]
  C -->|artifact_write / generic_journal| F["return unsupported_rollback"]
  D --> G["emit rollback event trail"]
  E --> G
```
