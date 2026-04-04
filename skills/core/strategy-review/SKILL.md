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

## Intent

Decide whether the current idea should expand, hold, or narrow before `design`
turns it into an execution plan.

## Trigger

Use this skill when:

- the user has a plausible wedge but scope quality is still uncertain
- a plan needs strategic pressure before implementation planning
- product value, leverage, or sequencing matters more than local technical detail

## Workflow

### Step 1: Reconstruct the bet and the clock

Restate the wedge, intended user value, and why this work matters now. If the
timing argument is weak, say so explicitly instead of treating every plausible
idea as urgent.

### Step 2: Pressure-test timing, leverage, and scope

Interrogate the proposal before recommending a posture:

- what becomes true for the user if this lands in the next cycle
- what is still false if this slips or is narrowed
- which adjacent scope is genuinely leverage-bearing versus roadmap drag
- which assumptions belong to later cycles rather than this wedge

### Step 3: Choose the scope posture

Decide whether the current scope should:

- expand because leverage is obviously under-claimed
- hold because the wedge is already right-sized
- narrow because the proposed surface is too broad or premature

Make the decision explicit with an accepted / deferred / rejected scope ledger.
Do not leave downstream planning to infer which parts are merely postponed.

### Step 4: Emit strategy artifacts

Produce:

- `strategy_review`: the strategic judgment and why it is the best path now
- `scope_decision`: the recommended wedge, explicit non-goals, and sequencing
- `planning_posture`: the expected planning depth and precedent-retrieval
  posture for downstream work
- `strategic_risks`: concrete scope, adoption, and sequencing risks

## Interaction Protocol

- Ask only when the missing answer changes the wedge, timing, or strategic
  sequencing materially.
- Force "why now" into the open. If the timing rationale is fuzzy, treat that
  as a real strategic weakness, not as background noise.
- Re-ground on actual user pain and value, not on feature theater or roadmap
  inflation.
- Recommend one primary posture and one bounded alternative when ambiguity
  remains. Do not leave scope unresolved by presenting a neutral menu.

## Planning Posture Protocol

- `trivial`: only for demonstrably local follow-through with low blast radius
  and no meaningful precedent or rollout risk
- `moderate`: bounded but non-trivial work that still benefits from precedent
  lookup and explicit planning
- `complex`: multi-step or cross-boundary work where design depth and precedent
  retrieval are both expected
- `high_risk`: public surface, persisted format, security-sensitive,
  concurrency-sensitive, or operator-sensitive work where planning and review
  must widen rather than compress

## Strategy Questions

Use these questions to pressure-test the wedge:

- Why now, specifically, rather than one cycle later?
- What becomes true for the user if this lands, and what stays false?
- Which adjacent scope adds leverage versus just adding surface area?
- If we cut this in half, what is the smallest still-credible bet?

## Scope Posture Protocol

- Expand only when the broader scope clearly compounds user value without
  destroying delivery focus.
- Hold scope when the wedge is already sharp, timely, and implementation-ready.
- Narrow scope when the proposal is overbuilt, speculative, or hides the real
  learning loop behind too much surface area.
- Record accepted scope, deferred scope, and explicit non-goals separately. A
  vague "later" bucket is not a real scope decision.
- Name explicit non-goals so `design` inherits a real boundary instead of a
  vague ambition statement.
- When recommending expansion, say what must still remain out of scope so the
  next plan does not silently sprawl.

## Scope Decision Gate

- [ ] Accepted scope is explicit.
- [ ] Deferred scope is explicit.
- [ ] Non-goals are explicit.
- [ ] Timing rationale is strong enough to justify the proposed posture.

## Handoff Expectations

- `strategy_review` should tell `design` what kind of bet this is, why this
  scope posture was chosen, and what leverage the plan must preserve.
- `scope_decision` should make the in-scope wedge, deferred surface, and
  sequencing assumptions explicit enough that downstream planning does not need
  to re-litigate them.
- `planning_posture` should be conservative and explicit because
  `learning-research` and `design` use it to decide how much precedent
  retrieval and planning rigor are required.
- `strategic_risks` should rank the ways this bet can fail, including timing,
  complexity, adoption, and hidden scope drag.
- The handoff should include "why not larger" and "why not smaller" reasoning
  so `design` inherits the decision boundaries, not just the conclusion.

## Stop Conditions

- the request is already a purely local implementation or debugging task
- there is not enough context to justify any strategic posture
- repository understanding is still missing and blocks scope judgment

## Anti-Patterns

- rephrasing the request without actually choosing a scope posture
- expanding scope because a bigger idea sounds more exciting
- treating "be ambitious" as a substitute for leverage analysis
- handing `design` a brainstorm instead of a bounded strategic decision

## Example

Input: "We should add an AI inbox assistant to the product."

Output: `strategy_review`, `scope_decision`, `planning_posture`, `strategic_risks`.
