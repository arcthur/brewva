---
name: implementation
description: "Execute code changes using the right mode for the local situation: direct
  patch, test-first, or coordinated rollout."
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
  output_contracts:
    change_set:
      kind: text
      min_words: 3
      min_length: 18
    files_changed:
      kind: json
      min_items: 1
    verification_evidence:
      kind: json
      min_items: 1
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
    - skill_complete
references:
  - skills/meta/skill-authoring/references/authored-behavior.md
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
requires: []
---

# Implementation Skill

## Intent

Ship the smallest correct change set and choose the implementation mode from evidence, not habit.

## Trigger

Use this skill when:

- the task is ready for code changes
- the fix or feature is already understood well enough to execute
- verification evidence must be produced alongside the change

## Workflow

### Step 1: Choose mode

Pick one:

- `direct_patch` for local, low-risk edits
- `test_first` when behavior needs to be pinned before the change
- `coordinated_rollout` for multi-file or cross-boundary work

Respect `execution_mode_hint` when present, but override it if the actual scope disagrees.

### Step 2: Apply the change

Read before editing, keep the diff local, and avoid incidental cleanup.

### Step 3: Verify before claiming completion

Treat verification as part of implementation. Capture commands, diagnostics, and
runtime evidence while the change context is still fresh.

### Step 4: Emit execution artifacts

Produce:

- `change_set`: what changed and why
- `files_changed`: concrete file list
- `verification_evidence`: commands, diagnostics, or runtime evidence

If verification blocks completion, expect runtime to hand control to the debug
loop. Preserve the attempted evidence so `runtime-forensics` or `debugging` can
continue from the failure snapshot instead of re-deriving context from scratch.

## Interaction Protocol

- Proceed without asking when the next edit is obvious from the plan and local
  evidence.
- Ask only when the requested behavior, risk tolerance, or effect boundary is
  genuinely ambiguous.
- If the change expands materially beyond the active plan, stop and hand control
  back to design instead of silently widening scope.
- Treat `implementation_targets` as a hard ownership fence. Targets should stay
  concrete and path-scoped enough to map directly onto `files_changed`. If the actual
  touched files or directories clearly exceed the planned targets, return to design
  instead of silently expanding scope.

## Change Safety Gate

Before applying edits, clear this gate:

- [ ] The active plan still matches the actual touched surface.
- [ ] The touched files or directories still fit within concrete `implementation_targets`.
- [ ] The diff can stay local instead of widening into incidental cleanup.
- [ ] A concrete verification path exists for the risky behavior.
- [ ] Any unresolved ambiguity is about execution detail, not missing design.

## Mode Selection Protocol

- Use `direct_patch` for bounded local edits where verification is straightforward.
- Use `test_first` when current behavior is disputed, brittle, or easy to
  regress without pinning.
- Use `coordinated_rollout` when the work crosses packages, contracts, or
  runtime boundaries and needs ordered sequencing.
- Do not pick the simplest mode by habit. Pick the mode that makes the change
  safest to verify.

## Handoff Expectations

- `change_set` should explain what changed, why this shape was chosen, and any
  intentional non-changes that matter to review.
- `files_changed` should be the concrete touched file list, not a category
  summary.
- `verification_evidence` should preserve enough detail for review or debugging
  to continue from the actual post-change state without re-running the whole
  investigation mentally.

## Stop Conditions

- the requested change implies a larger design problem than the current plan covers
- the root cause is still uncertain
- available verification is too weak to justify completion

## Anti-Patterns

- treating execution mode as a routing problem for another public skill
- rewriting large surfaces for a local change
- claiming completion without concrete verification evidence
- treating verification as optional follow-up cleanup

## Example

Input: "Implement the routing profile model and update the registry index generation."

Output: `change_set`, `files_changed`, `verification_evidence`.
