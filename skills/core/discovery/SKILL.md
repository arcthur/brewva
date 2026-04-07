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

## The Iron Law

```
NO DESIGN WITHOUT A CLEAR PROBLEM FRAME FIRST
```

Violating the letter of this rule is violating the spirit of this rule.

## When to Use / When NOT to Use

Use when:

- the user has an idea but the real problem is still fuzzy
- product pain, wedge, or non-goals are unclear
- the next step should be better framing, not execution planning

Do NOT use when:

- the request is already a crisp, execution-ready problem statement
- the real blocker is repository understanding, not problem framing (use `repository-analysis`)
- the user is asking for implementation help on a well-defined task (use `design`)

## Workflow

### Phase 1: Reconstruct the real problem

Identify the user pain, current workaround, and why the stated request may be a proxy for a deeper need.

**If no concrete pain or workaround can be inferred**: Stop. Record the gap in `open_questions`. Do not invent a problem frame from thin air.
**If pain is clear**: Proceed to Phase 2.

### Phase 2: Challenge assumptions and scope

Separate core need from tempting overreach. Identify the narrowest credible wedge worth designing now.

**If the narrowest wedge is still too broad to act on**: Return to Phase 1 with sharper questions.
**If wedge is bounded**: Proceed to Phase 3.

### Phase 3: Emit design-ready artifacts

Produce `problem_frame`, `user_pains`, `scope_recommendation`, `design_seed`, and `open_questions`.

**If the problem frame restates the original request without reframing**: Stop. Return to Phase 1.
**If artifacts are concrete and actionable**: Hand off to downstream skills.

## Decision Protocol

- What pain is happening now, not just what feature was requested?
- What workaround already exists, and why is it insufficient?
- What is the narrowest wedge that would still change user reality?
- Which tempting scope expansion hides uncertainty rather than leverage?
- Is the stated request a proxy for a different, deeper need?

## Red Flags — STOP

If you catch yourself thinking any of these, STOP and return to Phase 1:

- "The user said it, so that's the problem"
- "I'll restate the request in cleaner prose — that counts as framing"
- "Let me just expand the scope to cover everything"
- "I don't see a pain, but I'll assume one"
- "Discovery is taking too long, let me jump to design"

## Common Rationalizations

| Excuse                                           | Reality                                                                                        |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| "The request is clear enough to start designing" | If you cannot name the user pain separately from the feature label, the problem is not framed. |
| "Scope will sort itself out during design"       | Unframed scope creates churn in design and review. Frame it now.                               |
| "I'll just do a light reframe and move on"       | A reframe that restates the request in cleaner prose is not discovery.                         |
| "The user wants speed, not a framing exercise"   | A wrong frame wastes more time than a clear one.                                               |

## Concrete Example

Input: "I want to build a daily briefing app for my calendar."

Output:

```json
{
  "problem_frame": "Morning calendar review is manual and slow. Users open 2-3 apps to understand their day, miss conflicts, and lack a single surface that prioritizes what matters. The real problem is decision-ready daily context, not a new app.",
  "user_pains": [
    {
      "pain": "Checking calendar, email, and tasks separately every morning",
      "severity": "high",
      "workaround": "Manual tab-switching routine that takes 10-15 minutes"
    },
    {
      "pain": "Missing scheduling conflicts until they happen",
      "severity": "medium",
      "workaround": "None — discovered reactively"
    }
  ],
  "scope_recommendation": "Build now: a read-only morning digest that pulls calendar events and flags conflicts. Defer: task integration, email triage, AI summarization. Non-goals: full calendar replacement, meeting scheduling.",
  "design_seed": "Single daily digest endpoint that reads calendar events for the next 12 hours, detects time overlaps, and renders a priority-ordered briefing. No write operations in v1.",
  "open_questions": [
    {
      "question": "Which calendar provider(s) must be supported in the first wedge?",
      "why_it_matters": "Provider choice determines auth complexity and time-to-first-value"
    },
    {
      "question": "Is the briefing push-based (notification) or pull-based (open app)?",
      "why_it_matters": "Push requires background scheduling infrastructure that may be premature"
    }
  ]
}
```

## Handoff Expectations

- `problem_frame` gives `design` a clean problem statement, not a raw brainstorm transcript.
- `user_pains` are concrete enough that downstream skills can judge tradeoffs against real user friction.
- `scope_recommendation` makes the recommended wedge and deferred scope explicit.
- `design_seed` is the shortest useful handoff into execution planning.
- `open_questions` include only questions that still affect design quality, not generic curiosity.

## Stop Conditions

- The request is already framed well enough for direct design work.
- No meaningful user or operator pain can be inferred from available context.
- The real blocker is repository understanding, not problem framing.
- Discovery is circling without producing a sharper frame after two passes.
