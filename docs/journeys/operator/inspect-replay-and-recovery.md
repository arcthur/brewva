# Journey: Inspect, Replay, And Recovery

## Audience

- operators using `brewva inspect`, `--replay`, and `--undo`
- developers reviewing replay, hydration, WAL, and rollback behavior

## Entry Points

- `brewva inspect`
- `brewva inspect --session <id>`
- `brewva --replay`
- `brewva --undo`
- `/inspect` in channel or interactive control surfaces

## Objective

Describe how a persisted session is reconstructed by inspection surfaces and how
operators move through the `inspect -> replay -> integrity -> undo` path to
diagnose issues, recover state, and validate outcomes.

## In Scope

- inspect report construction
- event tape replay and hydration
- integrity aggregation
- PatchSet rollback and `--undo`
- recovery boundaries when projection, WAL, or nearby artifacts are missing

## Out Of Scope

- skill selection and normal execution happy paths
- effect-commitment approval semantics
- Telegram channel ingress details

## Flow

```mermaid
flowchart TD
  A["Persisted session artifacts"] --> B["brewva inspect or /inspect"]
  B --> C["Replay tape (checkpoint + delta)"]
  C --> D["Hydrate task/truth/cost/verification state"]
  D --> E["Aggregate integrity from tape, WAL, artifacts"]
  E --> F{"Operator action"}
  F -->|Inspect| G["Read hydration, blockers, evidence, diagnostics"]
  F -->|Replay| H["Print structured event timeline"]
  F -->|Undo| I["Resolve latest patchset and restore snapshots"]
  I --> J["Reset verification state and emit rollback trail"]
  G --> K["Re-run or continue session"]
  H --> K
  J --> K
```

## Key Steps

1. `brewva inspect` rebuilds a compact operator view from event tape and nearby
   rebuildable artifacts.
2. On first hydration, the runtime performs checkpoint-plus-delta replay and
   restores task, truth, cost, verification, and related fold slices.
3. `runtime.session.getIntegrity(...)` aggregates tape, turn WAL, and artifact
   persistence issues into one health surface.
4. `--replay` prints a replay-visible timeline from the durable tape rather
   than from the live hosted stream.
5. `--undo` resolves the target session, restores the latest tracked `PatchSet`,
   and resets verification state.
6. Delegated inspect surfaces now reflect the canonical specialist cutover:
   public delegated outcomes are `exploration`, `plan`, `review`, `qa`, or `patch`,
   while kernel `runtime.verification.*` remains a separate replayed authority.

## Execution Semantics

- the durable source of truth is the event tape, checkpoints, receipts, approval
  events, and linked tool outcomes
- turn WAL and snapshots are `durable transient` artifacts used for bounded
  recovery or undo, not historical truth
- projection files are `rebuildable state`; removing them must not change replay
  correctness
- `inspect` layers deterministic directory-scoped analysis on top of replayed
  state, so it serves both as a recovery entrypoint and as a code-review
  entrypoint
- replay preserves historical delegated outcome vocabulary where necessary for
  correctness; new-request contract cleanup does not retroactively rewrite old
  child-run evidence
- hydration and integrity are distinct views:
  - hydration reports whether replay successfully rebuilt session-local state
  - integrity reports unified durability health across tape, WAL, and artifacts

## Failure And Recovery

- damaged event tape rows do not collapse into an "empty but healthy" session;
  hydration degrades and surfaces explicit `event_tape` issues
- WAL integrity failures fail closed so the runtime does not continue from a
  corrupted recovery surface
- missing projection artifacts are rebuilt from durable tape instead of making
  the session unrecoverable
- `--undo` returns explicit `no_patchset` semantics when no tracked `PatchSet`
  exists
- channel helper state and approval-screen cache are not part of recovery
  correctness

## Observability

- primary inspection surfaces:
  - `brewva inspect`
  - `brewva --replay`
  - `brewva --undo`
  - `runtime.session.getIntegrity(...)`
- key report sections:
  - hydration status
  - integrity issues
  - latest verification outcome
  - ledger chain status
  - projection, WAL, and snapshot artifact paths

## Code Pointers

- Inspect / replay / undo CLI: `packages/brewva-cli/src/index.ts`
- Session lifecycle: `packages/brewva-runtime/src/services/session-lifecycle.ts`
- Replay engine: `packages/brewva-runtime/src/tape/replay-engine.ts`
- Patch-set rollback: `packages/brewva-runtime/src/services/file-change.ts`
- Receipt-aware rollback: `packages/brewva-runtime/src/services/mutation-rollback.ts`
- Rollback tool: `packages/brewva-tools/src/rollback-last-patch.ts`

## Related Docs

- Session lifecycle reference: `docs/reference/session-lifecycle.md`
- Control and data flow: `docs/architecture/control-and-data-flow.md`
- Common failures: `docs/troubleshooting/common-failures.md`
- Approval path: `docs/journeys/operator/approval-and-rollback.md`
