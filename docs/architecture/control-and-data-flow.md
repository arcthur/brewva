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
  GW->>RT: authority.tools.invocation.start
  RT->>STORE: decision + lifecycle evidence
  GW->>TOOL: execute admitted call
  TOOL-->>GW: result
  GW->>RT: authority.tools.invocation.finish + recordResult
  RT->>STORE: tool outcome + receipts
```

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
