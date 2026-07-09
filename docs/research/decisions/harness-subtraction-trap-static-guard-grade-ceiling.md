# Decision: Harness Subtraction Of Trap Library, Static-Guard Grade Ceiling, And Independence-Debt Census

## Metadata

- Decision: Brewva removes the trap library (orient-phase substring atom injection and write/verify lens surfacing), the static-guard 6-lens producer, the evidence GRADE axis (`presence`/`static_guard`/`behavioral`) with its coverage axis, the `MIN_EVIDENCE_KIND_BY_RISK` grade ceiling and `InsufficientEvidenceGradeDebt`, and the `independenceDebtResolution` census. The `authorship taints verification` PRINCIPLE survives as the lightest model-facing touch: `independenceDebtAtoms` re-anchors to a grade-free predicate — a high-risk (`runtime`/`security`) `must` atom with no deterministic or independent pass — and the `[RuntimeBrief]` delegation advisory keeps naming it. Requirement atoms, the authored/independent perspective split, the fitness state machine, discrepancies, review debt, and act-on-review closure are unchanged; the deterministic-evidence channel (`EvidenceItem`) stays as general plumbing awaiting a future gate/LSP producer.
- Date: `2026-07-09`
- Status: accepted
- Stable docs:
  - `docs/architecture/design-axioms.md`
  - `docs/journeys/operator/verification-and-independent-review.md`
  - `docs/guide/operator-conventions.md`
- Code anchors:
  - `packages/brewva-vocabulary/src/internal/fitness.ts`
  - `packages/brewva-tools/src/families/workflow/verification-record.ts`
  - `packages/brewva-tools/src/runtime-port/verification.ts`
  - `packages/brewva-gateway/src/hosted/internal/context/runtime-brief.ts`
  - `packages/brewva-gateway/src/delegation/model-routing.ts`

## Decision Summary

- The removed machinery was overfit. The static-guard 6 lenses were macOS-app-specific regexes (`CGEvent`/`NSPasteboard`/`SFSpeech`/`TIS`) that no-op on brewva's own TypeScript, so the grade ceiling's only at-grade producer was structurally unreachable in headless self-development: the independence-debt census sat permanently `open` — noise, not signal (contra axiom 7's honest inconclusive).
- The trap library encoded one historical macOS event-tap defect as an always-on substring matcher (`event tap`, `键盘监听`, `CGEvent.tapCreate`). A single-bug heuristic with zero generalization is exactly what a capable model internalizes and a harness should shed.
- These were unpromoted candidate-axiom mechanisms (single-ring, empirical promotion still pending), so removing them overrides no accepted constitutional contract.
- The principle is retained, not the machinery. `authorship taints verification` stays sound: a high-risk atom covered only by an author self-claim reads `likelySatisfied` and still owes an independent read, expressed through the grade-free `independenceDebtAtoms` and its advisory. With the grade floor gone, any deterministic OR independent pass now reaches `satisfied` — an independent review's CLEAR genuinely discharges a high-risk atom instead of being capped.
- The parallel model-routing subtraction removes the `ROUTING_POLICIES` keyword tables and hardcoded model ids: delegation model choice is negotiated through the active preset and an advisory `modelHint`, never guessed from objective keywords.
- Subtraction beats a dormant switch (axiom 3): the mechanisms are deleted from the default path, not toggled off; no shadow profile, compatibility wrapper, or no-op adapter survives.

## Axioms

Obeys `docs/architecture/design-axioms.md`:

- Axiom 3 (load-bearing): a control-plane mechanism that stopped earning its keep is deleted from the default path, not hidden behind a compatibility toggle.
- Axiom 1: the retained independence advisory informs the model at turn tail; it seizes no attention and derives no gate.
- Axiom 7: a high-risk atom with only authored coverage reads `likelySatisfied` and owes an independent read — honest inconclusive, not a fake pass.
- Axiom 18: `independenceDebtAtoms` and the model-routing preset/hint remain descriptive advisory surfaces that derive views, never an unbypassable gate or authority grant.

## Superseded by

- None.
