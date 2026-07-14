---
name: review
description: Findings-first risk review for diffs and change plans, including merge readiness and
  conformance checks.
selection:
  when_to_use: Use when a diff or change plan needs findings-first risk review, merge readiness
    assessment, or conformance checking — including freshly generated code that just passed
    verification and has never been read adversarially.
references:
  - references/boundary-failure.md
  - references/contract-drift.md
  - references/review-lanes.md
  - references/security-concurrency.md
  - references/strict-protocol.md
  - references/example.md
  - references/rationalizations.md
invariants:
  - invariants/review-lane-rules.md
---

# Review Skill

## The Iron Law

```
NO MERGE DECISION WITHOUT EVIDENCE FROM EVERY ACTIVATED LANE — A SKIPPED LANE
IS DECLARED WITH ITS REASON, NEVER SILENT
```

Judge risk, not style. Surface the highest-value findings first and make
merge safety explicit.

## When to Use

- Reviewing a diff or change plan
- Checking merge readiness
- Assessing regression, compatibility, or operational risk
- Fresh code just passed verification and nobody has tried to break it yet —
  a green build proves the toolchain accepted it, not that the guard
  conditions, lifecycles, and failure paths are right

**Do NOT use when:**

- There is no concrete review target
- The real work is debugging or repository analysis

## Workflow

### Phase 1: Build review context

Summarize scope, intent, critical paths, and available evidence. Treat
`design_spec`, `execution_plan`, and `risk_register` as core planning evidence.

**If planning evidence is missing or stale**: Widen the review lens. Missing
evidence is itself a finding.

Check scope drift before judging implementation quality:

- Compare changed files and behavior against `implementation_targets`.
- Treat extra public surface, persisted format, CLI behavior, or cross-package
  movement as scope drift until the plan explicitly justifies it.
- If the change solves a different problem than the plan, stop normal review
  and emit a blocking scope finding.

### Phase 2: Activate review lanes

Derive lanes with the inputs and mapping in
`invariants/review-lane-rules.md`:
`change_categories`, `changed_file_classes`, and evidence availability flags.
This skill is read-only; apply the invariant manually to derive them.

Always-on: `review-correctness`, `review-boundaries`, `review-operability`.
Conditional: `review-security`, `review-concurrency`, `review-compatibility`,
`review-performance` — activated deterministically by the lane rules.

Choose the execution shape by evidence independence, not by ritual: fan the
lanes out as parallel consults when they are genuinely independent slices and
the parallel budget buys information; a single-context review that works each
lane explicitly is equally legal — same-context passes are correlated reads,
so what matters is that every activated lane produced its own recorded
disposition. State which shape you chose and why in `review_report`.

**If the lane rules widen to the full conditional set**: Review evidence is weak.
Proceed with all lanes rather than guessing which to skip.

### Phase 3: Security gate

Apply the secret-exposure gate from `invariants/review-lane-rules.md`. Inspect
the changed content directly without mutating files. This is a gate, not a score —
any finding blocks the review regardless of other lane outcomes.

**If `clean: false`**: Add a blocking finding. Do not proceed to merge readiness.

### Phase 4: Synthesize and decide

Synthesize lane dispositions with the invariant inputs: `activated_lanes` from
Phase 2 and all `lane_outcomes`. Apply the missing-lane rule manually.

**If lanes disagree materially**: Keep the disagreement visible in
`review_report`, with the falsification condition that would settle it. Do
not smooth it away and do not manufacture disagreement where the evidence
converges.
**If missing_lanes is non-empty**: The review is incomplete. Do not override.

Fix routing: findings are handed off (`implementation` for parent-owned
edits, `worker` for delegated patch work). One exception exists — see
`review.fixes-are-routed` in the Rules below; anything wider than that
exception widens silently into implementation and voids the review's
independence.

### Phase 5: Emit findings-first output

Produce `review_findings`, `review_report`, `merge_decision`.

Under pressure to approve, on your own freshly-authored code, or on a
weak-model profile: load `references/strict-protocol.md` and follow it.

## Rules

- `review.evidence-from-every-activated-lane` (controlled-exception) — The
  merge decision cites a recorded disposition from every activated lane.
  Exception evidence: a per-lane inapplicability note in `review_report`
  naming why the lane cannot apply to this target.
- `review.secret-exposure-gate` (non-negotiable) — The secret-exposure gate
  runs on every review; any finding blocks merge readiness regardless of
  other lane outcomes.
- `review.no-silent-scope-blessing` (non-negotiable) — Scope drift against
  the stated plan is surfaced as a finding, never absorbed because the code
  looks better than the plan.
- `review.fixes-are-routed` (controlled-exception) — Review does not mutate
  the target; fixes are routed with context. Exception evidence: an
  inline-fix disposition in `review_report` for a single-line, uncontested
  correction applied under existing write authority.
- `review.lane-fanout` (adaptive-heuristic) — Default: parallel consults for
  independent lanes when the budget buys information; explicit per-lane
  passes in one context otherwise. The recorded per-lane dispositions are
  the invariant, not the topology.

## Invariants

- `invariants/review-lane-rules.md` — Canonical lane activation, lane outcome
  schema, secret exposure gate, and merge-decision synthesis rules. Apply the
  invariant manually without crossing the read-only boundary.

## Decision Protocol

Use these questions to keep the review anchored in behavior, not style:

- What can fail now that could not fail before this change?
- Which contract does the diff rely on without proving?
- Where could persisted state or user-visible behavior drift partially?
- What evidence is still missing but required before `merge_decision = ready`?
- If this merged today, what rollback burden is most likely?
- Has the diff drifted outside `implementation_targets` or the stated plan?
- Is this review shallow because the target is too large, too stale, or missing
  critical context?
- For each lane: did it actually run, and what would falsify its disposition?

## Concrete Example

See `references/example.md` for the grounded example output shape.

## Handoff Expectations

- `review_findings` ordered from highest to lowest value. May be empty when all
  lanes clear — do not invent findings to pad output.
- `review_report` records activated lanes, activation basis, execution shape
  (fanned-out or single-context, and why), blind spots, and precedent consult
  status.
- `merge_decision` matches the findings. Never a detached summary label.
- Routed fixes carry enough context for implementation or a patch worker to
  act; an inline-fix disposition records what was applied and why it
  qualified.

## Stop Conditions

- There is no concrete review target
- Verification evidence is too weak to support a merge decision
- The real work is debugging or repository analysis
- Scope drift makes the target no longer match the plan being reviewed
- Any activated lane, secret scan, or hard-stop gate is missing a recorded
  disposition or declared inapplicability
