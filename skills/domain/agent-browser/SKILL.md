---
name: agent-browser
description: Use browser automation to inspect pages, gather evidence, and validate
  flows that cannot be trusted from static code alone.
stability: stable
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
    - skill_complete
references:
  - skills/meta/skill-authoring/references/authored-behavior.md
  - references/diff-verification.md
  - references/eval-safe-mode.md
  - references/security-baseline.md
  - references/semantic-locators.md
consumes:
  - structured_payload
  - design_spec
requires: []
---

# Agent Browser Skill

## Intent

Capture browser-grounded evidence instead of guessing from static assumptions.

## Trigger

Use this skill when:

- the page or workflow must be inspected live
- UI behavior needs evidence from an actual render
- navigation, forms, or auth state matter

## Workflow

### Step 1: Define the navigation target

State the URL, the objective, and the evidence needed.

### Step 2: Run the browser workflow

Use managed `browser_*` tools only. Do not invoke `agent-browser` directly
through shell workflows for this skill.

Before every browser action, make the loop explicit:

- `evaluation_previous_goal`: did the last observation or action move the task forward?
- `memory`: what page identity, refs, blockers, and artifacts must survive the next step?
- `next_goal`: what exact browser state should the next step prove?
- `action`: run one browser action that is sufficient to test that next goal

Keep the loop narrow. Do not chain multiple blind browser actions when one new
snapshot or state read would reduce uncertainty.

### Step 3: Emit browser evidence

Produce:

- `browser_observations`: what was seen, what changed, and what that implies
- `browser_artifacts`: snapshots, screenshots, PDFs, saved state files, or captured evidence references

## Interaction Protocol

- Re-ground on the URL, user goal, and exact evidence target before opening or
  mutating the browser state.
- Ask only when auth, target environment, or the intended workflow cannot be
  inferred safely from the request.
- Prefer one observation or action per loop step. If uncertainty increases,
  refresh the snapshot instead of pushing forward blindly.

## Evidence Protocol

- Treat screenshots and snapshots as raw evidence, not conclusions by
  themselves.
- Explain what changed, what was expected, and why the observed state matters.
- Use browser actions to answer a specific question. Do not browse just to see
  what happens.
- Save artifacts when they will help downstream implementation, review, or bug
  reports continue from the same observed state.

## Handoff Expectations

- `browser_observations` should tell downstream skills what was seen, what was
  attempted, what changed, and what the evidence implies.
- `browser_artifacts` should include the concrete evidence handles that a later
  step can reopen, compare, or cite without repeating the same browser session.

## Stop Conditions

- the environment cannot access the target page
- auth or sandbox constraints block reliable observation
- the request can be answered confidently from code and docs alone

## Anti-Patterns

- browsing without an evidence target
- taking multiple browser actions without a fresh snapshot after uncertainty increases
- treating screenshots as proof without explanation
- replacing repository analysis with page poking
- continuing UI exploration when static code or docs already answer the question

## Example

Input: "Open the docs site, confirm the broken nav state, and capture the failing selector."

Output: `browser_observations`, `browser_artifacts`.
