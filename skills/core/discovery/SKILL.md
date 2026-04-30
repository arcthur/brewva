---
name: discovery
description: Reframe an existing request into the real problem, user pain, scope
  wedge, and plan-ready starting point before execution planning begins.
stability: stable
selection:
  when_to_use: Use when an existing product, repository, or operator request has unclear pain or scope and needs reframing rather than idea diagnosis or execution.
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
references:
  - references/framing-patterns.md
  - references/example.md
  - references/rationalizations.md
consumes:
  - repository_snapshot
  - office_hours_brief
  - premise_challenge
  - approach_options
  - next_assignment
---

# Discovery Skill

## The Iron Law

```
NO PLAN WITHOUT A CLEAR PROBLEM FRAME FIRST
```

## When to Use / When NOT to Use

Use when:

- the user has an existing repo, product, or operator request but the real
  problem is still fuzzy
- product pain, wedge, or non-goals are unclear
- the next step should be better framing, not execution planning

Do NOT use when:

- the user brings a new product, startup, side-project, hackathon, or
  "worth building" idea before a request exists (use `office-hours`)
- the request is already a crisp, execution-ready problem statement
- the real blocker is repository understanding, not problem framing (use `repository-analysis`)
- the user is asking for implementation help on a well-defined task (use `plan`)
- the wedge is clear and the remaining question is timing, sequencing, or scope
  posture (use `strategy`)

## Workflow

### Question Escalation Rule

- If the current turn is blocked on missing operator or user input, use the `question` tool now.
- Use `open_questions` only for unresolved items that still matter for downstream plan quality but do not block the current turn.
- Do not emit `open_questions` just to satisfy formatting. An empty list is valid when no non-blocking questions remain.

### Phase 1: Reconstruct the real problem

Identify the user pain, current workaround, and why the stated request may be a proxy for a deeper need.

**If the prompt is a new idea whose worth, audience, or demand is not yet
diagnosed**: Stop and hand off to `office-hours`. Do not turn idea diagnosis
into product framing prematurely.
**If no concrete pain or workaround can be inferred and the current turn cannot proceed without operator input**: Use the `question` tool. Do not invent a problem frame from thin air.
**If no concrete pain or workaround can be inferred but the current turn can still hand off useful framing context**: Record the gap in `open_questions`. Do not invent a problem frame from thin air.
**If pain is clear**: Proceed to Phase 2.

### Phase 2: Challenge assumptions and scope

Separate core need from tempting overreach. Identify the narrowest credible wedge worth designing now.

**If the narrowest wedge is still too broad to act on**: Return to Phase 1 with sharper questions.
**If wedge is bounded**: Proceed to Phase 3.

### Phase 3: Emit plan-ready artifacts

Produce `problem_frame`, `user_pains`, `scope_recommendation`, `design_seed`, and `open_questions`.

**If the problem frame restates the original request without reframing**: Stop. Return to Phase 1.
**If artifacts are concrete and actionable**: Hand off to downstream skills.

## Decision Protocol

- What pain is happening now, not just what feature was requested?
- What workaround already exists, and why is it insufficient?
- What is the narrowest wedge that would still change user reality?
- Which tempting scope expansion hides uncertainty rather than leverage?
- Is the stated request a proxy for a different, deeper need?
- Is this already an existing request, or is the upstream idea still untested
  enough to need `office-hours` first?

## Red Flags — STOP

If you catch yourself thinking any of these, STOP and return to Phase 1:

- "The user said it, so that's the problem"
- "I'll restate the request in cleaner prose — that counts as framing"
- "Let me just expand the scope to cover everything"
- "I don't see a pain, but I'll assume one"
- "Discovery is taking too long, let me jump to plan"
- "This new idea sounds promising, so I'll frame it as an existing request"

## Common Rationalizations

See `references/rationalizations.md` for the anti-pattern table.

## Concrete Example

See `references/example.md` for the grounded example output shape.

## Handoff Expectations

- `problem_frame` gives `plan` a clean problem statement, not a raw brainstorm transcript.
- `office_hours_brief`, when present, should be converted into a plan-ready
  product/request frame rather than repeated as founder or builder language.
- `user_pains` are concrete enough that downstream skills can judge tradeoffs against real user friction.
- `scope_recommendation` makes the recommended wedge and deferred scope explicit.
- `design_seed` is the shortest useful handoff into execution planning.
- `open_questions` include only non-blocking questions that still affect plan quality, not generic curiosity.
- Blocking questions belong in the `question` tool, not in `open_questions`.

## Stop Conditions

- The request is already framed well enough for direct planning work.
- The request is upstream idea diagnosis rather than existing request framing.
- No meaningful user or operator pain can be inferred from available context.
- The real blocker is repository understanding, not problem framing.
- Discovery is circling without producing a sharper frame after two passes.
