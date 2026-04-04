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

## Intent

Turn product intent into a clear UI direction that implementation can execute without generic drift.

## Trigger

Use this skill when:

- a frontend feature needs visual or interaction design
- existing UI needs stronger hierarchy, clarity, or personality
- implementation needs a UI-specific spec instead of generic prose

## Workflow

### Step 1: Read the product context

Identify user goal, surface, and design system constraints.

### Step 2: Choose a visual and interaction direction

Define hierarchy, state changes, and layout behavior.

### Step 3: Emit design artifacts

Produce:

- `ui_direction`: visual thesis and interaction posture
- `ui_spec`: structure, state behavior, and implementation-critical details

## Interaction Protocol

- Re-ground on the product goal, user moment, and existing visual language
  before proposing a new direction.
- Ask only when the design system constraints, target surface, or product intent
  are too ambiguous to support a confident recommendation.
- Recommend one clear direction instead of presenting several interchangeable UI
  moods.

## Design Questions

Use these questions to keep the design concrete:

- What user moment is under the most pressure here?
- What should be visually obvious in the first second?
- Which state transitions or feedback moments carry the most product risk?
- What existing product language must remain intact so the output does not feel
  imported from another app?
- What implementation detail must be specified now to prevent generic drift
  later?

## Design Protocol

- Start from user goal and interaction pressure, not from aesthetics in
  isolation.
- Define hierarchy, density, state behavior, and motion as one system.
- Avoid generic polish language. If a choice matters, say what it should look
  like, how it should behave, and what problem it solves.
- When the product already has a strong design language, extend it instead of
  showing off novelty for its own sake.

## Handoff Expectations

- `ui_direction` should capture the visual thesis, interaction posture, and the
  product feeling implementation must preserve.
- `ui_spec` should be concrete enough that implementation can build the screen
  or component without reinventing layout, hierarchy, or state transitions.

## Pre-Delivery Checklist

- [ ] Primary hierarchy and focal action are explicit.
- [ ] Loading, empty, error, and success states are specified when relevant.
- [ ] Motion guidance is intentional or explicitly omitted.
- [ ] Layout, density, and breakpoint-sensitive behavior are concrete enough for
      implementation.
- [ ] The output avoids generic polish language and names what the UI should do.

## Stop Conditions

- the request is pure implementation with no design ambiguity
- the surface already has a locked design system answer
- the real blocker is missing product or repository context

## Anti-Patterns

- defaulting to generic UI patterns with no point of view
- describing aesthetics without state behavior
- ignoring existing product language when working inside an established surface
- treating component names as a substitute for real visual direction

## Example

Input: "Define the v2 catalog page UI for skills taxonomy and routing profiles."

Output: `ui_direction`, `ui_spec`.
