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
    - exec
    - skill_complete
references:
  - references/diff-verification.md
  - references/eval-safe-mode.md
  - references/security-baseline.md
  - references/semantic-locators.md
scripts:
  - templates/authenticated-session.sh
  - templates/capture-workflow.sh
  - templates/form-automation.sh
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

Prefer managed `browser_*` tools first. Use the bundled shell templates only
when you need a pre-packaged multi-step workflow.

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

## Stop Conditions

- the environment cannot access the target page
- auth or sandbox constraints block reliable observation
- the request can be answered confidently from code and docs alone

## Anti-Patterns

- browsing without an evidence target
- taking multiple browser actions without a fresh snapshot after uncertainty increases
- treating screenshots as proof without explanation
- replacing repository analysis with page poking

## Example

Input: "Open the docs site, confirm the broken nav state, and capture the failing selector."

Output: `browser_observations`, `browser_artifacts`.
