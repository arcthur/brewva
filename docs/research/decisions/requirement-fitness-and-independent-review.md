# Decision: Requirement Fitness And Independent Review

## Metadata

- Decision: The intent-realization loop lands as descriptive, receipt-borne
  accounting with the single blocking path unchanged. Verification evidence
  gains a `perspective` (`authored` vs `independent`, the latter carrying a
  non-empty `independenceBasis[]`); `review_request` runs a bounded fresh-context
  reviewer and commits `review.finding.recorded` (mandatory `targetRef`) plus one
  `independent` outcome; requirement atoms become task-ledger artifacts; a pure
  trap library injects orient atoms and surfaces write/verify lenses; a pure
  fitness join grades atoms × evidence into `deterministic_conflict` /
  `advisory_conflict` discrepancies; `verification_record` annotates a
  `pass`@`requirements`+ receipt with them and `unverifiedMustAtoms` while
  recording the outcome exactly as claimed; run-report and the Work Card
  RE-DERIVE that fitness over the whole tape at read time (not off the latest
  receipt) so a later independent atoms-review's `satisfied` surfaces; and an
  operator may bridge a recurring `deterministic_conflict` into the existing
  `VerificationGateManifest`, which stays the sole gate.
- Date: `2026-07-05`
- Status: accepted
- Stable docs:
  - `skills/project/shared/critical-rules.md` (producer-wiring invariant)
  - `skills/core/verifier/SKILL.md`, `.../references/verification-ladder.md`,
    `skills/core/greenfield/SKILL.md` (fitness + review-debt disclosure)
  - `docs/reference/extensions.md` (gate-bridge recipe),
    `docs/guide/operator-conventions.md` (distillation flow),
    `docs/reference/tools.md` (`review_request`)
- Code anchors:
  - `packages/brewva-vocabulary/src/internal/{iteration,review,fitness,task}.ts`
  - `packages/brewva-tools/src/{families/delegation/review-request*,shared/trap-library,families/workflow/verification-record,runtime-port/verification}.ts`
  - `packages/brewva-gateway/src/hosted/internal/session/skills/orient-requirement-injection.ts`
  - `packages/brewva-cli/src/operator/inspect/{fitness-summary,requirement-fitness,run-report,work-card,review-debt}.ts`

## Decision Summary

- Perspective is a dimension of evidence, not a workflow: `authored` and
  `independent` are different receipt kinds, and a model cannot record itself as
  independent because `verification_record` has no perspective input.
- A finding is not evidence unless it says what it reviewed: a mandatory
  `targetRef` makes stale findings contribute nothing to a violation, and review
  debt clears only when an independent receipt matches the tree and covers the
  fresh-touched file universe.
- The claim-time cross-check annotates, never refuses: the outcome is recorded
  exactly as claimed; a pass-with-discrepancies is visible debt; only
  `deterministic_conflict` is eligible for a gate manifest, and LLM findings gate
  nothing. Fitness counts stay a re-derivable view, not commitment memory.
- The operator surfaces re-derive that view at read time, not off the frozen
  receipt: run-report's Fitness section and the Work Card line fold the CURRENT
  fitness over the whole tape (`buildTapeRequirementFitness`, the SAME producer-
  side fold). That lands `satisfied` (the independent atoms-review's affirmative
  half arrives after the authored verify, so no single receipt carries it) and
  closes the "empty post-review receipt reads as nothing-unverified" bug. It
  stores nothing new (axiom 6). Supersedes the earlier "frozen receipt" ruling.
- A lens surfaces a stance, it never asserts a defect; the precision guard lives
  in the fitness join, not in trap surfacing, and the trap library gates nothing.
- Surfaces ship with producers — a receipt or advisory surface is not shipped
  until a producer is wired and a liveness fitness asserts a canonical run emits
  it (now a critical rule), curing "organs without circulation."

## Axioms

Obeys `docs/architecture/design-axioms.md`:

- Axiom 18 (load-bearing): atoms, findings, perspective, discrepancies, traps,
  and lenses derive views, never authority; no new blocking path exists and the
  sole gate stays the operator-promoted `VerificationGateManifest`.
- Axioms 1, 2: trap lenses and atom injection are advisory candidates; no
  adaptive selection enters the kernel.
- Axioms 5, 6: findings, atoms, and outcomes are receipts; the projection and read
  surfaces rebuild from them and read no filesystem.
- Axiom 7: a stale or unbacked atom reads `unverified` and a contradicted pass
  reads as visible debt — honest, not a fake pass/fail.
- Axioms 10, 12: review, verify, and debt/fitness pressure are product grammar
  over receipts, not a runtime state machine.

## Superseded by

- None.
