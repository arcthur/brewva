---
name: strategy-review
description: Pressure-test the wedge, scope, and product leverage before detailed
  execution planning begins.
stability: stable
selection:
  when_to_use: Use when a wedge, scope, or product leverage decision needs strategic pressure before detailed implementation planning.
  examples:
    - Pressure-test this wedge before we build it.
    - Review the scope quality and leverage here.
    - Challenge the sequencing and product value of this plan.
  phases:
    - align
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
    - skill_complete
references:
  - skills/meta/skill-authoring/references/authored-behavior.md
  - references/scope-postures.md
consumes:
  - problem_frame
  - user_pains
  - scope_recommendation
  - design_seed
  - open_questions
  - repository_snapshot
requires: []
---

# Strategy Review Skill

## The Iron Law

```
NO SCOPE DECISION WITHOUT EXPLICIT TIMING RATIONALE
```

Violating the letter of this rule is violating the spirit of this rule.

## When to Use / When NOT to Use

Use when:

- the user has a plausible wedge but scope quality is still uncertain
- a plan needs strategic pressure before implementation planning
- product value, leverage, or sequencing matters more than local technical detail

Do NOT use when:

- the request is a purely local implementation or debugging task
- the problem itself is still fuzzy (use `discovery` first)
- repository understanding is missing and blocks scope judgment (use `repository-analysis`)

## Workflow

### Phase 1: Reconstruct the bet and the clock

Restate the wedge, intended user value, and why this work matters now.

**If the timing argument is weak or absent**: Record it as a strategic risk. Do not default to "now is fine."
**If timing is clear**: Proceed to Phase 2.

### Phase 2: Pressure-test leverage and scope

Interrogate: what becomes true for the user if this lands next cycle? What stays false if it slips or narrows? Which adjacent scope is leverage versus drag?

**If no user-visible value can be articulated**: Stop. The wedge is not ready for strategy review. Return to `discovery`.
**If leverage is clear**: Proceed to Phase 3.

### Phase 3: Choose the scope posture

Decide whether scope should expand, hold, or narrow. Record an accepted /
deferred / non-goals scope ledger so downstream planning inherits the exact
decision boundary rather than a vague recommendation.

**If the scope posture cannot be justified without speculation**: Stop. Record the gap and the missing evidence.
**If posture is justified**: Proceed to Phase 4.

### Phase 4: Emit strategy artifacts

Produce `strategy_review`, `scope_decision`, `planning_posture`, and `strategic_risks`.

**If the scope decision lacks "why not larger" and "why not smaller" reasoning**: Return to Phase 3.
**If artifacts are complete**: Hand off to downstream skills.

## Decision Protocol

- Why now, specifically, rather than one cycle later?
- What becomes true for the user if this lands, and what stays false?
- Which adjacent scope adds leverage versus just adding surface area?
- If we cut this in half, what is the smallest still-credible bet?
- Is the proposed posture conservative enough, or does it assume away risk?

## Red Flags — STOP

If you catch yourself thinking any of these, STOP and return to Phase 1:

- "This is obviously important, timing doesn't need justification"
- "Bigger scope means more value"
- "I'll leave scope resolution to the design phase"
- "This sounds ambitious, so it must be high-leverage"
- "Every item in the proposal is equally important"

## Common Rationalizations

| Excuse                                            | Reality                                                                               |
| ------------------------------------------------- | ------------------------------------------------------------------------------------- |
| "The timing is obvious — we should just build it" | If you cannot articulate what changes for the user next cycle, timing is not obvious. |
| "Expanding scope captures more leverage"          | Expansion without evidence is roadmap drag, not leverage.                             |
| "Narrowing feels like giving up"                  | Narrowing to the credible bet is strategic discipline, not retreat.                   |
| "We can sort scope out during design"             | Design inherits your scope decision. Ambiguity here multiplies downstream.            |
| "The user wants all of it"                        | Wanting all of it and building all of it now are different decisions.                 |

## Concrete Example

Input: "We should add an operator timeline pane to `brewva insights`."

Output:

```json
{
  "strategy_review": "An operator timeline pane addresses real diagnosis pain, but the next-cycle bet is a read-only correlation view over `session_turn_transition`, approval receipts, and workflow posture. Full interactive recovery controls would widen scope into daemon mutation flows and should be deferred.",
  "scope_decision": "Accepted: a read-only insights timeline that correlates `session_turn_transition`, approval receipts, and workflow posture for one session. Deferred: inline recovery actions, live daemon control mutations, and multi-session comparison. Non-goals: replacing `brewva inspect`, building a new operator shell, or adding automation authoring from the pane.",
  "planning_posture": "moderate",
  "strategic_risks": [
    {
      "risk": "Timeline events feel authoritative while still omitting a needed artifact layer",
      "severity": "high",
      "mitigation": "Make source layers explicit in the view and keep links back to inspect artifacts"
    },
    {
      "risk": "Scope creeps from read-only correlation into daemon-side control mutations",
      "severity": "medium",
      "mitigation": "Keep mutation controls deferred in `scope_decision`; review gate enforces the boundary"
    },
    {
      "risk": "Timing is driven by operator pain anecdotes rather than measured usage",
      "severity": "medium",
      "mitigation": "Validate current operator diagnosis loops before expanding beyond the read-only pane"
    }
  ]
}
```

## Handoff Expectations

- `strategy_review` tells `design` what kind of bet this is, why this scope posture was chosen, and what leverage the plan must preserve.
- `scope_decision` makes accepted wedge, deferred surface, and non-goals explicit enough that downstream planning does not re-litigate them.
- `planning_posture` is conservative and explicit; `learning-research` and `design` use it to decide precedent retrieval and planning rigor.
- `strategic_risks` rank how the bet can fail, including timing, complexity, adoption, and hidden scope drag.
- The handoff includes "why not larger" and "why not smaller" reasoning so `design` inherits decision boundaries, not just conclusions.

## Stop Conditions

- The request is already a purely local implementation or debugging task.
- There is not enough context to justify any strategic posture.
- Repository understanding is still missing and blocks scope judgment.
- The wedge has no articulable user-visible value.
