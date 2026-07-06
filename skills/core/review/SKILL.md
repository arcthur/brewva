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
  - references/example.md
  - references/rationalizations.md
invariants:
  - invariants/review-lane-rules.md
---

# Review Skill

## The Iron Law

```
NO MERGE DECISION WITHOUT EVIDENCE FROM EVERY ACTIVATED LANE
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
This skill is read-only; use host-provided lane output when already available,
otherwise apply the invariant manually.

Always-on: `review-correctness`, `review-boundaries`, `review-operability`.
Conditional: `review-security`, `review-concurrency`, `review-compatibility`,
`review-performance` — activated deterministically by the lane rules.

For non-trivial review, treat each activated lane as an independent slice:
enumerate the lanes, then fan them out in one `subagent_fanout` message so each
runs as a bounded consult against its own dimension. Synthesize their
dispositions in Phase 4; a lane that returns no findings must have actually run.

**If the lane rules widen to the full conditional set**: Review evidence is weak.
Proceed with all lanes rather than guessing which to skip.

### Phase 3: Security gate

Apply the secret-exposure gate from `invariants/review-lane-rules.md`. Use
host-provided scan results when already available; otherwise inspect the changed
content directly without mutating files. This is a gate, not a score — any
finding blocks the review regardless of other lane outcomes.

**If `clean: false`**: Add a blocking finding. Do not proceed to merge readiness.

### Phase 4: Synthesize and decide

Synthesize lane dispositions with the invariant inputs: `activated_lanes` from
Phase 2 and all `lane_outcomes`. Use host-provided synthesis when available;
otherwise apply the missing-lane rule manually.

**If lanes disagree materially**: Keep the disagreement visible in
`review_report`. Do not smooth it away.
**If missing_lanes is non-empty**: The review is incomplete. Do not override.

Autofix routing rule: this skill is read-only. If a fix is obvious, record it
as a disposition or handoff target (`implementation` for parent-owned edits,
`worker` for delegated patch work). Do not mutate files from review.

### Phase 5: Emit findings-first output

Produce `review_findings`, `review_report`, `merge_decision`.

## Invariants

- `invariants/review-lane-rules.md` — Canonical lane activation, lane outcome
  schema, secret exposure gate, and merge-decision synthesis rules. Use
  host-provided output when available; otherwise apply the invariant manually
  without crossing the read-only boundary.

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

## Red Flags — STOP

If you catch yourself thinking any of these, STOP:

- "The code looks clean" — without checking behavior risk
- "Style issues are the main problem" — while skipping correctness
- "Merge is safe" — without evidence from every activated lane
- "This lane has no findings" — when you didn't actually run the lane
- "The disagreement isn't important" — if two lanes disagree, keep it visible
- "I'll just fix it while reviewing" — fixes must be routed, not applied here
- "Scope drift is fine because the code is better" — unplanned scope is a review finding

## Common Rationalizations

See `references/rationalizations.md` for the anti-pattern table.

## Concrete Example

See `references/example.md` for the grounded example output shape.

## Handoff Expectations

- `review_findings` ordered from highest to lowest value. May be empty when all
  lanes clear — do not invent findings to pad output.
- `review_report` records activated lanes, activation basis, blind spots, and
  precedent consult status.
- `merge_decision` matches the findings. Never a detached summary label.
- Fixes are never applied by this skill. They are handed off with enough context
  for implementation or a patch worker to act.

## Stop Conditions

- There is no concrete review target
- Verification evidence is too weak to support a merge decision
- The real work is debugging or repository analysis
- Scope drift makes the target no longer match the plan being reviewed
- Any activated lane, secret scan, or hard-stop gate is missing
