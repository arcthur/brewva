---
name: self-improve
description: Distill recurring failures, weak heuristics, or loop friction into
  explicit improvement hypotheses and evidence-backed follow-up changes.
stability: experimental
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

# Self Improve Skill

## Intent

Turn repeated mistakes, stuck loops, or review friction into explicit learning
loops instead of one-off observations.

Use the helper scripts when they help with workspace learning hygiene, but
build the hypothesis from durable evidence first. That evidence may come from
review artifacts, runtime traces, or lineage-scoped iteration facts.

## Trigger

Use this skill when:

- the same failure pattern keeps recurring
- review findings reveal a systemic weakness
- runtime forensics show repeated operational waste
- a bounded loop keeps failing to improve, regressing guard checks,
  escalating, or stalling for the same reason

## Workflow

### Step 1: Collect repeated signals with bounded evidence

Identify patterns across reviews, runtime traces, failure artifacts, or
iteration-fact history.

When the learning target spans scheduled inherited runs:

- query `iteration_fact` across the control-plane lineage view for the inherited run family
- narrow with `source = "goal-loop:<loop_key>"`
- collect the concrete metric and guard records before naming a system lesson
- use explicit reports, handoff artifacts, or verification outcomes for
  disposition context instead of inventing planner-state facts

Treat the evidence as clustered signals, not as one undifferentiated pile:

- repeat findings
- repeat fact references
- repeat escalation or rollback outcomes
- repeat user or operator intervention points

### Step 2: Distill improvement candidates

Produce:

- `improvement_hypothesis`: the suspected systemic weakness
- `learning_backlog`: ranked fixes or experiments
- `improvement_plan`: the smallest next iteration to test

Each artifact must remain traceable to evidence. A convincing lesson names the
repeated pattern, the bounded evidence set, and the smallest corrective change
that can falsify or validate the hypothesis.

### Step 3: Route the lesson to the right home

Decide whether the improvement should land in:

- a public skill contract or authored-behavior section
- a project overlay or shared project rule
- runtime or tool documentation
- a small workflow or tooling improvement
- a bounded follow-up experiment instead of an immediate permanent rule

## Interaction Protocol

- Re-ground on the repeated failure pattern or recurring friction before naming
  a systemic lesson.
- Ask only when the repetition claim, scope of the learning loop, or intended
  improvement target is too weak to support a credible hypothesis.
- Do not interrupt active incident response with learning work unless the user
  explicitly wants retrospective analysis now.
- If the supposed lesson depends on one ambiguous event, say that the evidence
  is too thin rather than inflating it into a systemic story.

## Learning Protocol

- Require repetition or a clearly recurring pattern. One-off bugs are not
  automatically system lessons.
- Distinguish evidence, hypothesis, and intervention. The fact that something
  hurt twice does not yet prove the root process flaw.
- When loop history is involved, prefer objective stuck signals over narrative
  memory: flat metric streaks, guard flakiness, repeated escalations, and
  repeated verification failures are stronger than "it felt stuck".
- Prefer the smallest next improvement that can validate the hypothesis instead
  of proposing broad architecture rewrites.
- Every systemic claim should point back to concrete fact references, report
  ids, or runtime evidence anchors.
- Route high-value improvements toward the right home: skill instructions,
  shared project rules, runtime docs, or targeted tooling.
- No broad remediation without bounded evidence. If the evidence is narrow, the
  improvement should stay narrow too.

## Handoff Expectations

- `improvement_hypothesis` should name the recurring weakness, the evidence for
  repetition, and why it is systemic rather than isolated.
- `learning_backlog` should rank concrete fixes or experiments by leverage and
  implementation cost, with evidence references for each item.
- `improvement_plan` should define the smallest next change that can test the
  hypothesis or reduce repeated waste, plus the home where that change belongs.

## Stop Conditions

- there is only a single isolated incident
- no repeated pattern can be justified from evidence
- the real need is immediate debugging or implementation, not learning

## Anti-Patterns

- calling every bug a system-level lesson
- proposing broad rewrites without evidence of repetition
- mixing retrospective learning with immediate incident response
- turning vague dissatisfaction into a fake systemic pattern
- treating iteration-fact event kinds as if they were ordinary skill outputs
- naming a systemic failure without traceable fact or report references

## Example

Input: "We keep stalling in the same bounded loop; use the recorded iteration
facts and review artifacts to decide what protocol or catalog rule should
change."

Output: `improvement_hypothesis`, `learning_backlog`, `improvement_plan`.
