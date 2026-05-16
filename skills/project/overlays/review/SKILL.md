---
name: review
references:
  - skills/project/shared/package-boundaries.md
  - skills/project/shared/migration-priority-matrix.md
---

# Brewva Review Overlay

## Intent

Review Brewva changes against project invariants, not just generic code quality.

## Trigger

Use this overlay when reviewing changes in the Brewva monorepo.

## Overlay Invariants

Apply base review invariants before Brewva-specific judgment:

- `invariants/review-lane-rules.md` — activates review lanes from change
  categories and synthesizes lane outcomes into a merge decision.

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

Input: "Review whether delegated consult changes leaked internal review lanes back into the public surface."
