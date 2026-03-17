# Invariants And Reliability

This document captures runtime invariants that must remain true for safety, recoverability, and observability.

## Invariant Set

## 1) Evidence Integrity Invariant

- Every persisted tool outcome must produce a ledger entry or an explicit failure record.
- Ledger chain verification must remain valid for each session.

Relevant implementation:

- `packages/brewva-runtime/src/runtime.ts`
- `packages/brewva-runtime/src/ledger/evidence-ledger.ts`

## 2) Event Observability Invariant

- Major lifecycle events (session, turn, tool, context, verification, cost) must be queryable via event store.
- Replay output must be derivable from persisted events only.

Relevant implementation:

- `packages/brewva-runtime/src/events/store.ts`
- `packages/brewva-runtime/src/runtime.ts`
- `packages/brewva-cli/src/index.ts`

## 3) Recovery Consistency Invariant

- Runtime recovery state must be derivable from persisted event tape only
  (`checkpoint + delta` replay for task/truth/cost/evidence/projection, plus
  event-fold hydration for runtime session counters/budgets/compaction state).
- Process restart must not require opaque runtime snapshot blobs.

Relevant implementation:

- `packages/brewva-runtime/src/tape/replay-engine.ts`
- `packages/brewva-runtime/src/runtime.ts`

## 4) Commitment Replay And Exact-Binding Invariant

- `effect_commitment` approval state must remain replay-derived from tape, not
  from process-local approval memory.
- accepted commitment requests are consumed only after a durable linked
  `tool_result_recorded` outcome is observed.
- explicit resume must match the approved `requestId`, original `toolCallId`,
  and canonical argument identity (`argsDigest`).

Relevant implementation:

- `packages/brewva-runtime/src/services/tool-gate.ts`
- `packages/brewva-runtime/src/services/effect-commitment-desk.ts`
- `packages/brewva-runtime/src/services/ledger.ts`

## 5) Contract Enforcement Invariant

- Tool execution must respect active effect policy and effective resource ceilings before execution.
- Skill completion must enforce required outputs and verification checks.

Relevant implementation:

- `packages/brewva-runtime/src/security/tool-policy.ts`
- `packages/brewva-runtime/src/runtime.ts`
- `packages/brewva-tools/src/skill-complete.ts`

## 6) Rollback Safety Invariant

- Rollback must restore only tracked mutations for the target session.
- After successful rollback, verification state must be reset to avoid stale pass assumptions.

Relevant implementation:

- `packages/brewva-runtime/src/state/file-change-tracker.ts`
- `packages/brewva-runtime/src/services/mutation-rollback.ts`
- `packages/brewva-runtime/src/services/reversible-mutation.ts`
- `packages/brewva-runtime/src/runtime.ts`

## 7) Budget Boundedness Invariant

- Context injection must remain bounded by context budget policy.
- Cost summary and budget alerts must reflect session-level usage.

Relevant implementation:

- `packages/brewva-runtime/src/context/budget.ts`
- `packages/brewva-runtime/src/cost/tracker.ts`
- `packages/brewva-runtime/src/runtime.ts`

## 8) Config Immutability Invariant

- `runtime.config` must be deep-readonly after construction.
- constructor-time overrides such as `routingScopes` must be applied before the
  runtime is assembled instead of by post-construction mutation.

Relevant implementation:

- `packages/brewva-runtime/src/runtime.ts`
- `packages/brewva-gateway/src/host/create-hosted-session.ts`

## 9) Profile Transparency Invariant

- Extension-enabled and `--no-addons` profiles must be behaviorally explicit:
  extension presentation hooks may differ, but core safety/evidence invariants
  must remain equivalent.
- When extensions are disabled, runtime core chain still enforces effect policy,
  critical compaction gate, tool-call accounting, patch tracking, and
  tool-result ledger persistence.
- Core lifecycle and assistant-usage telemetry must still be persisted.

Relevant implementation:

- `packages/brewva-gateway/src/host/create-hosted-session.ts`
- `packages/brewva-gateway/src/runtime-plugins/index.ts`

## 10) Working Projection Integrity Invariant

- Working projection must remain tape-derived and auditable:
  units and working snapshot are derived from event tape semantics, not an
  independent mutable source of truth.
- Projection events (`projection_*`) are operational/observational telemetry.
  They do not replace semantic projection rebuild inputs.
- Working-projection injection must be reproducible from persisted projection
  artifacts (or tape-driven rebuild outputs). If projection artifacts are
  missing, runtime rebuilds units from source tape events, then refreshes the
  working snapshot under the same context-budget policy.

Relevant implementation:

- `packages/brewva-runtime/src/projection/engine.ts`
- `packages/brewva-runtime/src/projection/store.ts`
- `packages/brewva-runtime/src/runtime.ts`
- `packages/brewva-tools/src/task-ledger.ts`

## Failure Modes and Containment

- Missing verification evidence: gate must block completion.
- Missing rollback state: return explicit `no_patchset`.
- Replay without events: return explicit no-session condition.
- Context hard-limit breach: drop injection and emit context drop event.
- Crash after external effect but before durable outcome persistence remains an
  explicit at-least-once boundary for commitment-posture tools.

## Reliability Validation

Tests under `test/unit/runtime/`, `test/contract/runtime/`, and
`test/contract/extensions/` validate these invariants.
