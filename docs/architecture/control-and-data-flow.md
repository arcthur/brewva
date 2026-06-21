# Control And Data Flow

This is a diagram-only companion for current wiring. It does not define public
methods, event schemas, authority, or persistence semantics. If a diagram
conflicts with `design-axioms`, `invariants-and-reliability`, `system-architecture`,
or reference docs, the narrower contract wins.

## Hosted Tool Turn

```mermaid
sequenceDiagram
  participant U as User
  participant CLI as CLI/TUI
  participant GW as Gateway/Substrate
  participant RT as Runtime Ports
  participant TOOL as Managed Tool
  participant STORE as Event/Ledger/Projection

  U->>CLI: submit turn
  CLI->>GW: hosted prompt
  GW->>RT: inspect + operator context
  GW->>RT: ops.tools.invocation.start
  RT->>RT: kernel.beginToolCall admission decision
  RT->>STORE: tool.proposed + lifecycle evidence
  GW->>TOOL: execute admitted call
  TOOL-->>GW: result
  GW->>RT: ops.tools.invocation.finish + recordResult
  RT->>RT: kernel.commitToolResult
  RT->>STORE: tool.committed or abort receipts
```

## Default Product Loop

```mermaid
flowchart LR
  RECEIVE["receive: request + ingress refs"] --> ORIENT["orient: Work Card + baseline context"]
  ORIENT --> AUTHORIZE["authorize: capabilities + asks + sandbox"]
  AUTHORIZE --> ACT["act: kernel tool transaction"]
  ACT --> VERIFY["verify: advisory evidence or gate policy"]
  VERIFY --> CONTINUE["continue: optional anchor + next steps"]

  ORIENT -. "candidate refs" .-> OPTIONS["attention options"]
  OPTIONS -. "consume or pin" .-> ORIENT
  CONTINUE -. "latest continuation anchor" .-> ORIENT
```

## Shared Inspect Projection

```mermaid
flowchart TD
  TAPE["canonical tape"] --> WC["TaskWorkCardProjection"]
  KERNEL["kernel receipts"] --> WC
  CAP["capability receipts"] --> WC
  WB["workbench + recall provenance"] --> WC
  VERIFY["verification evidence"] --> WC
  ANCHORS["continuation anchors"] --> WC

  WC --> CLI["brewva inspect"]
  WC --> SHELL["/inspect shell overlay"]
  WC --> CHANNEL["channel inspect"]
  WC --> BUNDLE["export bundle + transcript"]
```

## Context Compaction Gate

```mermaid
flowchart LR
  USAGE["usage observations"] --> DERIVE["substrate ContextBudgetState"]
  RECEIPTS["session_compact receipts"] --> DERIVE
  EMA["growth EMA + request estimate"] --> DERIVE
  DERIVE --> STATUS["ContextStatus"]
  DERIVE --> GATE["ContextCompactionGateStatus"]
  GATE --> TOOLS["hosted tool-access filter"]
  GATE --> AUTO["manual / auto / model-downshift policy"]
  TOOLS --> COMPACT["workbench_compact"]
  AUTO --> COMPACT
  COMPACT --> RECEIPTS
```

## Verification Gate Bridge

```mermaid
flowchart LR
  MANIFEST["verification gate manifest"] --> EVAL["evaluateVerificationGateManifest(...)"]
  EVIDENCE["receipt-backed evidence"] --> EVAL
  EVAL --> POLICY["KernelVerificationGatePolicyInput"]
  POLICY --> PROPOSAL["ToolCallProposal.verificationGates"]
  PROPOSAL --> KERNEL["kernel.beginToolCall(...)"]
  KERNEL --> DECISION["allow, defer, or abort receipt"]
```

## Runtime Port Selection

```mermaid
flowchart LR
  CR["createBrewvaRuntime(...)"] --> RT["BrewvaRuntime"]
  RT --> TAPE["tape: committed truth + projections"]
  RT --> KERNEL["kernel: tool decisions + commitments"]
  RT --> MODEL["model: materialized attention"]
  RT --> TURN["turn: provider/tool physics"]
  RT --> GWA["gateway hosted adapter bundle"]
  GWA --> GW["gateway hosted assembly"]
  KERNEL --> MT["managed tools through scoped capabilities"]
  TAPE --> CLI["operator inspection through projections"]
```

## Provider Drift Evidence

```mermaid
flowchart LR
  SSE["Codex SSE transport"] --> NORM["runCodexNormalizer"]
  WS["Codex WebSocket transport"] --> NORM
  NORM --> EVT["normalized provider events"]
  FB["fallback selection / cache break"] --> SINK["lossy evidence sink (non-authoritative)"]
  SINK --> PROJ["buildProviderDriftProjection (explicit-pull, fail-closed)"]
  PROJ --> INSPECT["inspect view"]
```

Transport is orthogonal to normalization: both Codex transports feed one
`runCodexNormalizer`. Drift and cache-break samples are lossy evidence —
non-authoritative, may vanish on restart by design, never replay truth (the tape
remains the replay authority). The `transport_fallback` drift source is typed but
deferred.

## Persistence Roles

```mermaid
flowchart LR
  RT["Runtime authority"] --> EV["event tape"]
  RT --> WAL["Recovery WAL"]
  RT --> LEDGER["evidence ledger"]
  EV --> PROJ["working projection"]
  EV --> WIRE["session wire/read models"]
```

## Session Lineage And Context

```mermaid
flowchart LR
  EV["event tape"] --> LIN["session lineage projection"]
  EV --> CE["context-entry path"]
  LIN --> INS["inspect + CLI/TUI lineage tree"]
  CE --> CTX["model context for selected leaf"]
  LIN --> CTX["admitted summaries + adopted outcomes"]
```

## Hosted Turn Gates

```mermaid
flowchart LR
  A["turn_input_recorded"] --> B["ingress_received"]
  B --> C["admission_resolved"]
  C --> D["effect_authorized"]
  D --> E["execution_recorded"]
  E --> F["recovery_settled"]
  F --> G["terminal_recorded"]
```

## Recovery

```mermaid
flowchart TD
  A["startup"] --> B["load event tape"]
  B --> C["checkpoint + delta replay"]
  C --> D["hydrate task/claim/cost/verification"]
  D --> E{"projection present?"}
  E -->|yes| F["refresh working snapshot"]
  E -->|no| G["rebuild projection from tape"]
```

## Rewind And Rollback

```mermaid
flowchart TD
  A["operator undo/rewind"] --> B["select checkpoint or mutation receipt"]
  B --> C["runtime authority records rewind/rollback"]
  C --> D["verification state reset"]
  D --> E["inspect surfaces show branch/posture"]
```

## Related Docs

- `docs/architecture/system-architecture.md`
- `docs/architecture/invariants-and-reliability.md`
- `docs/reference/events/README.md`
