---
name: calibration-report
description: Run the recurring harness calibration pass — aggregate advisory receipts, run the
  offline evals, and write a dated report with subtraction and calibration proposals for human
  review.
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
4. Score end-to-end outcome quality with `exec`: `bun run report:self-eval`
   (add `--fixture <id>` to scope, or record the leg as skipped when no provider
   or budget is available). It drives the frozen build/debug/comprehension
   fixtures through the embedded runtime and reads per-run tape metrics. Capture
   the completion rate (completed vs fail-closed suspended), the per-family
   tool-surface exercise profile, and deltas vs the previous report under
   `.brewva/reports/self-eval/`.
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
   - `## Self-Eval` — completion rate and per-family tool-surface exercise
     profile with deltas vs the prior self-eval report; the standing chart the
     tool-surface RFC's one-off n=12 table became (or "leg skipped").
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

## Stop Conditions

- No tape corpus exists yet — there is nothing to measure; record that and
  exit without a report.
- The requested action is a rule, config, or surface change rather than a
  measurement pass — route it to reviewed code.
- A previous pass's report for the same window already exists and no new
  evidence has landed since.
