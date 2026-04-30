---
name: agent-browser
description: Use browser automation to inspect pages, gather evidence, and validate
  flows that cannot be trusted from static code alone.
stability: stable
selection:
  when_to_use: Use when a page, workflow, or UI behavior must be inspected live instead of inferred from static code.
intent:
  outputs:
    - browser_observations
    - browser_artifacts
  output_contracts:
    browser_observations:
      kind: text
      min_words: 3
      min_length: 18
    browser_artifacts:
      kind: json
      min_keys: 1
      min_items: 1
effects:
  allowed_effects:
    - workspace_read
    - workspace_write
    - local_exec
    - runtime_observe
resources:
  default_lease:
    max_tool_calls: 80
    max_tokens: 140000
  hard_ceiling:
    max_tool_calls: 120
    max_tokens: 200000
execution_hints:
  preferred_tools:
    - browser_open
    - browser_wait
    - browser_snapshot
    - browser_click
    - browser_fill
    - browser_get
    - browser_screenshot
    - browser_pdf
    - browser_diff_snapshot
    - browser_state_load
    - browser_state_save
    - browser_close
  fallback_tools:
    - read
    - look_at
    - grep
references:
  - references/diff-verification.md
  - references/eval-safe-mode.md
  - references/security-baseline.md
  - references/semantic-locators.md
  - references/example.md
  - references/rationalizations.md
consumes:
  - structured_payload
  - design_spec
---

# Agent Browser Skill

## The Iron Law

```
NO BROWSER ACTION WITHOUT A SPECIFIC EVIDENCE TARGET
```

## When to Use

- The page or workflow must be inspected live, not inferred from static code
- UI behavior needs evidence from an actual render
- Navigation, forms, or auth state matter for the current task
- Static code and docs are insufficient for the question at hand

## When NOT to Use

- The question can be answered from code, docs, or test output alone
- There is no concrete page or workflow to inspect
- The browser environment is unavailable or sandboxed beyond useful observation
- The request is about code structure, not rendered behavior

## Workflow

### Phase 1: Define the navigation target

State the URL, the objective, and the specific evidence needed.

**If the evidence target is vague or unbounded**: Stop. Tighten the question
before opening the browser. "Look at the page" is not a target.
**If clear**: Proceed to Phase 2.

### Phase 2: Validate navigation readiness

Confirm before opening anything:

- URL or entry surface is explicit
- Auth posture is known or named as an uncertainty
- Evidence target is a specific question, not "see what's there"

**If auth or environment blocks access**: Stop. Report the blocker. Do not
improvise credentials or retry without new information.
**If ready**: Proceed to Phase 3.

### Phase 3: Run the browser workflow

Use managed `browser_*` tools only. Before every browser action, make the
loop explicit:

- `evaluation_previous_goal`: did the last action move the task forward?
- `memory`: page identity, refs, blockers, and artifacts that must survive
- `next_goal`: what exact browser state should the next step prove?
- `action`: one browser action sufficient to test that goal

One observation per step. If uncertainty increases, refresh the snapshot
instead of pushing forward blindly.

**If the page is unreachable or errors block observation**: Stop. Record what
was observed and what blocked progress. Do not retry blindly.
**If evidence is captured**: Proceed to Phase 4.

### Phase 4: Emit browser evidence

Produce:

- `browser_observations`: what was seen, what changed, what that implies
- `browser_artifacts`: snapshots, screenshots, PDFs, saved state, or captured
  evidence references

**If observations do not answer the original evidence target**: Return to
Phase 3 with a narrower goal. Do not emit partial evidence as complete.

## Decision Protocol

- What exact browser state should the next action prove or falsify?
- What single observation would reduce the most uncertainty right now?
- Has the evidence target drifted from where the session started?
- What evidence handle should be preserved so later work can resume from here?
- Is there a static-code answer that would make this browser session unnecessary?

## Red Flags — STOP

If you catch yourself thinking any of these, STOP and return to Phase 1:

- "Let me just browse around and see what's there"
- "I'll take a few more screenshots to be thorough"
- "The page looks fine, let me keep exploring"
- "I don't have a specific question but the browser is open"
- "One more click to see what happens"

## Common Rationalizations

See `references/rationalizations.md` for the anti-pattern table.

## Concrete Example

See `references/example.md` for the grounded example output shape.

## Handoff Expectations

- `browser_observations` should tell downstream skills what was seen, what was
  attempted, what changed, and what the evidence implies for the original question.
- `browser_artifacts` should include concrete evidence handles that a later step
  can reopen, compare, or cite without repeating the same browser session.

## Stop Conditions

- The environment cannot access the target page
- Auth or sandbox constraints block reliable observation
- The request can be answered confidently from code and docs alone
- The evidence target has been answered and no follow-up question remains
- Two consecutive browser actions produced no new information
