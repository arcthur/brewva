# Decision: Graded Requirement Evidence And Routing Activation

## Metadata

- Decision: The accepted requirement loop gains an orthogonal evidence grade.
  Verification evidence carries a GRADE (`presence` < `static_guard` <
  `behavioral`) that names how a check knows, not which ladder rung it reached. A
  `runtime`/`security` requirement cannot reach `satisfied` on presence alone: it
  caps at `likelySatisfied` and surfaces as `insufficientGradeAtoms`. The runtime
  runs static-guard predicates inside `verification_record` and records them as
  graded `evidenceItems`, so the grade is earned by the predicate running rather
  than claimed by the model; the orient trap seeds `riskClass` so the cap engages
  on the auto-injected atom; and greenfield routing forces the implement bundle
  with a relevance tie-break, every part of it advisory.
- Date: `2026-07-05`
- Status: accepted
- Stable docs:
  - `skills/core/verifier/references/verification-ladder.md` (the grade axis,
    the static-guard producer, and `insufficientGradeAtoms`)
  - `skills/core/greenfield/SKILL.md`, `skills/core/plan/SKILL.md` (atomize
    before the first write)
- Code anchors:
  - `packages/brewva-vocabulary/src/internal/{fitness,iteration,task}.ts`
    (`EvidenceKind`, `insufficientGradeAtoms`, `evidenceItems`, `riskClass`)
  - `packages/brewva-tools/src/shared/static-guard/{predicates,producer}.ts`
  - `packages/brewva-tools/src/families/workflow/verification-record.ts`,
    `packages/brewva-tools/src/runtime-port/verification.ts`
  - `packages/brewva-gateway/src/hosted/internal/session/skills/orient-requirement-injection.ts`
  - `packages/brewva-cli/src/operator/inspect/run-report.ts` (requirement lifecycle)

## Decision Summary

- Grade is orthogonal to rung: a rung is how deep a check reached, a grade is how
  it knows — `presence` (a grep), `static_guard` (a deterministic predicate over
  the real source), `behavioral` (observed at runtime). The fitness join reads the
  grade; `checks` stays the human summary the join never parses.
- The runtime, not the model, earns the grade: `verification_record` runs the
  static-guard adapters over the fresh-touched source and records them as
  `evidenceItems`, so a `static_guard` pass cannot be fabricated and a fail is a
  real `deterministic_conflict`.
- A risk-classed requirement resists a presence re-grep: `runtime`/`security`
  atoms cap at `likelySatisfied` and surface as `insufficientGradeAtoms` rather
  than a fake `satisfied`. The trap seeds the `riskClass`, so the cap engages on
  the automatic atom, not only when a model self-classifies.
- Authorship rides the receipt perspective, never the evidence item: an
  independent review's positive signal is the receipt's `atomRefs`, and evidence
  items are always deterministic, so there is one home per source and nothing
  double-counts.
- Routing and lifecycle are advisory projections: greenfield forces the implement
  bundle with a relevance tie-break, and the run-report lifecycle shows whether
  atoms preceded the first write — ranking and disclosure, never a gate.

## Axioms

Obeys `docs/architecture/design-axioms.md`:

- Axiom 18 (load-bearing): the grade, `riskClass`, and lifecycle are descriptive
  metadata that derive views; the cap surfaces debt and the sole gate stays the
  operator-promoted `VerificationGateManifest`.
- Axiom 7: an under-graded atom reads `likelySatisfied` with
  `insufficientGradeAtoms` — honest inconclusive, not a fake pass.
- Axiom 19: every graded surface ships with a producer a liveness fitness proves.
- Axioms 1, 4, 12: routing candidates and grades are advisory projections over
  receipts; nothing new enters the kernel or governs a thought path.

## Superseded by

- None.
