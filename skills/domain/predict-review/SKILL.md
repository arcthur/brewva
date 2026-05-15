---
name: predict-review
description: Multi-perspective advisory review for hard problems before choosing
  the next action.
stability: experimental
selection:
  when_to_use: Use when a hard problem needs multi-perspective advisory review and explicit disagreement before choosing the next action.
intent:
  outputs:
    - perspective_findings
    - debate_summary
    - ranked_hypotheses
  output_contracts:
    perspective_findings:
      kind: json
      min_items: 1
    debate_summary:
      kind: json
      min_items: 3
    ranked_hypotheses:
      kind: json
      min_items: 1
effects:
  allowed_effects:
    - workspace_read
    - runtime_observe
    - delegation
  denied_effects:
    - workspace_write
    - local_exec
resources:
  default_lease:
    max_tool_calls: 90
    max_tokens: 170000
  hard_ceiling:
    max_tool_calls: 130
    max_tokens: 230000
execution_hints:
  preferred_tools:
    - read
    - subagent_fanout
  fallback_tools:
    - subagent_run
    - read_spans
    - grep
    - task_view_state
references:
  - references/perspectives.md
  - references/example.md
  - references/rationalizations.md
invariants:
  - invariants/debate-setup.md
consumes:
  - design_spec
  - change_set
  - review_report
  - verification_evidence
  - runtime_trace
---

# Predict Review Skill

## The Iron Law

```
NO ADVISORY CONSENSUS WITHOUT EXPLICIT DISAGREEMENT CHECK
```

## When to Use

- A complex problem has multiple plausible explanations
- A one-pass review is likely to miss architecture, security, or reliability trade-offs
- Explicit disagreement must be surfaced before choosing the next owner
- A bounded loop keeps failing and needs competing explanations

## When NOT to Use

- The next step is already obvious and low risk
- There is no concrete target to analyze
- The work needs implementation, not read-only judgment
- The debate would only restate one obvious conclusion

## Workflow

### Phase 1: Frame the review target

Name the exact target, scope, and decision the debate is meant to inform.
Apply `invariants/debate-setup.md` with the setup conditions.

**If the invariant returns `ready: false`**: Stop. Resolve every item in
`blocking` before proceeding. Do not skip validation.
**If ready**: Proceed to Phase 2.

### Phase 2: Run independent first-pass analysis

Use `subagent_fanout` when perspectives can run independently. Each must
return concrete claims, evidence anchors, and confidence — not brainstorming.
Perspective-to-profile mapping lives in `references/perspectives.md`. Select
at least two. Include Devil's Advocate when three or more are active.

**If a perspective returns without concrete claims**: Discard and re-run with
a tighter objective.
**If all return substantive findings**: Proceed to Phase 3.

### Phase 3: Force structured challenge

Independent analysis first. Debate second. Require:

1. Each perspective states its primary claim and strongest evidence.
2. Each perspective names at least one uncertainty or evidence gap.
3. Devil's Advocate challenges the majority position explicitly.
4. Unresolved objections stay visible — do not smooth them away.

Optional: run an empirical verifier pass through `subagent_run` to break the leading hypothesis.

**If majority agreement forms with no recorded dissent**: Stop. The Iron Law
is violated. Force explicit disagreement.
**If disagreements are preserved**: Proceed to Phase 4.

### Phase 4: Emit advisory artifacts

- `perspective_findings`: per-perspective claims, evidence, and disagreements
- `debate_summary`: converged points, unresolved conflicts, missing evidence
- `ranked_hypotheses`: ordered hypotheses with rationale, validation steps,
  and falsification conditions

**If `ranked_hypotheses` lacks falsification conditions**: Return to Phase 3.

## Invariants

- `invariants/debate-setup.md` — Input: setup conditions JSON.
  Output: `{"ready": bool, "blocking": [str]}`. Run before Phase 2.

## Decision Protocol

- What is the strongest claim each perspective can actually support?
- What evidence gap, if closed, would most likely reorder the hypotheses?
- What is the strongest challenge to the emerging majority view?
- Which disagreement is substantive enough that downstream must see it?

## Red Flags — STOP

If you catch yourself thinking any of these, STOP and return to Phase 1:

- "All perspectives basically agree"
- "The Devil's Advocate has nothing substantive to add"
- "We can skip the disagreement check — the answer is clear"
- "One more perspective will settle this"
- "The minority view isn't worth recording"

## Common Rationalizations

See `references/rationalizations.md` for the anti-pattern table.

## Concrete Example

See `references/example.md` for the grounded example output shape.

## Handoff Expectations

- `perspective_findings`: perspective, profile, claim, evidence, and conflicts.
- `debate_summary`: converged claims, unresolved disagreements, missing evidence.
- `ranked_hypotheses`: actionable by next owner with rationale, validation
  steps, and falsification conditions.

## Stop Conditions

- There is no bounded review target
- The debate would only restate one obvious conclusion
- Required evidence is missing and no useful advisory judgment can be made
