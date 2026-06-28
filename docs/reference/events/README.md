# Reference: Runtime Events

Canonical tape events are the four-port runtime truth record. They cover turn
boundaries, assistant and reasoning commits, tool transactions, checkpoints,
anchors, including continuation anchors, approvals, cost observations, runtime
suspension, and versioned custom payloads. There is no second runtime event
plane; operational adapter evidence is either a canonical event payload or
rebuildable local state.

Implementation anchors:

- `packages/brewva-runtime/src/runtime/runtime-api.ts`
- `packages/brewva-runtime/src/runtime/tape/impl.ts`
- `packages/brewva-runtime/src/runtime/turn/impl.ts`

## Reading Path

- Runtime ledger, projection, proposal, governance, context, and watchdog events:
  `docs/reference/events/runtime.md`
- Session, turn, hosted lifecycle, session wire, and recovery events:
  `docs/reference/events/session.md`
- Tool execution, verification, mutation, and rollback events:
  `docs/reference/events/tools.md`
- Skill catalog, recall, workbench memory, semantic extraction, and
  iteration-fact events: `docs/reference/events/skills-and-memory.md`
- Harness advisory manifest events and trace-driven projections:
  `docs/reference/events/harness.md`
- Schedule, subagent, worker, and workflow-derived events:
  `docs/reference/events/workers.md`

## Event Envelope

Every runtime event follows the same stored envelope:

- `id`
- `sessionId`
- `type`
- `timestamp`
- `turnId?`
- `attemptId?`
- `payload?`

Payload shape is owned by the event family, but envelope ordering and query
semantics are uniform across the event store.

## Query Contract

New runtime-facing code reads canonical truth through `runtime.tape.list(...)`,
`runtime.tape.project(...)`, and `runtime.tape.replayBaseline(...)`. Repo-owned
hosted adapter code that consumes derived operational evidence uses
`HostedRuntimeAdapterPort.ops.events.records.query(...)`,
`HostedRuntimeAdapterPort.ops.events.records.queryStructured(...)`, and
`HostedRuntimeAdapterPort.ops.events.records.list(...)` with the same query
fields:

- `type`
- `after`
- `before`
- `last`
- `offset`
- `limit`

Result order is tape order from oldest to newest. Query results are read views;
they do not create authority or mutate recovery truth.

Interactive cockpit projection reads event and session-wire evidence through
these read paths and exposes bounded archive refs back to the operator. It does
not write a cockpit event family, duplicate raw tape payloads, or create a
second ordering authority.

The CLI live transcript follows the same single-ordering rule. Custom
display messages (skill SkillCards) are carried as a `custom.message`
`SessionWireFrame` emitted at the gateway turn origin, joining the existing
`turn.input` / `assistant.delta` / `tool.*` frames on one ordered stream. The
frame is display-only — it carries no provider-context payload, keeps custom
`excludeFromContext`, and does not replace the durable `custom_message` entry or
its seed-rebuild authority. A frame whose turn id cannot be resolved fails closed
and is omitted from the ordered view, never hoisted to an arbitrary position.

## Authority Classes

Canonical event authority is expressed by the canonical type and, for `custom`,
by the custom envelope:

- Commitment-bearing facts must use one of the canonical event types.
- `custom` may carry `authority: "none" | "advisory"` only; it cannot create a
  commitment or replay authority.
- Projections may opt into a specific custom `namespace/kind/version`, but only
  for advisory or rebuildable views.

The broader artifact taxonomy still uses durable transient, rebuildable state,
and cache, but those terms no longer imply a global registered event catalog.

## Effect Runtime Boundary

Effect fibers, scopes, spans, and log annotations are in-memory execution
mechanics. They are not durable runtime events and are not replay truth.

When an Effect-native path crosses a durable boundary, it must still write the
same event, receipt, WAL record, ledger row, or projection update that the
runtime contract requires. Scope finalizers may clean up resources, but they do
not substitute for replay-visible cancellation, rollback, or recovery evidence.

## Tool Outcome Receipts

`tool.committed.payload.result.outcome` is the canonical tool-result truth. The
allowed outcome kinds are `ok`, `err`, and `inconclusive`; only `err` maps to
external binary `isError: true`. Legacy `result.ok` and adapter-only
`result.isError` or `result.details` are invalid inside canonical tape.

Outcome schema evolution is versioned by `result.metadata.outcomeVersion`.
Unsupported versions fail closed during live commit and persisted tape replay.
The supported version list is owned by `@brewva/brewva-std/tool-outcome-version`
so runtime validation and tool authoring use the same version vocabulary without
adding a runtime-to-substrate dependency.

`step_projection` is a rebuildable read model over `tool.proposed`,
`tool.committed`, and `tool.aborted`. It exposes authority-derived effects and
recovery policy beside the realized outcome kind, but it does not create a new
event family or a second persistence authority.

## Canonical Surface

The canonical event vocabulary lives in
`packages/brewva-runtime/src/runtime/runtime-api.ts`. There is no global event
registry. Package-owned adapter events live in their owning package and must
enter runtime truth only through canonical tape events or rebuildable adapter
views.

Typed event descriptors remain the schema seam for domain-owned typed event
families. The descriptor entry owns payload reading and append-time validation,
so a malformed typed payload is rejected before it can enter the derived record
view. Payload shape changes require a new event version or an explicit replay
migration fold.

Use the generated index below for exact canonical event names. Use the family
pages for advisory event semantics, payload interpretation, and where a family
affects replay or inspection.

## Generated Event Catalog

<!-- generated:event-catalog start -->

> Generated by `bun run docs:inventory`. Do not edit this block by hand.

Canonical event type count: 15.

- `turn.started`
- `turn.ended`
- `msg.committed`
- `reason.committed`
- `tool.proposed`
- `tool.started`
- `tool.committed`
- `tool.aborted`
- `checkpoint.committed`
- `anchor.committed`
- `approval.requested`
- `approval.decided`
- `cost.observed`
- `runtime.suspended`
- `custom`
<!-- generated:event-catalog end -->

## Non-Event Runtime State

Not every diagnostic deserves a durable event. Envelope diagnostics stay
process-local. No separate durable envelope-diagnostics event is part of the
contract; recovery exposes bounded, replay-relevant state through session and
recovery events instead.

## Maintenance

Before deleting or renaming a documented event, verify it against the whole
codebase, not just the constant table: some events are emitted as bare string
literals (with no `*_EVENT_TYPE` constant to grep) and carry a
dotted-versus-underscored split between the runtime kind and the canonical form.
See `docs/solutions/docs/stale-claim-verification-in-doc-audits.md` for the
precedent behind this rule.
