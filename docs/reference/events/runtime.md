# Runtime Event Families

This page covers event families owned by the runtime kernel and its read
models: ledger, projection, proposal admission, governance, context, and
watchdog surfaces.

## Ledger And Projection

Ledger and projection events are the runtime's strongest replay-facing record.
They include tape anchors, checkpoints, task/truth folding inputs, projection
refresh signals, and evidence ledger compaction records.

Read these events as state-transition evidence, not as user-interface
commands. Projection refresh events are rebuildable signals; the tape and
source-of-truth events remain authoritative.

## Proposal And Governance

Proposal events record commitment requests, decisions, and receipts. Governance
events explain why a tool or runtime action was admitted, deferred, denied, or
flagged for metadata repair.

Important boundary:

- proposal and decision receipt events can carry authority
- governance verification and warning events explain posture
- warning events do not silently create a second admission policy

Effect-commitment approval events link operator decisions to the request id and
digest that resumed the exact effectful action.

## Context And Budget

Context events record compaction pressure, auto-compaction attempts, context
injection, cache observations, and arena enforcement. They are used to inspect
why the runtime narrowed or delayed context, not to reconstruct hidden prompt
state.

Context compaction events should be read with `runtime.inspect.context.*`:

- compaction advisory and request events explain pressure
- gate events explain why a tool was blocked or allowed
- injection events explain accepted or dropped supplemental context

## Watchdog And Reliability

Watchdog events such as task-stall adjudication, critical-without-compact, and
integrity checks expose runtime reliability posture. They are operational
evidence. They do not replace task/truth state or verification reports.

## Implementation Anchors

- `packages/brewva-runtime/src/events/registry.ts`
- `packages/brewva-runtime/src/domain/sessions/event-pipeline.ts`
- `packages/brewva-runtime/src/domain/proposals/proposal-admission.ts`
- `packages/brewva-runtime/src/domain/context/context.ts`
- `packages/brewva-runtime/src/domain/task/task-watchdog.ts`
