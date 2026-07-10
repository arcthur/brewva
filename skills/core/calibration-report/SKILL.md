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

Produce one dated report that answers: which advisory surfaces earned their
keep since the last pass, what regressed, and what should a human consider
subtracting or recalibrating. You derive reports and proposals only — you never
change rules, weights, thresholds, config, or tool surfaces yourself
(calibration derives reports; rule changes land as reviewed code).

## Pass Procedure

1. Read the previous report, if any: list `.brewva/reports/calibration/` and
   read the latest file so deltas are against the prior pass, not absolute.
2. Aggregate the advisory receipts over the live tape corpus with `exec`:
   `bun run analyze:advisory-receipts`. Capture: sessions/events scanned, skill
   offer-vs-adoption, stall decisions, distiller firings, and the per-family
   tool-surface invocation table (zero-committed families are the subtraction
   watchlist).
3. Run the recall runtime eval with `exec`: `bun run eval:recall`. Record
   per-scenario pass/fail. A scenario that flipped since the previous report is
   a regression finding, not a footnote.
4. If the harness trace surface is available, run `brewva harness patrol` and
   note drift clusters; if the command is unavailable, record that the patrol
   leg was skipped rather than silently omitting it.
5. Distill precedent candidates with `exec`: `bun run rdp:distill`. It reads
   committed tape failures and writes investigation-record-shaped promotion
   candidates under `.brewva/knowledge/rdp/` — candidates for human review,
   never active solution records. Note how many candidates are new since the
   previous report.
6. List promotion readiness with `exec`:
   `bun run analyze:promotion-readiness` (add `-- --run` only when the pass has
   budget for executing the declared gates). Capture per-note gate counts and
   any gate failures.
7. Write the report to `.brewva/reports/calibration/<YYYY-MM-DD>.md` with
   exactly these sections:
   - `## Corpus` — sessions, events, time range.
   - `## Deltas` — what changed since the previous report (or "first pass").
   - `## Zero-Firing Advisories` — surfaces with no receipts this window; say
     "unexercised, not unnecessary" when the corpus cannot distinguish.
   - `## Eval Outcomes` — recall scenarios (and any other suites you ran).
   - `## Promotion Readiness` — per-note gates declared/passed and prose
     criteria remaining.
   - `## Distilled Precedent Candidates` — new RDP candidates this window with
     their `(toolName, failureClass)` patterns.
   - `## Proposals` — numbered, each tagged `subtraction`, `calibration`, or
     `investigation`, each citing its evidence lines above. Proposals are for
     human review; do not act on them in this session.
8. Pin a one-line summary of the report path and headline delta with
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
