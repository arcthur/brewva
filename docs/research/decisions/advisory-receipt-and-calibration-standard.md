# Decision: Advisory Heuristics Carry Receipts And Offline Calibration, Not A Meta-Optimizer

## Metadata

- Decision: Every hosted advisory heuristic must (1) record a tape receipt for each firing with an honest `source` label and enough fields to grade the decision offline, (2) have an offline calibration recipe that reads only the tape, and (3) land any rule change as reviewed code — the trace Harness stays an observation/report layer and is not elevated into a meta-methodology module that generates, validates, or owns advisory rules.
- Date: `2026-07-09`
- Status: accepted
- Stable docs:
  - `docs/architecture/design-axioms.md`
  - `docs/reference/hosted-dynamic-context.md`
  - `docs/research/decisions/trace-driven-harness-improvement.md`
- Code anchors:
  - `packages/brewva-gateway/src/hosted/internal/session/skills/skill-selection.ts`
  - `packages/brewva-gateway/src/hosted/internal/session/skills/skill-adoption.ts`
  - `packages/brewva-gateway/src/hosted/internal/session/watchdog/task-stall-adjudication.ts`
  - `packages/brewva-gateway/src/hosted/internal/session/tools/tool-output-distiller.ts`
  - `packages/brewva-gateway/src/hosted/internal/context/evidence/ledger-writer.ts`
  - `packages/brewva-gateway/src/hosted/internal/context/runtime-brief.ts`
  - `script/analyze-advisory-receipts.ts`

## Decision Summary

- The standard has three obligations. Receipt: each advisory firing lands on the tape with its decision, rationale-bearing fields, and an honest `source` label (`heuristic` vs `hook`). Recipe: each surface has an offline calibration view over those receipts — `bun run analyze:advisory-receipts` is the shared implementation (skill offer-vs-adoption, stall decisions by source, distiller compression by strategy with eligible-tool denominators). Governance: recipes derive reports, never rule changes; tuning lands as reviewed code.
- Rejected alternative: elevating the trace Harness into a unified meta-methodology module ("candidate generator + trace evidence + held-in/held-out validation" swallowing SkillCard routing, RuntimeBrief, watchdog, and distiller rules). Three grounds: it reverses the accepted trace-driven-harness boundary (patrol/compare reports are advisory and mutate nothing); the tape corpus at audit time (8 single-task sessions) cannot power held-out validation, so the machinery would ship without fuel; and a global rule-optimizer is the same failure class as the local optimizers it would govern. Held-out experimentation stays offline (the shepherd substrate), outside the runtime.
- Audit, skill selection: already subtracted to deterministic reasons (the fuzzy-matching engine removal); receipts (`skill.selection.recorded`) plus the adoption projection were the evidence that graded it (fuzzy offers dominated surfacing with ~1-in-8 adoption). The account-then-grade-then-calibrate loop this ran is the pattern this decision generalizes.
- Audit, task-stall adjudication: kept unchanged as the exemplar. Decisions are `*_recommended`/`steer`/`continue` with zero enforcing consumers (surfaced to the model via `workflow_status`); the receipt (`task.stall.adjudicated`) carries decision, source, rationale, signal summary, and counts; the adjudicator is a pluggable hook. Fixed trigger thresholds are conservative circuit-breaker conditions for an advisory, acceptable until receipts accumulate enough to grade them.
- Audit, tool-output distiller: kept unchanged, all six strategies. It is a presentation compressor, not a decision heuristic — per-tool strategies (exec error-lifting, grep match lines, lsp counts, browser interactive refs and diff signs) are format-structural; guards skip low-gain distillation; the raw output stays reachable (artifact ref, `output_search`); the receipt (`tool_output_distilled`) carries strategy and token metrics. Removing strategies would regress context cost for zero model-facing simplification.

## Residue

- The RuntimeBrief renders salience-gated sections without a per-turn receipt of which sections rendered, demoted, or dropped. Deliberate: a per-turn render receipt is the noisiest possible event and has no consumer today. Trigger: wire a render receipt the first time a brief section needs calibration evidence beyond its unit contract.
- The current corpus bounds every calibration conclusion — zero firings means unexercised, not unnecessary. The report script prints this caveat; no threshold in the audited surfaces may be retuned from a corpus that has never fired it.

## Axioms

Obeys `docs/architecture/design-axioms.md`:

- Axiom 5: an advisory firing is a commitment to shape model attention, so every firing carries a receipt.
- Axiom 6: calibration reads the tape; there is no parallel telemetry store to drift from it.
- Axiom 18: receipts and calibration reports derive views — they grant no authority and auto-tune nothing.
- Axiom 2: adaptive rule-tuning stays out of the kernel and control plane; rule changes are reviewed code, not a learning loop.
- Axiom 19: where a receipt deliberately does not exist (RuntimeBrief section rendering), the gap is recorded as residue with a trigger instead of implied coverage.

## Superseded by

- None.
