# Decision: Context-Control Plane Simplification

## Metadata

- Decision: delegation finalization, context materialization, compaction policy, and delegation read models are compressed around shared gateway/runtime modules instead of parallel lifecycles.
- Date: `2026-06-01`
- Status: accepted
- Stable docs:
  - `docs/architecture/system-architecture.md`
  - `docs/architecture/control-and-data-flow.md`
  - `docs/reference/hosted-dynamic-context.md`
  - `docs/reference/tools/delegation.md`
  - `docs/journeys/operator/background-and-parallelism.md`
  - `docs/journeys/internal/context-and-compaction.md`
- Code anchors:
  - `packages/brewva-gateway/src/context/context-bundle.ts`
  - `packages/brewva-gateway/src/delegation/run-finalization.ts`
  - `packages/brewva-gateway/src/delegation/background/detached-run-adapter.ts`
  - `packages/brewva-gateway/src/hosted/internal/context/materialization.ts`
  - `packages/brewva-substrate/src/context-budget/api.ts`
  - `packages/brewva-session-index/src/projection/delegation.ts`
  - `test/unit/gateway/context-bundle.unit.test.ts`
  - `test/unit/gateway/context-materialization.unit.test.ts`
  - `test/unit/gateway/compaction-policy.property.test.ts`

## Decision Summary

- In-process and detached delegation share `DelegationRunPlan` and one finalization receipt path for terminal outcomes, patch capture, worker result recording, lineage outcome recording, and lifecycle completion.
- `DetachedRunAdapter` is the only detached IPC adapter. File-system protocol details, live state, cancellation files, and detached outcome loading stay behind that adapter.
- Hosted dynamic context, delegation prompts, fork context, and detached manifests use immutable `ContextBundle` values with admitted context identity and bundle hashes.
- Context materialization returns typed receipts. The hosted lifecycle caller applies receipt effects, so pure builders do not emit telemetry or mutate surfaced delegation state directly.
- Manual compaction, hosted auto-compaction, and model-downshift recovery share the pure `decideCompaction(...)` policy while `session_compact` remains the only replay-visible history rewrite.
- Delegation and parallel inspection read models live in session-index projection views with cursors and schema versions; event tape remains authority.

## Superseded by

- None.
