# Invariants And Reliability

This page owns Brewva's non-negotiable safety and failure semantics. It is the
place to check whether a proposed change preserves replay, approval, rollback,
recovery, and bounded execution.

## Core Invariants

1. Evidence integrity:
   every persisted tool outcome must produce a ledger entry or explicit
   failure record.
2. Event observability:
   major lifecycle, tool, context, verification, and cost events must remain
   queryable.
3. Recovery consistency:
   runtime recovery state must be derivable from event tape plus bounded WAL or
   rollback material, not opaque snapshots.
4. Exact approval binding:
   approval state is replay-derived, and explicit resume must match request id,
   tool call id, and argument digest.
5. Contract enforcement:
   tools and skills must respect active effect policy, output contracts,
   routing scope, and resource ceilings before completion becomes
   authoritative.
6. Rollback safety:
   rollback restores only tracked mutations for the target session and resets
   stale verification assumptions.
7. Budget boundedness:
   context composition, provider cache behavior, cost reporting, and
   parallelism remain bounded by configured policy.
8. Config immutability:
   `runtime.config` is deep-readonly after construction; routing overrides are
   applied before runtime construction.
9. Projection integrity:
   working projection is rebuildable from tape/workspace state and never
   replaces event tape as truth.
10. Effect authority manifest:
    classifiers and overlays produce facts; the manifest-backed authority
    decision owns allow/block/defer meaning for a tool call.
11. Turn lifecycle monotonicity:
    hosted turn gates move forward only and never rewrite prior event tape.
12. Session lineage and context admission:
    branch topology, context-entry paths, and capability state are replay-derived;
    state-only records do not become model context without explicit admitted
    context entries, lineage summaries, or outcome adoption.
13. Effect infrastructure island:
    scopes, fibers, layers, schedules, streams, queues, and finalizers own
    in-memory infrastructure mechanics only; they never replace event tape,
    WAL, receipts, capability-scoped authority, or the plain TypeScript
    four-port runtime root.

## Failure Semantics

- Missing projection files degrade working views but must not change replay
  truth.
- Missing or stale provider cache may cost tokens, but must not change
  authorization, recovery, or committed tool outcomes.
- Verifier blockers are visible verification debt until resolved; they do not
  silently become task truth.
- Process-local hosted diagnostics may explain a fresh result but are not
  durable recovery truth.
- Deleted durable source-of-truth events change replay correctness and must be
  treated as data loss.
- Effect interruption and scope finalization are cleanup mechanics. Durable
  cancellation, rollback, recovery, and failure evidence must still be recorded
  through runtime events, receipts, WAL, or ledger rows when the boundary
  requires it.
- Promise/Effect boundary crossings are adapter mechanics. Repeated boundary
  crossings inside provider stream core, channel queue core, tool execution
  internals, or runtime package code are reliability bugs, not implementation
  details.

## State Roles

| Surface         | Role                                | Failure posture                           |
| --------------- | ----------------------------------- | ----------------------------------------- |
| Event tape      | durable source of truth             | data loss affects replay correctness      |
| Recovery WAL    | durable transient recovery material | stale entries recover, expire, or compact |
| Evidence ledger | durable evidence                    | row issues degrade audit, not tape replay |
| Projection      | rebuildable state                   | rebuild from tape/workspace               |
| Session wire    | derived live/read model             | rebuild or degrade UI details             |
| Session lineage | rebuildable state                   | rebuild from tape                         |
| Provider cache  | performance cache                   | disable or miss without changing truth    |

## Implementation Anchors

- `packages/brewva-runtime/src/runtime/runtime.ts`
- `packages/brewva-runtime/src/runtime/tape/memory-tape.ts`
- `packages/brewva-runtime/src/runtime/kernel/kernel.ts`
- `packages/brewva-runtime/src/runtime/kernel/policy/tool-decision.ts`
- `packages/brewva-std/src/async.ts`
- `packages/brewva-gateway/src/hosted/internal/turn-adapter/turn-envelope.ts`
- `packages/brewva-gateway/src/channels/effect-serial-queue.ts`
- `packages/brewva-effect/src/index.ts`
- `packages/brewva-effect/src/schedules.ts`
- runtime turn execution: `packages/brewva-runtime/src/runtime/engine/turn.ts`
- `packages/brewva-provider-core/src/stream/run-provider-stream.ts`
- `packages/brewva-tools/src/families/execution/exec-process-registry/service.ts`

## Related Docs

- `docs/architecture/design-axioms.md`
- `docs/architecture/system-architecture.md`
- `docs/reference/events/README.md`
- `docs/reference/runtime.md`
