# Decision: Verification Receipt Plane, Selection Feedback, And Execution Pacing

## Metadata

- Decision: Verification depth becomes a rung vocabulary on the existing
  `verification.outcome.recorded` receipt with `verification_record` as its
  model-facing producer and the latest receipt as the only "green"; skill
  selection gains generic forced candidates plus deterministic session-scoped
  demotion of ignored text_match-only offers; verification-class commands get
  an operator-owned foreground wait and `process poll until="exit"` backed by
  a registry wait-for-exit primitive; usage-less committed attempts record
  marked token estimates; `brewva inspect --run-report` projects the run story
  from the tape.
- Date: `2026-07-04`
- Status: accepted
- Stable docs:
  - `skills/core/verifier/references/verification-ladder.md`
  - `skills/core/greenfield/SKILL.md`
  - `docs/guide/operator-conventions.md`
  - `docs/guide/cli.md`
- Code anchors:
  - `packages/brewva-vocabulary/src/internal/iteration.ts`
  - `packages/brewva-tools/src/families/workflow/verification-record.ts`
  - `packages/brewva-gateway/src/hosted/internal/session/skills/skill-adoption.ts`
  - `packages/brewva-gateway/src/hosted/internal/session/skills/skill-selection.ts`
  - `packages/brewva-std/src/command-class.ts`
  - `packages/brewva-tools/src/families/execution/exec-process-registry/sessions.ts`
  - `packages/brewva-gateway/src/hosted/internal/session/managed-agent/provider-assistant-observer.ts`
  - `packages/brewva-cli/src/operator/inspect/run-report.ts`

## Decision Summary

- Verification depth is a ladder (`exit_code` → `diagnostics` → `artifact` →
  `requirements` → `runtime_smoke`) riding the receipt's `level`; the receipt
  gains `checks`. `verification_record` is the first model-facing producer —
  the receipt machinery existed with zero producers, which is how an audited
  app shipped exit_code-green with nine latent defects and blank Evidence.
- "Green" is receipt-only and latest-only. Exec heuristics were rejected in
  review: exec audits persist under a different stored kind, backgrounded
  failures emit no failure event, box lanes emit their own kinds, and
  `.some(pass)` let a stale pass outweigh the newest fail.
- Skill nudges are data, not branches: a forced-candidates map (name → reason)
  feeds the generic scorer and the receipt records `forcedCandidates`; only
  the lifecycle names `review`. Demotion is deterministic, receipt-derived,
  fails closed on a truncated window; adoption keeps its narrow since-latest
  window because `after`+`limit` returns the FIRST N events.
- Pacing is operator policy plus a static table: `classifyCommandClass` picks
  the class, `autoBackground.verificationForegroundWaitMs` owns the wait, and
  `until="exit"` blocks on `waitForManagedSessionExitEffect` (both backends
  publish `type: "exit"`), defaulting to the maximum bounded wait, failing
  fast on non-backgrounded sessions, draining once after exit.
- Marked estimates are honest physics: usage-less live attempts record
  `estimated: true` output tokens (never for `error`/`aborted` stop reasons),
  gated by `contextBudget.usageEstimation` injected as an observer option;
  reduction estimation falls back to the catalog context window.
- `--run-report` is a pure projection over port-flattened events: wait
  attribution (model gaps reset at turn boundaries; aborts count only from an
  actual start), approvals, error→fix cycles, verification receipts versus
  observed verification commands (green-without-receipt is debt), selection
  history, and cost including estimates.

## Axioms

Obeys `docs/architecture/design-axioms.md`:

- Axiom 1: forced candidates and demotion shape the advisory shortlist only.
- Axiom 2: static command table and deterministic demotion; no kernel change.
- Axiom 5: green derives solely from the committed receipt; estimates commit
  as marked receipts instead of staying silent.
- Axiom 6: run report and selection signals are rebuildable tape projections.
- Axiom 7: truncated windows demote nothing; missing usage records a marked
  estimate, not a fake zero or fake pass.
- Axiom 12: the post-green nudge projects verify→continue grammar over
  existing receipts; no planner was added.

## Superseded by

- None.
