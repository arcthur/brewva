---
name: frontend-design
description: Shape UI direction, interaction structure, and visual intent for frontend
  work that needs taste and product judgment.
stability: stable
selection:
  when_to_use: Use when a frontend task needs visual direction, UI structure, or implementation-ready design guidance.
  examples:
    - Design the UI for this feature.
    - Give this screen stronger hierarchy and interaction structure.
    - Produce an implementation-ready frontend spec.
  phases:
    - align
    - investigate
intent:
  outputs:
    - ui_direction
    - ui_spec
  output_contracts:
    ui_direction:
      kind: text
      min_words: 3
      min_length: 18
    ui_spec:
      kind: text
      min_words: 4
      min_length: 24
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
  fallback_tools:
    - look_at
    - grep
    - skill_complete
references:
  - skills/meta/skill-authoring/references/authored-behavior.md
  - references/bento-paradigm.md
  - references/creative-arsenal.md
consumes:
  - design_spec
  - browser_observations
requires: []
---

# Frontend Design Skill

## The Iron Law

```
NO UI SPEC WITHOUT STATE BEHAVIOR AND HIERARCHY
```

## When to Use

- A frontend feature needs visual or interaction design before implementation
- Existing UI needs stronger hierarchy, clarity, or personality
- Implementation needs a UI-specific spec rather than generic prose directions
- A product moment carries enough ambiguity that building without direction risks generic drift

## When NOT to Use

- The request is pure implementation with no design ambiguity
- The surface already has a locked design system answer that only needs wiring
- The real blocker is missing product context, not missing visual direction
- The task is component refactoring with no user-facing behavior change

## Workflow

### Phase 1: Read the product context

Identify the user goal, surface, interaction moment, and design system
constraints already in play.

**If the product goal or user moment is too vague to support a confident
direction**: Stop. Ask for the missing context. Do not invent product intent.
**If clear**: Proceed to Phase 2.

### Phase 2: Choose a visual and interaction direction

Define hierarchy, focal action, state transitions, density, and layout
behavior as one system. Prefer one clear direction over several interchangeable
UI moods.

**If the surface has an existing design language**: Extend it. Do not import a
new visual identity without justification.
**If greenfield**: State the visual thesis and the product feeling it serves.
Proceed to Phase 3.

### Phase 3: Specify state behavior and implementation detail

For every significant view, specify: loading, empty, error, success, and
any intermediate transition states. Define motion intent or explicitly omit it.

**If a state or breakpoint behavior cannot be specified without more product
input**: Record the gap and proceed with what is concrete. Do not fill gaps
with generic patterns.
**If complete**: Proceed to Phase 4.

### Phase 4: Emit design artifacts

Produce:

- `ui_direction`: visual thesis, interaction posture, and the product feeling
  implementation must preserve
- `ui_spec`: structure, hierarchy, state behavior, density, breakpoints, and
  implementation-critical details

**If the spec lacks state behavior or hierarchy**: Return to Phase 3. The Iron
Law applies.

## Decision Protocol

- What user moment is under the most pressure here?
- What should be visually obvious in the first second?
- Which state transitions or feedback moments carry the most product risk?
- What existing product language must remain intact so the output does not
  feel imported from another app?
- What implementation detail must be specified now to prevent generic drift?

## Red Flags — STOP

If you catch yourself thinking any of these, STOP and return to Phase 1:

- "Clean and modern with good spacing"
- "Standard card layout with hover effects"
- "We can figure out the states during implementation"
- "This follows common UI patterns"
- "Nice polish pass at the end"

## Common Rationalizations

| Excuse                           | Reality                                                                                                 |
| -------------------------------- | ------------------------------------------------------------------------------------------------------- |
| "States can be added later"      | Missing state specs are the top cause of generic fallback during implementation. Specify them now.      |
| "The design system handles this" | Design systems handle components, not product moments. The hierarchy and behavior still need direction. |
| "Keep it clean and minimal"      | "Clean" is not a direction. Name what is visible, what is hidden, and why.                              |
| "Standard pattern works here"    | Standard patterns are defaults, not decisions. State why this pattern fits this moment.                 |
| "Polish pass later"              | Polish language defers decisions. Specify the concrete visual and interaction behavior now.             |

## Concrete Example

Input: "Define the v2 catalog page UI for skills taxonomy and routing profiles."

Output:

```
ui_direction:
  The catalog is a workspace tool, not a storefront. Visual weight goes to the
  skill name, stability badge, and phase tags — the three things an operator
  scans when choosing a skill. Routing profiles are secondary metadata, shown
  inline but never competing with the skill identity. The page should feel
  dense and scannable, like a well-organized reference table, not a marketing
  grid. No cards. Use a compact list with inline expansion for details.

ui_spec:
  layout: single-column compact list, 720px max content width
  primary_row: [stability_badge, skill_name, phase_tags] — left-aligned,
    single line, 14px/600 name, 12px/400 tags
  expansion: click row to expand inline panel showing description,
    output_contracts summary, routing_profile, and references
  states:
    loading: skeleton rows matching primary_row shape, 8 rows
    empty: centered text "No skills match the current filter" with
      reset-filter link
    error: inline banner above list, "Failed to load catalog — retry" with
      action button
    filtered: active filter chips above list with clear-all action
  breakpoints:
    <640px: phase_tags wrap below skill_name, stability_badge stays inline
    >=1024px: optional second column for routing_profile summary without
      expansion
  motion: expand/collapse is 150ms ease-out height transition, no other
    animation
```

## Handoff Expectations

- `ui_direction` should capture the visual thesis, interaction posture, and the
  product feeling implementation must preserve. It is not a mood board.
- `ui_spec` should be concrete enough that implementation can build the screen
  or component without reinventing layout, hierarchy, or state transitions.

## Stop Conditions

- The request is pure implementation with no design ambiguity
- The surface already has a locked design system answer
- The real blocker is missing product or repository context, not design
- The spec is complete: hierarchy, states, density, and breakpoints are all
  specified

Violating the letter of these rules is violating the spirit of these rules.
