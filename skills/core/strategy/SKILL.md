---
name: strategy
description: Pressure-test the wedge, scope, and product leverage before detailed
  execution planning begins.
stability: stable
selection:
  when_to_use: Use when a wedge, scope, or product leverage decision needs strategic pressure before detailed implementation planning.
intent:
  outputs:
    - strategy_review
    - scope_decision
    - planning_posture
    - strategic_risks
  output_contracts:
    strategy_review:
      kind: text
      min_words: 3
      min_length: 18
    scope_decision:
      kind: text
      min_words: 3
      min_length: 18
    planning_posture:
      kind: enum
      values:
        - trivial
        - moderate
        - complex
        - high_risk
    strategic_risks:
      kind: json
      min_items: 1
effects:
  allowed_effects:
    - workspace_read
    - runtime_observe
  denied_effects:
    - workspace_write
    - local_exec
resources:
  default_lease:
    max_tool_calls: 70
    max_tokens: 140000
  hard_ceiling:
    max_tool_calls: 110
    max_tokens: 200000
execution_hints:
  preferred_tools:
    - read
    - grep
  fallback_tools:
    - ledger_query
references:
  - references/scope-postures.md
  - references/example.md
  - references/rationalizations.md
consumes:
  - office_hours_brief
  - premise_challenge
  - approach_options
  - next_assignment
  - problem_frame
  - user_pains
  - scope_recommendation
  - design_seed
  - open_questions
  - repository_snapshot
---

# Strategy Skill

## The Iron Law

```
NO SCOPE DECISION WITHOUT EXPLICIT TIMING RATIONALE
```

## When to Use / When NOT to Use

Use when:

- the user has a plausible wedge but scope quality is still uncertain
- a plan needs strategic pressure before implementation planning
- product value, leverage, or sequencing matters more than local technical
  detail

Do NOT use when:

- the request is a purely local implementation or debugging task
- the idea is upstream and still lacks demand, target human, status quo, or a
  plausible wedge (use `office-hours` first)
- the problem itself is still fuzzy inside an existing request (use `discovery`
  first)
- repository understanding is missing and blocks scope judgment (use
  `repository-analysis`)

## Workflow

### Question Escalation Rule

- If scope posture depends on a missing operator decision and the current turn
  cannot justify a strategy posture without it, use the `question` tool.
- Record uncertainty in `strategic_risks` only when it is non-blocking for the
  current turn's recommendation.
- Do not convert a blocking scope ambiguity into vague prose and call it
  strategic judgment.

### Phase 1: Reconstruct the bet and the clock

Restate the wedge, intended user value, and why this work matters now.

**If the prompt still lacks a plausible wedge, target human, status quo, or
demand evidence**: Stop. Hand off to `office-hours` for a new idea, or
`discovery` for an existing request.
**If the timing argument is weak or absent**: Record it as a strategic risk. Do
not default to "now is fine."
**If timing is clear**: Proceed to Phase 2.

### Phase 2: Pressure-test leverage and scope

Interrogate: what becomes true for the user if this lands next cycle? What
stays false if it slips or narrows? Which adjacent scope is leverage versus
drag?

**If no user-visible value can be articulated**: Stop. The wedge is not ready
for strategy review. Return to `discovery`.
**If leverage is clear**: Proceed to Phase 3.

### Phase 3: Choose the scope posture

Decide whether scope should expand, hold, or narrow. Record an accepted /
deferred / non-goals scope ledger so downstream planning inherits the exact
decision boundary rather than a vague recommendation.

**If the scope posture cannot be justified without speculation and the missing
decision blocks the current turn**: Use the `question` tool.
**If the scope posture cannot be justified without speculation but the
uncertainty is non-blocking for a conservative recommendation**: Record the gap
and the missing evidence.
**If posture is justified**: Proceed to Phase 4.

### Phase 4: Emit strategy artifacts

Produce `strategy_review`, `scope_decision`, `planning_posture`, and `strategic_risks`.

**If the scope decision lacks "why not larger" and "why not smaller"
reasoning**: Return to Phase 3.
**If artifacts are complete**: Hand off to downstream skills.

## Decision Protocol

- Why now, specifically, rather than one cycle later?
- What target human, status quo, and demand signal make this a wedge rather
  than only an idea?
- What becomes true for the user if this lands, and what stays false?
- Which adjacent scope adds leverage versus just adding surface area?
- If we cut this in half, what is the smallest still-credible bet?
- Is the proposed posture conservative enough, or does it assume away risk?

## Red Flags — STOP

If you catch yourself thinking any of these, STOP and return to Phase 1:

- "This is obviously important, timing doesn't need justification"
- "Bigger scope means more value"
- "I'll leave scope resolution to the plan phase"
- "This sounds ambitious, so it must be high-leverage"
- "Every item in the proposal is equally important"
- "We can do strategy before knowing whether there is a wedge"

## Common Rationalizations

See `references/rationalizations.md` for the anti-pattern table.

## Concrete Example

See `references/example.md` for the grounded example output shape.

## Handoff Expectations

- `strategy_review` tells `plan` what kind of bet this is, why this scope
  posture was chosen, and what leverage the plan must preserve.
- `office_hours_brief`, when present, is treated as upstream evidence for the
  wedge; strategy should not re-litigate idea worth unless the brief is weak.
- `scope_decision` makes accepted wedge, deferred surface, and non-goals
  explicit enough that downstream planning does not re-litigate them.
- `planning_posture` is conservative and explicit; `learning-research` and
  `plan` use it to decide precedent retrieval and planning rigor.
- `strategic_risks` rank how the bet can fail, including timing, complexity,
  adoption, and hidden scope drag.
- The handoff includes "why not larger" and "why not smaller" reasoning so
  `plan` inherits decision boundaries, not just conclusions.

## Stop Conditions

- The request is already a purely local implementation or debugging task.
- There is not enough context to justify any strategic posture.
- Repository understanding is still missing and blocks scope judgment.
- The wedge has no articulable user-visible value.
- The target human, status quo, or demand signal is still unknown.
