---
name: git-ops
description: Handle commit shaping, history inspection, and non-destructive branch
  operations with explicit safety gates.
stability: stable
selection:
  when_to_use: Use when the task centers on commits, history inspection, branch operations, or other non-destructive git workflow management.
  examples:
    - Shape the commits for this branch.
    - Inspect git history to explain what changed.
    - Handle the safe git operations for this task.
  phases:
    - execute
    - ready_for_acceptance
intent:
  outputs:
    - git_context
    - commit_plan
    - git_operation_report
  output_contracts:
    git_context:
      kind: text
      min_words: 3
      min_length: 18
    commit_plan:
      kind: json
      min_items: 1
    git_operation_report:
      kind: text
      min_words: 3
      min_length: 18
effects:
  allowed_effects:
    - workspace_read
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
    - exec
    - read
  fallback_tools:
    - grep
    - ledger_query
    - skill_complete
references:
  - skills/meta/skill-authoring/references/authored-behavior.md
  - references/conventional-commits.md
  - references/history-search-cheatsheet.md
  - references/rebase-workflow.md
scripts:
  - scripts/detect-commit-style.sh
consumes:
  - change_set
  - files_changed
  - verification_evidence
  - review_report
requires: []
---

# Git Ops Skill

## Intent

Create reviewable history and safe branch operations without treating Git mechanics as an ordinary routed coding skill.

## Trigger

Use this skill when:

- commits need to be created or shaped
- history must be inspected for evidence
- a safe branch operation is requested

## Workflow

### Step 1: Gather branch safety context

Inspect worktree state, branch, upstream, and diff shape.

### Step 2: Choose the operation

Pick `commit`, `history_search`, or another safe Git operation with the minimum required blast radius.

### Step 3: Emit Git artifacts

Produce:

- `git_context`: worktree and branch state
- `commit_plan`: atomic grouping and message approach
- `git_operation_report`: what changed and what remains risky

## Interaction Protocol

- Re-ground on branch, worktree cleanliness, upstream relationship, and the
  exact Git outcome requested before running commands.
- Ask only when the requested operation is ambiguous, likely destructive, or
  would affect unrelated work in the tree.
- Prefer the safest operation that still satisfies the request. Do not default
  to history rewriting because it produces a prettier graph.

## Operation Confirmation Gate

Before running a Git mutation, restate:

1. current branch and worktree posture
2. exact operation
3. affected scope
4. rollback or recovery posture

If any of those is unclear, stop at `commit_plan` or `git_context` instead of
executing the mutation.

## Safety Protocol

- Treat destructive or hard-to-rollback operations as explicit exceptions, not
  as routine follow-ups.
- Separate history inspection, commit shaping, and branch mutation conceptually.
  Each should have its own justification.
- Keep unrelated edits out of one commit plan unless the user explicitly wants a
  squash-style result and the work is genuinely inseparable.
- Explain residual risk clearly when the worktree is dirty, upstream is unclear,
  or branch history has already diverged.

## Handoff Expectations

- `git_context` should capture branch position, worktree state, upstream status,
  and any constraints that affect safe Git operations.
- `commit_plan` should define atomic groupings, commit order, and message shape
  so the operator can execute without recomputing intent.
- `git_operation_report` should record what was done, what remains risky, and
  what follow-up action is still needed.

## Stop Conditions

- the requested operation is destructive or hard to roll back without explicit intent
- branch state is unclear
- the task is really review or GitHub workflow, not Git history manipulation

## Anti-Patterns

- rewriting history by default
- mixing unrelated changes into one commit plan
- treating Git style detection as a substitute for change review
- using Git cleanup to paper over unclear engineering boundaries

## Example

Input: "Split this refactor into reviewable commits and summarize the safe execution order."

Output: `git_context`, `commit_plan`, `git_operation_report`.
