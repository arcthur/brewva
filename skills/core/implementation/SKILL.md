---
name: implementation
description: Code-change execution with scope discipline and fresh verification
  evidence.
stability: stable
selection:
  when_to_use: Use when the task is ready for code changes and verification evidence must be produced with the change.
  examples:
    - Implement the requested change.
    - Patch this bug in the codebase.
    - Refactor this path and verify it.
  phases:
    - execute
intent:
  outputs:
    - change_set
    - files_changed
    - verification_evidence
  semantic_bindings:
    change_set: implementation.change_set.v2
    files_changed: implementation.files_changed.v2
    verification_evidence: implementation.verification_evidence.v2
effects:
  allowed_effects:
    - workspace_read
    - workspace_write
    - local_exec
    - runtime_observe
resources:
  default_lease:
    max_tool_calls: 100
    max_tokens: 180000
  hard_ceiling:
    max_tool_calls: 140
    max_tokens: 240000
execution_hints:
  preferred_tools:
    - read
    - edit
  fallback_tools:
    - grep
    - exec
    - lsp_diagnostics
    - ledger_query
composable_with:
  - debugging
  - runtime-forensics
consumes:
  - design_spec
  - execution_plan
  - execution_mode_hint
  - implementation_targets
  - root_cause
  - fix_strategy
  - approach_simplicity_check
  - scope_declaration
  - success_criteria
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

Read before editing. Keep the diff local. Avoid incidental cleanup.

Run `scripts/check_scope_drift.py` with current `implementation_targets` and `files_changed`.

**If `within_scope: false`**: Stop. Drifted files listed in output. Return to plan instead of silently widening scope.
**If `within_scope: true`**: Proceed to Phase 3.

### Phase 3: Verify before claiming completion

Run the verification path defined by `success_criteria` when present, otherwise derive it from the change. Capture commands, diagnostics, and runtime evidence while context is fresh. Treat verification as part of implementation, not follow-up.

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
