---
name: discovery
description: Reframe a request into the real problem, user pain, scope wedge, and
  design-ready starting point before execution planning begins.
stability: stable
selection:
  when_to_use: Use when the real problem, user pain, or scope wedge is still unclear and the next step should be reframing rather than execution.
  examples:
    - Clarify the real problem behind this request.
    - Help me narrow the scope and non-goals first.
    - Turn this rough idea into a crisp wedge.
  phases:
    - align
intent:
  outputs:
    - problem_frame
    - user_pains
    - scope_recommendation
    - design_seed
    - open_questions
  output_contracts:
    problem_frame:
      kind: text
      min_words: 4
      min_length: 24
    user_pains:
      kind: json
      min_items: 1
    scope_recommendation:
      kind: text
      min_words: 3
      min_length: 18
    design_seed:
      kind: text
      min_words: 3
      min_length: 18
    open_questions:
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
    - glob
    - ledger_query
    - skill_complete
references:
  - skills/meta/skill-authoring/references/authored-behavior.md
  - references/framing-patterns.md
consumes:
  - repository_snapshot
requires: []
---

# Discovery Skill

## Intent

Turn an initial request into the right problem statement before `design`
commits to an implementation path.

## Trigger

Use this skill when:

- the user has an idea but the real problem is still fuzzy
- product pain, wedge, or non-goals are unclear
- the next step should be better framing, not execution planning

## Workflow

### Step 1: Reconstruct the real problem

Identify the user pain, current workaround, and why the stated request may be a
proxy for a deeper need.

### Step 2: Challenge assumptions and scope

Separate core need, tempting overreach, and the narrowest credible wedge worth
designing now.

### Step 3: Emit design-ready artifacts

Produce:

- `problem_frame`: the reframed problem and why it matters
- `user_pains`: concrete pain points or unmet needs
- `scope_recommendation`: what to build now and what not to build yet
- `design_seed`: the minimum starting point that `design` should elaborate
- `open_questions`: unknowns that still matter before design is final

## Interaction Protocol

- Re-ground on concrete pain and user experience, not just the feature label.
- Ask only when the missing answer changes the actual problem framing or the
  recommended scope wedge.
- Recommend one primary framing and one bounded alternative when ambiguity
  remains; do not leave the user with a pile of unranked possibilities.

## Discovery Questions

Use these questions to separate the request from the real need:

- What pain is happening now, not just what feature was requested?
- What workaround already exists, and why is it insufficient?
- What is the narrowest wedge that would still change user reality?
- Which tempting scope expansion is really hiding uncertainty rather than
  leverage?

## Framing Protocol

- Distinguish stated request from underlying problem.
- Prefer the narrowest wedge that can teach something real over a broad vision
  that is impossible to validate quickly.
- Name non-goals explicitly so `design` does not silently expand the surface.
- If the request is already well framed and execution-ready, stop and hand off
  to `design` instead of inventing discovery work.

## Handoff Expectations

- `problem_frame` should give `design` a clean problem statement rather than a
  raw brainstorm transcript.
- `user_pains` should be concrete enough that downstream skills can judge tradeoffs
  against real user friction.
- `scope_recommendation` should make the recommended wedge and deferred scope
  explicit.
- `design_seed` should be the shortest useful handoff into execution planning.
- `open_questions` should include only questions that still affect design
  quality, not generic curiosity.

## Stop Conditions

- the request is already framed well enough for direct design work
- no meaningful user or operator pain can be inferred from available context
- the real blocker is repository understanding, not problem framing

## Anti-Patterns

- repeating the user request in cleaner prose without reframing it
- turning discovery into abstract product theater with no wedge recommendation
- using discovery to avoid making a scope recommendation
- slipping into execution planning that belongs to `design`

## Example

Input: "I want to build a daily briefing app for my calendar."

Output: `problem_frame`, `user_pains`, `scope_recommendation`, `design_seed`, `open_questions`.
