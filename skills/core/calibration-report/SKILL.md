---
name: calibration-report
description: The recurring, report-only harness calibration pass — a measured check of whether
  the harness's advisory surfaces still earn their keep, emitting human-reviewed subtraction and
  calibration proposals rather than direct rule changes.
selection:
  when_to_use: Use when a scheduled or requested pass should measure whether the harness's
    advisory surfaces earn their keep — receipts, eval outcomes, and deltas distilled into a
    report artifact with proposals, never direct rule changes.
---

# Calibration Report Skill

## The Iron Law

```
REPORTS AND PROPOSALS ONLY — NEVER A DIRECT RULE, CONFIG, OR SURFACE CHANGE
```

Produce one dated report that answers: which advisory surfaces earned their
keep since the last pass, what regressed, and what should a human consider
subtracting or recalibrating. You derive reports and proposals only — you never
change rules, weights, thresholds, config, or tool surfaces yourself
(calibration derives reports; rule changes land as reviewed code).

## When to Use / When NOT to Use

Use when:

- a scheduled calibration pass fires, or an operator requests one
- advisory surfaces need a measured earn-their-keep check against the live
  tape corpus and offline evals

Do NOT use when:

- the need is a one-off metric lookup (run the specific `analyze:*` command
  directly)
- the intent is to change a rule, threshold, or surface — that is reviewed
  code, never a calibration pass

## Workflow

1. Read the previous report, if any: list `.brewva/reports/calibration/` and
   read the latest file so deltas are against the prior pass, not absolute.
2. Aggregate the advisory receipts over the live tape corpus with `exec`:
   `bun run analyze:advisory-receipts`. Capture: sessions/events scanned, skill
   offer-vs-opened, stall decisions, distiller firings, and the per-family
   tool-surface invocation table (zero-committed families are the subtraction
   watchlist).
3. Run the recall runtime eval with `exec`: `bun run eval:recall`. Record
   per-scenario pass/fail. A scenario that flipped since the previous report is
   a regression finding, not a footnote.
4. Score end-to-end skill behavior as one immutable experiment, one pilot at a
   time. Choose different explicit strong- and weak-tier model routes. For each
   tier, run the full canonical fixture cohort. The two decision-bearing arms
   use the fixed retirement policy (30 runs per fixture, 95% confidence, 10%
   margin); `no_skill` is a diagnostic control only:
   - `bun run report:self-eval --experiment <id> --skill <pilot> --model-tier <strong|weak> --arm no_skill --mode diagnostic --model <route> --runs 30`
   - `bun run report:self-eval --experiment <id> --skill <pilot> --model-tier <strong|weak> --arm kernel_only --mode retirement --model <route>`
   - `bun run report:self-eval --experiment <id> --skill <pilot> --model-tier <strong|weak> --arm kernel_scaffold --mode retirement --model <route>`
     The target arm varies only `<pilot>`; the other pilot skills remain constant.
     Capture every unique JSON path. The decision-bearing command consumes both
     tier legs at once:
     `bun run report:self-eval:compare -- --strong-baseline <strong-scaffold.json>
--strong-candidate <strong-kernel.json> --weak-baseline <weak-scaffold.json>
--weak-candidate <weak-kernel.json>`. Only matrix exit `0` makes the scaffold
     eligible for a reviewed demotion; `2` keeps it default-loaded and `3` is
     inconclusive. Compare `no_skill` to `kernel_scaffold` only with `--mode
diagnostic`; it is not a retirement gate. The comparator refuses same-arm or
     backwards comparisons, mixed routes, different source/evaluator/fixture/
     target/tier/cohort identity, safety/honesty regression, and point-estimate
     passes whose confidence bound is insufficient. It also requires receipt-backed
     target `SKILL.md` opens on relevant runs and a strict-scaffold open on the
     scaffold baseline; missing treatment exposure is inconclusive. Record skipped legs; never
     reuse an older arm to complete a matrix.
5. If the harness trace surface is available, run `brewva harness patrol` and
   note drift clusters; if the command is unavailable, record that the patrol
   leg was skipped rather than silently omitting it.
