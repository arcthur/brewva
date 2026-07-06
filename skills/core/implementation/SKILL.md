---
name: implementation
description: Code-change execution with scope discipline and fresh verification evidence.
selection:
  when_to_use:
    Use when the task is ready for code changes and verification evidence must be produced
    with the change.
references:
  - references/example.md
  - references/rationalizations.md
scripts:
  - scripts/check_scope_drift.py
---

# Implementation

## The Iron Law

```
NO COMPLETION CLAIM WITHOUT FRESH VERIFICATION EVIDENCE
```

## When to Use

- The task is ready for code changes and the fix or feature is understood.
- A confirmed `root_cause` and `fix_strategy` exist from debugging.
- Verification evidence must be produced alongside the change.
- An `execution_plan` or `design_spec` scopes the work.

## When NOT to Use

- The root cause is still uncertain — use `debugging` first.
- The change implies a larger planning problem than the current plan covers.
- No concrete `implementation_targets` exist yet.

## Workflow

### Phase 1: Choose mode

If `approach_simplicity_check` is present and `verdict: over_engineered`, stop. Do not proceed. Return to `prep` to trim the approach first.

Pick a mode based on evidence, not habit:

- `direct_patch` — bounded local edits, straightforward verification.
- `test_first` — behavior is disputed, brittle, or easy to regress without pinning.
- `coordinated_rollout` — crosses packages, contracts, or runtime boundaries.

Respect `execution_mode_hint` when present. Override it if actual scope disagrees.

**If no mode fits cleanly**: Stop. Return to plan — scope is ambiguous.
**If mode chosen**: Proceed to Phase 2.

### Phase 2: Apply the change

Read before editing. Keep the diff local. Avoid incidental cleanup. Every
changed file must trace to `implementation_targets`, required verification, or
cleanup made necessary by this change. Mention pre-existing dead code instead
of deleting it unless this change made it orphaned.

Land new code in compilable milestones. When a change grows beyond roughly 150
new lines, write the smallest unit that can compile, run the cheapest compile
or syntax probe, then continue. A single giant write defers the first compiler
contact until everything is already written — the most expensive moment to
learn the entry-point assumption was wrong.

Run `scripts/check_scope_drift.py` with current `implementation_targets` and `files_changed`.

**If `within_scope: false`**: Stop. Drifted files listed in output. Return to plan instead of silently widening scope.
**If `within_scope: true`**: Proceed to Phase 3.

### Phase 3: Verify before claiming completion

Run the verification path defined by `success_criteria` when present, otherwise derive it from the change. Capture commands, diagnostics, and runtime evidence while context is fresh. Treat verification as part of implementation, not follow-up.

Derive task-shaped checks from the verification ladder
(`verifier/references/verification-ladder.md`): a passing build is the
`exit_code` rung only. New applications, packages, or greenfield workspaces
require the `artifact` and `requirements` rungs before completion. Record the
reached rung with `verification_record`; state it in the completion claim.

On non-trivial work, close with an independent perspective the parent cannot
mint for itself: send `review_request` for adversarial-read closure, and run a
`verifier` pass for executable adversarial checks. Both stay advisory — they
inform the completion claim, they do not gate it.

**If verification fails**: Preserve attempted evidence in `verification_evidence`. Hand control to debug loop. Do not retry blindly.
**If verification passes**: Proceed to Phase 4.

### Phase 4: Emit execution artifacts

Produce all three outputs:

- `change_set`: what changed, why this shape, any intentional non-changes.
- `files_changed`: concrete touched file list.
- `verification_evidence`: commands run, exit codes, diagnostic output, runtime observations.

**If any output is missing or vague**: Do not claim completion. Return to Phase 3.

## Scripts

- `scripts/check_scope_drift.py` — Input: implementation_targets list, files_changed list. Output: within_scope bool, drifted_files list, target_coverage float. Run after every edit batch in Phase 2.

## Decision Protocol

- Does the active plan still match the actual touched surface?
- Do the touched files fit within concrete `implementation_targets`?
- Can the diff stay local instead of widening into incidental cleanup?
- Does a concrete verification path exist for the risky behavior?
- Is any unresolved ambiguity about execution detail, or missing planning?

## Red Flags — STOP

If you catch yourself thinking any of these, STOP and return to Phase 1:

- "While I'm here, I'll clean up this too"
- "Verification can happen later"
- "The tests probably still pass"
- "This file isn't in scope but it's a quick fix"
- "I'll skip the scope check, it's obviously fine"
- "I'll add this helper — it might be useful later"
- "This deserves a proper abstraction layer"
- "One giant write will be faster than checkpoints"
- "The build passed, so it works"
- Claiming completion before running verification commands

## Common Rationalizations

See `references/rationalizations.md` for the anti-pattern table.

## Concrete Example

See `references/example.md` for the grounded example output shape.

## Handoff Expectations

- `change_set` explains what changed, why this shape, and intentional non-changes that matter to review.
- `files_changed` is the concrete touched file list, not a category summary.
- `verification_evidence` preserves enough detail for review or debugging to continue from the post-change state without re-running the investigation.

## Stop Conditions

- The requested change implies a larger planning problem than the current plan covers.
- The root cause is still uncertain — hand back to debugging.
- `check_scope_drift.py` reports `within_scope: false` and plan has not approved the wider scope.
- Available verification is too weak to justify a completion claim.
