---
name: telegram
description: Design Telegram channel behavior and interactive payloads as one channel-native
  response workflow.
stability: stable
selection:
  when_to_use: Use when output is delivered in Telegram and message structure, interaction payloads, or CTA design must be channel-native.
  examples:
    - Design the Telegram message flow for this feature.
    - Prepare a Telegram-ready response with interactive actions.
    - Shape this content for Telegram delivery.
  phases:
    - align
    - execute
intent:
  outputs:
    - telegram_response_plan
    - telegram_payload
  output_contracts:
    telegram_response_plan:
      kind: text
      min_words: 3
      min_length: 18
    telegram_payload:
      kind: json
      min_keys: 1
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
    max_tool_calls: 60
    max_tokens: 120000
  hard_ceiling:
    max_tool_calls: 90
    max_tokens: 180000
execution_hints:
  preferred_tools:
    - read
  fallback_tools:
    - grep
    - look_at
    - skill_complete
references:
  - skills/meta/skill-authoring/references/authored-behavior.md
consumes:
  - structured_payload
  - review_report
requires: []
---

# Telegram Skill

## Intent

Choose the right Telegram interaction strategy and the matching payload in one pass.

## Trigger

Use this skill when:

- the output will be delivered in Telegram
- channel behavior and interactive components must stay aligned
- message density, interaction design, or CTA structure matters

## Workflow

### Step 1: Pick response strategy

Determine whether the message should be push-only, choice-driven, or workflow-guided.

### Step 2: Shape the payload

Design text structure, buttons, and interaction constraints together.

### Step 3: Emit channel artifacts

Produce:

- `telegram_response_plan`: tone, density, CTA strategy
- `telegram_payload`: channel-ready structure for the chosen interaction

## Interaction Protocol

- Re-ground on audience, urgency, and the exact action the Telegram message is
  meant to drive.
- Ask only when the target user action, safety posture, or channel constraints
  are too ambiguous to design a responsible interaction.
- Recommend one primary interaction pattern instead of offering several equally
  vague message shapes.

## Channel Questions

Use these questions to keep the payload channel-native:

- What single user action should this message optimize for?
- What decision load is realistic on a small screen with interrupted attention?
- Which step needs explicit confirmation because the action is risky?
- What information is necessary now versus better deferred to a follow-up step?

## Channel Design Protocol

- Design copy, buttons, and decision load as one unit.
- Bias toward concise, high-signal messages that survive Telegram reading
  conditions: small screens, interrupted attention, and low tolerance for dense
  menus.
- If an action is risky, make the confirmation flow explicit instead of hiding
  it in verbose text.
- Keep payload structure aligned with channel constraints rather than mirroring
  desktop or web UI habits.

## Pre-Delivery Checklist

- [ ] The primary CTA is obvious.
- [ ] The message fits interrupted mobile reading conditions.
- [ ] Risky actions use an explicit confirmation path.
- [ ] Buttons and copy support one coherent decision model.

## Handoff Expectations

- `telegram_response_plan` should explain the intended interaction posture,
  message density, and CTA strategy so downstream channel delivery stays on
  purpose.
- `telegram_payload` should be a concrete, channel-ready structure that maps the
  chosen strategy into text, buttons, and interaction flow.

## Stop Conditions

- the target channel is not Telegram
- upstream content is too ambiguous to shape into a safe interaction
- the task is really about general UX, not Telegram delivery

## Anti-Patterns

- separating channel strategy from payload generation
- mirroring desktop UX patterns without Telegram constraints
- overloading one message with too many decisions
- using channel payload structure without a clear decision model for the user

## Example

Input: "Design a Telegram admin prompt with concise copy and two-step confirmation buttons."

Output: `telegram_response_plan`, `telegram_payload`.
