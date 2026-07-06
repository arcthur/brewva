---
name: self-improve
description: Distill recurring failures, weak heuristics, or loop friction into explicit improvement
  hypotheses and evidence-backed follow-up changes.
references:
  - references/promotion-targets.md
  - references/stuck-signals.md
  - references/example.md
  - references/rationalizations.md
scripts:
  - scripts/activator.sh
  - scripts/error-detector.sh
  - scripts/extract-skill.sh
  - scripts/promote.sh
  - scripts/review.sh
  - scripts/setup.sh
---

# Self Improve

## The Iron Law

```
NO SYSTEMIC CLAIM WITHOUT REPEATED EVIDENCE
```

## When to Use / When NOT to Use

Use when:

- the same failure pattern has recurred across multiple sessions or loops
- review findings reveal a systemic weakness, not a one-off bug
- runtime forensics show repeated operational waste
- a bounded loop keeps stalling, regressing, or escalating for the same reason

Do NOT use when:

- there is only a single isolated incident — route to debugging
- the need is immediate fix, not retrospective learning — route to implementation
- the "pattern" is based on feeling rather than traceable evidence
- active incident response is in progress — do not interrupt with learning work

## Workflow

### Phase 1: Collect repeated signals

Gather evidence from reviews, runtime traces, failure artifacts, or
iteration-fact history. Cluster the evidence:

- repeat findings (same failure class across sessions)
- repeat fact references (iteration_fact with `source = "goal-loop:<loop_key>"`)
- repeat escalation or rollback outcomes
- repeat operator intervention points

**If fewer than 2 independent occurrences exist**: Stop. The pattern is not
repeated. Record the single observation and exit — do not inflate it.
If this pass was triggered by scheduler policy, exit quietly rather than
creating operator-facing noise.
**If evidence is available**: Proceed to Phase 2.

### Phase 2: Distill improvement candidates

Produce:

- `improvement_hypothesis`: the suspected systemic weakness, naming the repeated
  pattern, bounded evidence set, and smallest corrective change
- `learning_backlog`: ranked fixes or experiments with evidence references
- `improvement_plan`: smallest next iteration to test the hypothesis

**If the hypothesis cannot name specific evidence anchors**: Stop. Return to
Phase 1 and collect more data.

**If the pattern recurred after a prior fix was already applied** (the same
finding, rollback, or escalation returned post-remediation): the smallest change
is being absorbed. Recurrence is evidence the fix altitude is wrong, not that the
prior fix needs another increment. Make the corrective change a targeted
structural change to the default, gate, or mechanism that keeps regenerating the
pattern — as the lead hypothesis, not a backlog item. One mechanism changed, not
a broad rewrite.

### Phase 3: Route the lesson

Decide the improvement home:

- public skill contract or authored-behavior section
- project overlay or shared project rule
- runtime or tool documentation
- bounded follow-up experiment (not an immediate permanent rule)

Run `scripts/review.sh` to check the improvement against existing patterns.
Run `scripts/promote.sh` when the improvement is validated and ready for its home.

**If the improvement home is unclear**: Propose the experiment first, not the
permanent rule. Validate before promoting.

## Scripts

- `scripts/activator.sh` — Activate the self-improve workspace learning loop.
- `scripts/error-detector.sh` — Scan artifacts for recurring error patterns.
- `scripts/extract-skill.sh` — Extract a validated improvement into skill form.
- `scripts/promote.sh` — Promote a validated improvement to its target home.
- `scripts/review.sh` — Review an improvement hypothesis against existing patterns.
- `scripts/setup.sh` — Initialize the self-improve workspace state.

## Decision Protocol

- What exactly repeated, and how many independent times?
- Is the evidence traceable to specific fact references, report IDs, or artifact paths?
- What is the smallest hypothesis that explains the repeated waste?
- Which home should absorb the fix: skill, overlay, project rule, runtime doc, or tool?
- What bounded experiment would falsify this lesson if it is wrong?
- Is the improvement narrow enough to match the evidence, or is it over-generalized?
- Did this pattern recur _after_ a prior fix was applied? If so the small fix is
  being absorbed — the lesson is a targeted structural change, not another increment.

## Red Flags — STOP

If you catch yourself thinking any of these, STOP and return to Phase 1:

- "This feels like a systemic problem" (without naming 2+ occurrences)
- "The architecture needs a broad rewrite based on this incident"
- "This is obviously a pattern, no need to find more evidence"
- "Let me propose the fix during this active incident"
- "The same kind of small fix should work, we just applied it wrong" (when the
  pattern already recurred after a prior fix — the fix altitude is wrong, go structural)

## Common Rationalizations

See `references/rationalizations.md` for the anti-pattern table.

## Concrete Example

See `references/example.md` for the grounded example output shape.

## Handoff Expectations

- `improvement_hypothesis` names the recurring weakness, evidence for repetition,
  and why it is systemic rather than isolated.
- `learning_backlog` ranks concrete fixes or experiments by leverage and cost,
  with evidence references for each item.
- `improvement_plan` defines the smallest next change to test the hypothesis,
  the home where the change belongs, and the falsification condition.

## Stop Conditions

- Fewer than 2 independent occurrences of the claimed pattern.
- No traceable evidence anchors (fact references, report IDs, artifact paths).
- The real need is immediate debugging or implementation, not learning.
- Active incident response is in progress and the operator has not requested retrospective.
