# Decision: Trust-Substrate Optimization Axis And Verification-Evidence Closure

## Metadata

- Decision: Brewva optimizes consequence-trust over loop coverage; the L1/L2
  verification-evidence gaps are closed by aggregating review reviewers and
  projecting recent exec failures, without widening kernel authority.
- Date: `2026-06-14`
- Status: accepted
- Stable docs:
  - `docs/reference/tools.md`
  - `docs/reference/tools/execution.md`
  - `docs/reference/exec-threat-model.md`
- Code anchors:
  - `packages/brewva-tools/src/shared/review-ensemble/synthesis.ts`
  - `packages/brewva-tools/src/runtime-port/verification-diagnostics.ts`
  - `packages/brewva-tools/src/families/workflow/observability/obs-snapshot.ts`
  - `packages/brewva-tools/src/families/execution/exec.ts`

## Decision Summary

- The measuring stick for harness work is whether a change makes the model more
  trustworthily autonomous or merely covers more of the loop. Loop coverage
  commoditizes as models get fast and cheap; consequence-trust (replay-first
  truth, effect governance, deterministic recovery) does not.
- The review ensemble aggregates every reviewer delegated to a lane: findings
  and evidence are unioned, dissent is preserved, the lane disposition is the
  worst across reviewers, and an outcome that states no disposition, findings,
  or missing-evidence is counted as execution failure, never inferred as clear.
  Review verdicts stay fail-closed; reviewer execution failures are tracked
  separately so redundant reviewers never lower availability.
- Recent exec and box failures are projected deterministically from committed
  receipts into `obs_snapshot` (sandbox read from `sandboxProfile.backend`,
  deduplicated newest-first, truncation surfaced rather than silent). Current
  verification state remains owned by `verification.outcome.recorded`.
- Host command non-zero exits and start failures now emit `exec.failed`,
  symmetric with the box lane, so host failures are no longer invisible to
  recent-failure projections.
- Spec-gate enforcement, L3 coverage automation, and a formal required-versus-
  optional reviewer quorum are deferred. Promoting the measuring stick into
  `docs/architecture/design-axioms.md` and opening focused substrate RFCs
  (tape-as-truth under parallelism, effect-governance friction, moat locus)
  remain follow-ups.

## Axioms

- Obeys axiom 1 (`Attention belongs to the model.`): verification diagnostics
  are surfaced through `obs_snapshot` for the model to pull, never
  force-materialized into context.
- Obeys axiom 6 (`Tape is commitment memory.`): the recent-failure view is a
  projection over committed exec receipts, and host failures now leave a
  receipt instead of vanishing.
- Obeys axiom 7 (`Inconclusive is honest governance.`): a reviewer that states
  no verdict is treated as missing coverage, not a fake pass.
- Obeys axiom 11 (`Same evidence is not shared authority.`): review and
  diagnostics evidence stay advisory and do not widen verification-gate or
  kernel authority.

## Superseded by

- None.
