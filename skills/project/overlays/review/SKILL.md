---
name: review
references:
  - skills/project/shared/critical-rules.md
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

Additionally check Brewva invariants: package boundaries, CLI branding, dist
safety, Work Card inspect, attention option boundaries, advisory extension
authority, and verification gate manifest wiring.

## Workflow

### Step 1: Check invariant-sensitive surfaces

Prioritize runtime governance, package boundaries, CLI branding, config shape,
dist safety, Work Card projection parity, attention option reveal boundaries,
and explicit verification gate manifest paths.

### Step 2: Call out project-specific regressions

Surface violations of the migration matrix, skill DoD, or artifact contract clarity.

## Overlay Review Questions

- Which Brewva invariant is this change most likely to violate?
- Does the diff weaken package boundaries, branding consistency, or dist safety?
- Does the diff restore old inspect semantics, hidden context admission, skill
  execution authority, local-hook blocking, or verifier adapter hard-gating?
- Does the advisory extension path fail closed without expanding capability,
  kernel, sandbox, source, or adoption authority?

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
- treating a clean renderer diff as safe without checking Work Card, attention
  option, continuation anchor, and channel/CLI/shell parity

## Example

Input: "Review whether delegated consult changes leaked internal review lanes back into the public surface."
