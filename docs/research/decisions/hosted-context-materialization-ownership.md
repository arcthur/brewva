# Decision: Hosted Context Materialization Ownership

## Metadata

- Decision: Gateway hosted context materialization and model-downshift compaction policy are owned by dedicated hosted internal modules.
- Date: `2026-05-12`
- Status: accepted
- Stable docs:
  - `docs/architecture/system-architecture.md`
  - `docs/architecture/control-and-data-flow.md`
  - `docs/guide/orchestration.md`
  - `docs/reference/runtime.md`
- Code anchors:
  - `packages/brewva-gateway/src/hosted/internal/context/materialization.ts`
  - `packages/brewva-gateway/src/hosted/internal/compaction/model-downshift-policy.ts`
  - `packages/brewva-gateway/src/hosted/internal/context/workbench-context.ts`
  - `packages/brewva-gateway/src/hosted/internal/compaction/flow.ts`
  - `packages/brewva-gateway/src/hosted/internal/compaction/recovery.ts`
  - `packages/brewva-gateway/src/hosted/internal/session/managed-agent/session.ts`
  - `test/unit/gateway/managed-agent-session.unit.test.ts`
  - `test/unit/gateway/provider-request-reduction.unit.test.ts`

## Decision Summary

- Hosted context construction is gateway policy, not runtime policy and not delegation envelope metadata.
- Passive `contextProfile` is removed. The hosted lane no longer has a `minimal/standard/full` knob.
- `hosted/internal/context/materialization.ts` owns model-context materialization commands: usage observations, compaction nudges, visible-read state, prompt stability, provider cache observations, capability disclosure, delegation surfacing, workbench rendering hooks, and telemetry.
- `hosted/internal/compaction/model-downshift-policy.ts` owns smaller-context-window compaction decisions, recent suppression, gate interpretation, request-and-wait behavior, and recovery fallback.
- Runtime mutations from hosted code use the explicit hosted/operator ports for hosted operations or the root authority port for replay-visible commitments.
- Compatibility with `contextProfile` fields and tests is intentionally not preserved.

## Supersedes

- Context-profile portions of `docs/research/decisions/specialist-subagents-and-adversarial-verification.md`

## Superseded by

- `docs/research/decisions/hosted-materialization-plan.md`
