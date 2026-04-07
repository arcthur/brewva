---
name: review
effects:
  allowed_effects:
    - workspace_read
    - runtime_observe
resources:
  default_lease:
    max_tool_calls: 70
    max_tokens: 140000
execution_hints:
  preferred_tools:
    - read
    - grep
  fallback_tools:
    - lsp_diagnostics
    - lsp_symbols
    - lsp_find_references
    - ast_grep_search
    - ledger_query
    - skill_complete
references:
  - skills/project/shared/package-boundaries.md
  - skills/project/shared/migration-priority-matrix.md
scripts:
  - skills/project/scripts/check-skill-dod.sh
consumes:
  - change_set
  - files_changed
  - design_spec
  - verification_evidence
  - impact_map
  - risk_register
  - planning_posture
requires: []
---

# Brewva Review Overlay

## Intent

Review Brewva changes against project invariants, not just generic code quality.

## Trigger

Use this overlay when reviewing changes in the Brewva monorepo.

## Overlay Scripts

Run base review scripts before Brewva-specific judgment:

- `scripts/activate_lanes.py` — activates review lanes from change categories. Run before step 1.
- `scripts/synthesize_lane_dispositions.py` — synthesizes lane outcomes into a merge decision. Run after all lanes report.

Additionally check Brewva invariants: package boundaries, CLI branding, dist safety.

## Workflow

### Step 1: Check invariant-sensitive surfaces

Prioritize runtime governance, package boundaries, CLI branding, config shape, and dist safety.

### Step 2: Call out project-specific regressions

Surface violations of the migration matrix, skill DoD, or artifact contract clarity.

## Overlay Review Questions

- Which Brewva invariant is this change most likely to violate?
- Does the diff weaken package boundaries, branding consistency, or dist safety?

## Stop Conditions

- there is no concrete diff or artifact to review
- the review target is missing the evidence needed for Brewva-specific judgment

## Common Rationalizations

| Excuse                                  | Reality                                                                                                               |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| "The code looks clean, approve it"      | Style is not safety. Brewva review must check invariants, boundaries, and dist gates -- not just readability.         |
| "Docs changes don't need deep review"   | Doc and export surface changes in catalog refactors can silently break downstream consumers.                          |
| "The tests pass, so the change is safe" | Passing tests prove what was tested. Brewva invariants (branding, boundaries, governance) need explicit verification. |

## Anti-Patterns

- reviewing only code style while missing kernel boundary drift
- ignoring docs and exported surface changes in catalog refactors

## Example

Input: "Review whether the v2 taxonomy change leaked internal phases back into the public catalog."
