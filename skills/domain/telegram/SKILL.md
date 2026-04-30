---
name: telegram
description: Telegram-native delivery guidance for message structure,
  interaction payloads, and CTAs.
stability: stable
selection:
  when_to_use: Use when output is delivered in Telegram and message structure, interaction payloads, or CTA design must be channel-native.
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
consumes:
  - structured_payload
  - review_report
references:
  - references/example.md
  - references/rationalizations.md
invariants:
  - invariants/payload-constraints.md
---

# Telegram Skill

## The Iron Law

```
NO TELEGRAM PAYLOAD WITHOUT CONSTRAINT VALIDATION
```

## When to Use

- The output will be delivered in Telegram
- Channel behavior and interactive components must stay aligned
- Message density, interaction design, or CTA structure matters

## When NOT to Use

- The target channel is not Telegram
- The task is general UX design, not Telegram-specific delivery
- Upstream content is too ambiguous to shape into a safe interaction
- The payload is purely server-side with no user-facing message

## Workflow

### Phase 1: Pick response strategy

Determine whether the message should be `push_only`, `choice_driven`, or `workflow_guided`.

**If the intended user action is unclear**: Ask the user. Do not guess the interaction pattern.
**If clear**: Proceed to Phase 2.

### Phase 2: Shape the payload

Design text, buttons, and interaction constraints together as one unit.

**If text exceeds 4096 chars or buttons exceed API limits**: Restructure. Do not truncate silently.
**If the decision load exceeds what a small screen can handle**: Split into steps.
**If shaped**: Proceed to Phase 3.

### Phase 3: Validate constraints

Apply `invariants/payload-constraints.md` to the draft payload.

**If `valid` is false**: Fix every error before proceeding. Do not ship invalid payloads.
**If warnings exist**: Evaluate each. Near-limit text is a design smell.
**If valid**: Proceed to Phase 4.

### Phase 4: Emit channel artifacts

Produce:

- `telegram_response_plan`: tone, density, CTA strategy, and intended user action
- `telegram_payload`: channel-ready JSON structure validated against API constraints

## Invariants

- `invariants/payload-constraints.md` — Input: JSON with `text`, `buttons`,
  `parse_mode`. Output: JSON with `valid`, `errors`, `warnings`. Apply at
  Phase 3 before emitting the final payload.

## Decision Protocol

- What single user action should this message optimize for?
- What decision load is realistic on a small screen with interrupted attention?
- Which step needs explicit confirmation because the action is risky?
- What information is necessary now versus better deferred to a follow-up?
- Is the button grid serving the user's decision or the developer's convenience?

## Red Flags — STOP

If you catch yourself thinking any of these, STOP and return to Phase 1:

- "This is fine, it's only slightly over the limit"
- "Users can scroll, so longer text is okay"
- "I'll add all the options as buttons and let the user pick"
- "Skip validation, the payload looks right"
- "Desktop-style menu will work on mobile too"

## Common Rationalizations

See `references/rationalizations.md` for the anti-pattern table.

## Concrete Example

See `references/example.md` for the grounded example output shape.

## Handoff Expectations

- `telegram_response_plan` explains the intended interaction posture, message density, and CTA strategy so downstream channel delivery stays on purpose.
- `telegram_payload` is a concrete, channel-ready structure that maps the chosen strategy into text, buttons, and interaction flow — validated against Telegram API constraints.

## Stop Conditions

- The target channel is not Telegram
- Upstream content is too ambiguous to shape into a safe interaction
- The task is really about general UX, not Telegram delivery
- API constraint validation fails and the payload cannot be restructured within limits
