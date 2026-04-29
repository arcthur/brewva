---
name: architecture
description: Find deepening opportunities in a codebase by assessing module depth,
  interface burden, seam placement, locality, leverage, and testability before
  implementation planning.
stability: stable
selection:
  when_to_use: Use when a task asks for architecture improvement, refactoring opportunities, shallow module detection, seam quality, testability improvement, or AI-navigability of a codebase.
  examples:
    - Find the highest-leverage architecture improvements in this repository.
    - Identify shallow modules and better seams before we plan implementation.
    - Improve this codebase's testability and AI navigability through deeper modules.
  phases:
    - align
    - investigate
intent:
  outputs:
    - architecture_assessment
    - deepening_opportunities
    - interface_exploration_brief
  output_contracts:
    architecture_assessment:
      kind: text
      min_words: 8
      min_length: 48
    deepening_opportunities:
      kind: json
      min_items: 1
    interface_exploration_brief:
      kind: text
      min_words: 8
      min_length: 48
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
    max_tool_calls: 100
    max_tokens: 180000
  hard_ceiling:
    max_tool_calls: 150
    max_tokens: 260000
execution_hints:
  preferred_tools:
    - read
    - grep
    - subagent_fanout
  fallback_tools:
    - glob
    - lsp_symbols
    - lsp_find_references
    - ledger_query
references:
  - references/language.md
  - references/deepening.md
  - references/interface-exploration.md
  - references/rationalizations.md
consumes:
  - repository_snapshot
  - impact_map
  - planning_posture
  - problem_frame
  - scope_recommendation
  - strategy_review
  - retro_findings
  - review_findings
composable_with:
  - repository-analysis
  - learning-research
  - plan
---

# Architecture Skill

## The Iron Law

```
NO DEEPENING OPPORTUNITY WITHOUT A NAMED MODULE, INTERFACE, AND LOCALITY GAIN
```

Every candidate names the module being deepened, the caller burden being
reduced, and the future change or bug that becomes more local.

## When to Use / When NOT to Use

Use when:

- the user asks for architecture improvement or refactoring opportunities
- a codebase feels hard to test, hard to navigate, or easy to change in the
  wrong place
- review, retro, or debugging evidence points to repeated orchestration pain
- repository analysis has mapped the hot path but not the quality of the seams

Do NOT use when:

- the task only needs a path-grounded map (use `repository-analysis`)
- the task needs product scope or timing pressure (use `strategy`)
- the task already has a chosen architecture and needs an executable plan (use
  `plan`)
- the task is a diff risk review (use `review`)
- the requested work is a local code change with no architecture decision

## Workflow

### Phase 1: Load the architecture language

Read `references/language.md` and use its vocabulary: module, interface,
implementation, depth, seam, adapter, leverage, and locality. Avoid vague
labels such as "component", "service", or "API" unless quoting project code.

Use local project context when present: repository guidance, decision records,
`docs/solutions/**`, and consumed repository/review/retro artifacts. If absent,
proceed silently; do not invent context or block only because a context file is
missing.

**If the hot path is unknown**: Stop and hand off to `repository-analysis`
instead of doing architecture judgment from directory names.

### Phase 2: Explore friction, not directories

Follow the code paths where a maintainer must understand too many details to
make one change. Use `references/deepening.md` for friction signals, rejection
criteria, dependency categories, and candidate shape.

Use optional delegation only for broader scans or competing interpretations.
The final claim still needs path-grounded evidence in the parent skill output.

**If friction cannot be tied to caller burden**: Reject the candidate and keep
exploring. File size, churn, or naming discomfort is not enough.

### Phase 3: Apply the deletion test

For each candidate module, ask:

- If this module disappeared, would the complexity disappear too?
- Or would the same knowledge reappear across several callers?

Reject pass-through modules where deletion simply removes a layer. Keep
candidates where deletion would scatter domain rules, dependency orchestration,
or test setup across call sites.

**If the deletion test fails**: Do not list the candidate as a deepening
opportunity.

### Phase 4: Classify dependencies and test surface

Classify the dependency category with `references/deepening.md`. Treat the
interface as the test surface: tests should assert observable behavior through
the deepened module, not pin internal helpers, ordering, or adapters.

**If tests need a new production-irrelevant hook**: Reconsider seam placement
before presenting the candidate.

### Phase 5: Present deepening opportunities before interface proposals

Emit `architecture_assessment` and `deepening_opportunities` as numbered
candidates using the candidate shape in `references/deepening.md`.

Stop after candidates unless the user has already selected one. Do not jump
straight into implementation planning.

**If no candidate has locality gain and caller-burden reduction**: Emit the
assessment and stop without forcing a weak opportunity.

### Phase 6: Frame a selected candidate for planning

When the user selects a candidate, produce `interface_exploration_brief` before
handoff to `plan`. This brief pressures the interface; it does not choose the
final plan. Use `references/interface-exploration.md` for required brief fields
and optional design-it-twice protocol. Delegation can help produce competing
options, but this skill must still work without delegation.

**If interface choice depends on trade-offs, rollout cost, or owner preference**:
Do not pick a winner here. Hand off the sketches and decision criteria to
`plan`.

## Decision Protocol

- What module is being deepened, and where is its interface today?
- What must callers currently know that should become implementation detail?
- Does the deletion test prove this module earns its place?
- Is the proposed seam real, or just a hypothetical seam with one behavior?
- Which dependency category makes this refactor easy, risky, or premature?
- What tests become simpler or more durable if this interface becomes the test
  surface?
- What project decision or invariant would this architecture change challenge?

## Red Flags - STOP

If you catch yourself thinking any of these, stop and return to Phase 2:

- "This file is big, so it needs an abstraction"
- "A new interface would be cleaner" without naming caller burden
- "This seam is useful someday" with only one concrete behavior today
- "We can test it by exposing the internal helper"
- "The module is deep because the implementation is complicated"
- "This is architecture because it crosses many files"

## Common Rationalizations

See `references/rationalizations.md` for the anti-pattern table.

## Handoff Expectations

Hand off to `plan` after one deepening candidate has been selected and the
`interface_exploration_brief` names the interface sketches, constraints, and
decision criteria that `plan` must resolve.

Hand off to `repository-analysis` when the hot path is unknown, and to
`learning-research` when precedent may overturn the candidate. Recommend
`knowledge-capture` only after validation; this skill does not write docs.

## Stop Conditions

- No path-grounded module evidence: stop and request or produce
  `repository_snapshot` / `impact_map`.
- No locality gain: reject the candidate.
- No caller burden reduction: reject the candidate.
- Interface choice depends on product scope or timing: hand off to `strategy`.
- Refactor plan is chosen and implementation targets are needed: hand off to
  `plan`.