6. Distill precedent candidates with `exec`: `bun run rdp:distill`. It reads
   committed tape failures and writes investigation-record-shaped promotion
   candidates under `.brewva/knowledge/rdp/` — candidates for human review,
   never active solution records. Note how many candidates are new since the
   previous report.
7. List promotion readiness with `exec`:
   `bun run analyze:promotion-readiness` (add `-- --run` only when the pass has
   budget for executing the declared gates). Capture per-note gate counts and
   any gate failures. Then count the proposal-lane backpressure with `exec`:
   `bun run analyze:proposal-backpressure` — unconsumed harness candidates by age
   bucket.
8. Name the calibration-eligible parameters with `exec`:
   `bun run analyze:calibration-registry`. Record which parameters are
   `asserted` (unexercised) vs `contested`, so any calibration proposal moves a
   named registry parameter — the only candidate-tunable surface — instead of
   inventing a new tunable knob.
9. Write the report to `.brewva/reports/calibration/<YYYY-MM-DD>.md` with
   exactly these sections:
   - `## Corpus` — sessions, events, time range.
   - `## Deltas` — what changed since the previous report (or "first pass").
   - `## Zero-Firing Advisories` — surfaces with no receipts this window; say
     "unexercised, not unnecessary" when the corpus cannot distinguish.
   - `## Eval Outcomes` — recall scenarios (and any other suites you ran).
   - `## Self-Eval` — experiment id, model route, three arm identities and
     content digests, exact cohort size, comparison exit/verdict, task-success
     deltas, and per-family tool-surface profile (or "leg skipped").
   - `## Promotion Readiness` — per-note gates declared/passed and prose
     criteria remaining.
   - `## Distilled Precedent Candidates` — new RDP candidates this window with
     their `(toolName, failureClass)` patterns.
   - `## Calibration Registry` — the calibration-eligible parameters by status
     (`asserted`/`contested`); any `calibration` proposal must target one of
     these named parameters, never a new knob.
   - `## Proposal Backpressure` — one line: unconsumed proposals by age bucket
     (the Phase-4 demand counter). A backlog growing across consecutive reports
     is the trigger to design aging/expiry; a flat or low count means do not.
   - `## Proposals` — numbered, each tagged `subtraction`, `calibration`, or
     `investigation`, each citing its evidence lines above. Proposals are for
     human review; do not act on them in this session.
10. Pin a one-line summary of the report path and headline delta with
    `workbench_note` so the parent schedule session can surface it next run.

## Boundaries

- Report artifacts and promotion candidates only (the report file, RDP
  candidates under `.brewva/knowledge/rdp/`, the workbench pin). No config
  edits, no registry changes, no skill edits, no schedule mutations, and never
  an active solution record — promotion runs through the knowledge-capture flow
  with human review, outside this pass.
- Bounded honesty over completeness: if a leg fails (eval crash, missing
  corpus), record the failure in the report and continue with the legs that
  ran.
- Keep the report under ~200 lines; link evidence rather than inlining raw
  command output.

## Rules

- `calibration-report.no-direct-calibration-write` (non-negotiable) — Never
  turn a measurement pass into a rule, config, threshold, or surface mutation;
  emit evidence-backed proposals for reviewed code.
- `calibration-report.comparable-self-eval-cohort` (non-negotiable) — Never
  compare self-eval arms across different experiment, source/evaluator,
  fixture-corpus, target-skill, model-tier, `(fixture, runIndex)`, or observed
  single-route identities.
- `calibration-report.inconclusive-stays-inconclusive` (non-negotiable) — Never
  report missing, insufficient, or incomparable evidence as a pass.
- `calibration-report.zero-firing-posture` (adaptive-heuristic) — Default:
  classify zero observations as unexercised until an eligible-opportunity
  denominator and outcome evidence make subtraction informative.

## Stop Conditions

- No tape corpus exists yet — there is nothing to measure; record that and
  exit without a report.
- The requested action is a rule, config, or surface change rather than a
  measurement pass — route it to reviewed code.
- A previous pass's report for the same window already exists and no new
  evidence has landed since.
