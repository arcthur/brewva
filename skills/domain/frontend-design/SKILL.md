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
      kind: json
      required_fields:
        - layout
        - hierarchy
        - state_behavior
        - density
        - breakpoints
      field_contracts:
        layout:
          kind: text
          min_words: 4
          min_length: 24
        hierarchy:
          kind: text
          min_words: 4
          min_length: 24
        state_behavior:
          kind: json
          required_fields:
            - loading
            - empty
            - error
        density:
          kind: text
          min_words: 3
          min_length: 18
        breakpoints:
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
  fallback_tools:
    - look_at
    - grep
references:
  - references/bento-paradigm.md
  - references/creative-arsenal.md
  - references/example.md
  - references/rationalizations.md
consumes:
  - design_spec
  - browser_observations
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

### Phase 0: Lock direction and evidence

Name the visual direction in one sentence before specifying layout. The
direction must be tied to the user moment, not to generic adjectives.

Check source evidence in this order:

1. Existing app screens, components, tokens, and nearby product surfaces.
2. Source repository examples or fixtures that show how this product already
   expresses hierarchy, density, empty states, and controls.
3. Provided screenshots or `browser_observations`.

**If no visual evidence exists and the surface is not greenfield**: Stop or
request screenshot/context handoff. Do not invent a detached style.

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

### Phase 3: Iterate against visual evidence

Compare the direction against screenshot or source-repo evidence. Call out what
must remain, what can change, and what would look imported from another app.

Run an aesthetic review before writing final artifacts:

- first-second hierarchy is obvious
- spacing, density, and contrast match the product surface
- controls look usable, not decorative
- mobile and desktop breakpoints preserve the same priority order
- no generic "AI app" tropes, ornamental gradients, or card grids unless the
  product already uses them for a reason

**If the direction fails this review**: Revise the direction before proceeding.

### Phase 4: Specify state behavior and implementation detail

For every significant view, specify: loading, empty, error, success, and
any intermediate transition states. Define motion intent or explicitly omit it.

**If a state or breakpoint behavior cannot be specified without more product
input**: Record the gap and proceed with what is concrete. Do not fill gaps
with generic patterns.
**If complete**: Proceed to Phase 5.

### Phase 5: Emit design artifacts

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
- What screenshot or source-repo evidence proves this direction belongs here?
- Would this still look intentional with real data, empty data, and narrow
  viewport constraints?

## Red Flags — STOP

If you catch yourself thinking any of these, STOP and return to Phase 1:

- "Clean and modern with good spacing"
- "Standard card layout with hover effects"
- "We can figure out the states during implementation"
- "This follows common UI patterns"
- "Nice polish pass at the end"
- "I do not need a screenshot; the layout is obvious"
- "A generic SaaS dashboard pattern is close enough"

## Common Rationalizations

See `references/rationalizations.md` for the anti-pattern table.

## Concrete Example

See `references/example.md` for the grounded example output shape.

## Handoff Expectations

- `ui_direction` should capture the visual thesis, interaction posture, and the
  product feeling implementation must preserve. It is not a mood board.
- `ui_spec` should be concrete enough that implementation can build the screen
  or component without reinventing layout, hierarchy, or state transitions.
- The handoff should state the locked direction, screenshot/source evidence
  used, and any aesthetic risks implementation must preserve or revisit.

## Stop Conditions

- The request is pure implementation with no design ambiguity
- The surface already has a locked design system answer
- The real blocker is missing product or repository context, not design
- The spec is complete: hierarchy, states, density, and breakpoints are all
  specified
