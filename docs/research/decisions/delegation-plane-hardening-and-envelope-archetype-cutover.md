# Decision: Delegation Plane Hardening And Envelope Archetype Cutover

## Metadata

- Decision: Enforce parallel admission from replay-derived tape, collapse the five execution envelopes into three validated archetypes with delegation capsules, project pending work as a two-partition adoption board, and pin the journey's authority claims to live enforcement.
- Date: `2026-06-13`
- Status: accepted
- Stable docs:
  - `docs/journeys/operator/background-and-parallelism.md`
  - `docs/reference/tools/delegation.md`
  - `docs/guide/orchestration.md`
- Code anchors:
  - `packages/brewva-gateway/src/delegation/parallel-admission.ts`
  - `packages/brewva-gateway/src/delegation/catalog/registry.ts`
  - `packages/brewva-session-index/src/projection/delegation.ts`
  - `packages/brewva-vocabulary/src/internal/delegation.ts`
  - `test/fitness/delegation-claims-enforcement.fitness.test.ts`

## Decision Summary

- The hosted `parallel` port enforces concurrency and per-session lifetime budgets from replay-derived tape; the active count self-heals from tape, so a finished or detached run never leaks a slot.
- Synchronous `acquire` is fail-fast per the journey contract; `acquireAsync` offers a bounded, polling wait posture for best-effort transient throttling.
- Resource leases raise the concurrency ceiling only when wall-clock-bounded or indefinite; turn-bounded leases do not, because turn expiry is not enforced.
- Execution physics is a closed set of three archetypes — `readonly-shared`, `patch-snapshot`, `exec-ephemeral` — and the five public roles plus review lanes are capsules that may only narrow their bound archetype.
- Adoption derives from the result contract through a single `deriveDelegationAdoptionRequirement`, orthogonal to the archetype: a `patch` contract is valid only on a patch-producing archetype, while `knowledge` adoption holds on any archetype.
- Workspace capsules narrow the persona they extend, never the shared archetype ceiling, so a sibling persona's tools stay out of reach.
- The adoption board re-partitions run cards into adoption items and advisory attention items, mirroring the inbox so a verifier or evidence outcome can never be conflated with an adoption decision; it owns no truth and `workflow_status` surfaces it on demand.
- Authority-bearing journey claims are pinned to live enforcement with a doc-drift guard, keeping documented authority and wired authority in lockstep.
