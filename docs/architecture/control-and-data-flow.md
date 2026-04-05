# Control And Data Flow

This document models governance-first runtime flow and persistence boundaries.

Interpretation rule:

- these diagrams are descriptive snapshots of the current runtime shape
- they do not override architectural invariants or public contracts
- if the implementation changes, this file should be updated rather than used
  to infer new authority
- host-specific branches, deleted paths, or optional integrations may be omitted
  here without changing the authority model

Use this file to understand current wiring. Use `docs/architecture/*.md`,
`docs/reference/*.md`, and runtime code to decide what authority or persistence
semantics are actually allowed.

## Default Session Flow (Runtime Plugins Enabled)

```mermaid
sequenceDiagram
  participant U as User
  participant CLI as brewva-cli
  participant HOST as "Hosted Session"
  participant RT as "Brewva runtime ports"
  participant EXT as brewva-gateway/runtime-plugins
  participant TOOLS as brewva-tools
  participant STORE as Event/Ledger/Projection Stores

  U->>CLI: submit turn
  CLI->>EXT: before_agent_start
  EXT->>RT: inspect task/skills + maintain.context.observeUsage + maintain.context.buildInjection
  RT->>STORE: read/update working projection state + record hosted routing posture receipts
  CLI->>HOST: provider request + assistant completion
  HOST-->>CLI: hosted completion event
  CLI->>EXT: tool_call
  EXT->>RT: authority.tools.start (policy + budget + compaction gate)
  CLI->>TOOLS: execute
  TOOLS-->>EXT: tool_result
  EXT->>RT: authority.tools.finish + authority.tools.recordResult
  RT->>STORE: event tape + evidence ledger + snapshots
```

Hosted wiring narrows a root runtime into hosted, tool, and operator ports plus
repo-owned internal hooks where required. It does not hand a raw implementation
bag to every lifecycle adapter.

Before the provider request, the hosted control plane resolves the current
TaskSpec-first posture. If no skill is active and no TaskSpec exists, the turn
stays on the bootstrap tool surface so the next semantic decision is
`task_set_spec`. If TaskSpec is present and the routed match is strong, the
visible surface may narrow again so the next semantic decision is explicit
`skill_load`. These posture changes are experience-ring shaping plus durable
control-plane receipts; they do not create automatic skill activation.

## Direct Managed Tools Flow (`--managed-tools direct`)

```mermaid
flowchart TD
  A["create runtime"] --> B["create hosted turn pipeline"]
  B --> C["host provides managed tools directly"]
  C --> D["before_agent_start: TaskSpec-first context + tool surface"]
  D --> E["provider request + assistant completion"]
  E --> F["tool_call: quality gate + invocation spine"]
  F --> G["tool_result: ledger + event stream + distillation"]
```

Hosted context ownership is intentionally split:

- lifecycle shell: `packages/brewva-gateway/src/runtime-plugins/context-transform.ts`
- compaction policy: `packages/brewva-gateway/src/runtime-plugins/hosted-compaction-controller.ts`
- before-start injection assembly:
  `packages/brewva-gateway/src/runtime-plugins/hosted-context-injection-pipeline.ts`
- telemetry emission: `packages/brewva-gateway/src/runtime-plugins/hosted-context-telemetry.ts`

## Persistence Flow

```mermaid
flowchart LR
  IN["Prompt / Tool IO / Usage"] --> RT["BrewvaRuntime"]
  RT --> EV["event tape (.orchestrator/events/*.jsonl)"]
  RT --> LD["evidence ledger (.orchestrator/ledger/evidence.jsonl)"]
  RT --> MEM["working projection cache/export (.orchestrator/projection/units.jsonl + sessions/sess_<id>/working.md)"]
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
```

Live activity stays channel-oriented and ephemeral. Durable tape keeps replay,
evidence, and recovery semantics.

## Hosted Admission Flow

```mermaid
flowchart TD
  A["hosted session bootstrap"] --> B["register hosted pipeline + runtime hooks"]
  B --> C["provider request / model response"]
  C --> D{"structured tool call admitted?"}
  D -->|yes| E["quality-gate tool_call admission"]
  D -->|no| F["hosted session error to caller"]
```

The hosted path does not use a separate provider-compatibility seam. Runtime
authority begins at admitted hosted events such as `tool_call`; permission and
governance remain kernel-owned.

## Working Projection Flow

```mermaid
flowchart TD
  EVT["event append"] --> EX["ProjectionExtractor (deterministic rules)"]
  EX --> U["rebuildable projection cache upsert/resolve"]
  U --> W["session working snapshot refresh/export"]
  W --> INJ["inject brewva.projection-working"]
```

## Recovery Flow

```mermaid
flowchart TD
  A["startup"] --> B["load event tape"]
  B --> C["TurnReplayEngine (checkpoint + delta)"]
  C --> D["hydrate task/truth/cost/verification replay state"]
  D --> E["if rebuildable projection files are missing: rebuild from tape"]
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

### Receipt-based mutation rollback (`runtime.authority.tools.rollbackLastMutation(...)`)

```mermaid
flowchart TD
  A["rollbackLastMutation(sessionId)"] --> B["resolve latest rollback candidate"]
  B --> C{"strategy?"}
  C -->|workspace_patchset| D["rollback tracked PatchSet"]
  C -->|none available| E["return no_mutation_receipt"]
  D --> F["emit rollback event trail"]
```
