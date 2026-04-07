---
name: self-improve
description: Distill recurring failures, weak heuristics, or loop friction into
  explicit improvement hypotheses and evidence-backed follow-up changes.
stability: experimental
selection:
  when_to_use: Use when recurring failures or loop friction should be turned into concrete heuristics, guardrails, or process changes.
  examples:
    - Turn this repeated failure into a better heuristic.
    - Why does this loop keep failing and how should we improve it?
    - Capture the systemic fix for this recurring weakness.
  phases:
    - blocked
    - verify
    - done
intent:
  outputs:
    - improvement_hypothesis
    - learning_backlog
    - improvement_plan
  output_contracts:
    improvement_hypothesis:
      kind: text
      min_words: 3
      min_length: 18
    learning_backlog:
      kind: json
      min_items: 1
    improvement_plan:
      kind: text
      min_words: 3
      min_length: 18
effects:
  allowed_effects:
    - workspace_read
    - local_exec
    - memory_write
  denied_effects:
    - workspace_write
resources:
  default_lease:
    max_tool_calls: 80
    max_tokens: 150000
  hard_ceiling:
    max_tool_calls: 120
    max_tokens: 210000
execution_hints:
  preferred_tools:
    - read
    - iteration_fact
    - grep
  fallback_tools:
    - ledger_query
    - tape_search
    - cost_view
    - task_view_state
    - exec
    - process
    - skill_complete
references:
  - skills/meta/skill-authoring/references/authored-behavior.md
  - references/promotion-targets.md
  - references/stuck-signals.md
scripts:
  - scripts/activator.sh
  - scripts/error-detector.sh
  - scripts/extract-skill.sh
  - scripts/promote.sh
  - scripts/review.sh
  - scripts/setup.sh
consumes:
  - review_report
  - retro_findings
  - ship_report
  - runtime_trace
  - artifact_findings
requires: []
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
**If evidence is available**: Proceed to Phase 2.

### Phase 2: Distill improvement candidates

Produce:

- `improvement_hypothesis`: the suspected systemic weakness, naming the repeated
  pattern, bounded evidence set, and smallest corrective change
- `learning_backlog`: ranked fixes or experiments with evidence references
- `improvement_plan`: smallest next iteration to test the hypothesis

**If the hypothesis cannot name specific evidence anchors**: Stop. Return to
Phase 1 and collect more data.

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

## Red Flags — STOP

If you catch yourself thinking any of these, STOP and return to Phase 1:

- "This feels like a systemic problem" (without naming 2+ occurrences)
- "The architecture needs a broad rewrite based on this incident"
- "This is obviously a pattern, no need to find more evidence"
- "Let me propose the fix during this active incident"

## Common Rationalizations

| Excuse                                              | Reality                                                                   |
| --------------------------------------------------- | ------------------------------------------------------------------------- |
| "One bad incident proves a systemic flaw"           | One incident is a data point, not a pattern. Require repetition.          |
| "Broad rewrite prevents future failures"            | Narrow, evidence-scoped fixes validate faster and break less.             |
| "The pattern is obvious from context"               | Obvious patterns still need traceable evidence anchors.                   |
| "Learning work can interrupt incident response"     | Active incidents need fixes, not retrospectives. Sequence matters.        |
| "Iteration-fact events are just like skill outputs" | Fact events have different semantics — do not treat them interchangeably. |

## Concrete Example

Input: "The same bounded loop has stalled 3 times on guard-check regression. Use
iteration facts and review artifacts to decide what should change."

Output:

```json
{
  "improvement_hypothesis": {
    "pattern": "Guard-check regression after metric improvement",
    "occurrences": 3,
    "evidence": [
      {
        "source": "goal-loop:perf-opt",
        "iteration": 4,
        "fact": "guard_regressed",
        "metric": "p95_latency"
      },
      {
        "source": "goal-loop:perf-opt",
        "iteration": 7,
        "fact": "guard_regressed",
        "metric": "p95_latency"
      },
      {
        "source": "goal-loop:perf-opt",
        "iteration": 11,
        "fact": "guard_regressed",
        "metric": "p95_latency"
      }
    ],
    "root_cause": "Optimization steps do not run guard checks before committing, only after. Regressions are detected one iteration late."
  },
  "learning_backlog": [
    {
      "rank": 1,
      "fix": "Add pre-commit guard check to goal-loop optimization phase",
      "effort": "small",
      "evidence_refs": ["iter-4", "iter-7", "iter-11"]
    },
    {
      "rank": 2,
      "fix": "Add guard-regression counter to loop exit criteria",
      "effort": "medium",
      "evidence_refs": ["iter-7", "iter-11"]
    }
  ],
  "improvement_plan": "Add pre-commit guard check in goal-loop skill Phase 3. Target home: skills/domain/goal-loop/SKILL.md. Falsification: if next 3 iterations show zero guard regressions, the fix is validated."
}
```

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

Violating the letter is violating the spirit.
