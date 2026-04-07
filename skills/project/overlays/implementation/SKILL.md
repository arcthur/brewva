---
name: implementation
effects:
  allowed_effects:
    - workspace_read
    - workspace_write
    - local_exec
    - runtime_observe
resources:
  default_lease:
    max_tool_calls: 90
    max_tokens: 160000
execution_hints:
  preferred_tools:
    - read
    - edit
  fallback_tools:
    - grep
    - exec
    - lsp_diagnostics
    - ledger_query
    - skill_complete
references:
  - skills/project/shared/package-boundaries.md
  - skills/project/shared/migration-priority-matrix.md
consumes:
  - design_spec
  - execution_plan
  - execution_mode_hint
  - root_cause
  - fix_strategy
requires: []
---

# Brewva Implementation Overlay

## Intent

Keep Brewva implementation work minimal, boundary-aware, and evidence-first.

## Trigger

Use this overlay when implementing changes inside Brewva.

## Overlay Scripts

Run the base scope drift check during implementation:

- `scripts/check_scope_drift.py` — detects when implementation drifts beyond the approved change boundary. Run after each milestone.

Additionally preserve Brewva public surfaces and dist guardrails.

## Workflow

### Step 1: Preserve public surfaces

Treat runtime, CLI branding, and distribution safety gates as high-risk surfaces.

### Step 2: Pair code and evidence

When touching routing, verification, or distribution behavior, keep verification evidence explicit in the same change set.

## Overlay Gate

- [ ] Public surfaces stayed explicit.
- [ ] Verification evidence is captured with the change.
- [ ] Category migration did not quietly widen into architecture churn.

## Stop Conditions

- the requested implementation implies a broader architecture redesign
- required verification cannot be defined from the change boundary

## Common Rationalizations

| Excuse                                         | Reality                                                                                           |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| "While I'm here I'll fix this other thing too" | Mixed changes are harder to review, revert, and verify. Stay within the approved boundary.        |
| "Relaxing the dist gate saves time"            | Dist gate failures caught late cost far more than the minutes saved now.                          |
| "The migration is basically a refactor"        | Category migrations that touch public surfaces are not refactors. Treat them as boundary changes. |

## Anti-Patterns

- mixing category migration with opportunistic runtime rewrites
- weakening dist or verification guardrails to make the refactor easier

## Example

Input: "Implement the new routing profile config and remove legacy pack filtering."
