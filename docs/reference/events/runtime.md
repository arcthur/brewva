# Runtime Event Families

This page covers event families owned by the runtime kernel and its read
models: ledger, projection, proposal admission, governance, context, and
watchdog surfaces.

## Ledger And Projection

Ledger and projection events are the runtime's strongest replay-facing record.
They include tape anchors, checkpoints, task/claim folding inputs, projection
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

## Capability Selection

`tool.capability.selected` is durable evidence on the event tape. It
records the selector trigger, input intent hash, selected capabilities,
filtered candidates, policy decisions, conflicts, registry version, and
carry-forward linkage for tool-only turns.

The receipt explains why external authority was visible. It does not replace
effect governance, proposal admission, or tool-result receipts. Replay and
audit should read capability selection and effect receipts together: one
answers why a capability was exposed, the other answers why an action was
allowed, blocked, or deferred.

## Context And Budget

Context events record numeric compaction status, auto-compaction attempts, workbench
changes, cache observations, and request-shaping decisions. They are used to
inspect why the runtime advised or forced compaction, not to reconstruct hidden
prompt state.

Context compaction events should be read through `runtime.model.materialize(...)`
for provider-ready prompt state and, for repo-owned hosted adapter diagnostics,
through `HostedRuntimeAdapterPort.ops.context.*`:

- compaction advisory and request events explain numeric status transitions
- gate events explain why a tool was blocked or allowed
- workbench and context-composition events explain surfaced working context

## Watchdog And Reliability

Watchdog events such as task-stall adjudication, critical-without-compact, and
integrity checks expose runtime reliability posture. They are operational
evidence. They do not replace task/claim state or verification reports.

## Implementation Anchors

- `packages/brewva-runtime/src/runtime/runtime-api.ts`
- `packages/brewva-runtime/src/runtime/turn/impl.ts`
- `packages/brewva-runtime/src/runtime/kernel/policy/tool-admission-policy.ts`
- `packages/brewva-runtime/src/runtime/model/impl.ts`
- `packages/brewva-gateway/src/hosted/internal/turn-adapter/watchdog/task-progress-watchdog.ts`
