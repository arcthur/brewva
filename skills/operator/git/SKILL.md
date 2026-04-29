---
name: git
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
references:
  - references/conventional-commits.md
  - references/history-search-cheatsheet.md
  - references/rebase-workflow.md
  - references/example.md
  - references/rationalizations.md
scripts:
  - scripts/detect-commit-style.sh
  - scripts/check_branch_safety.sh
consumes:
  - change_set
  - files_changed
  - verification_evidence
  - review_report
---

# Git Skill

## The Iron Law

```
NO HISTORY REWRITE WITHOUT EXPLICIT ROLLBACK POSTURE
```

## When to Use / When NOT to Use

Use when:

- commits need to be created, split, or shaped for review
- history must be inspected to answer an evidence question
- a safe branch operation (merge, rebase, cherry-pick) is requested
- commit style needs detection before shaping

Do NOT use when:

- the task is code review — route to review skill
- the task is GitHub PR/issue workflow — route to ship skill
- the mutation is already complete and the question is "what happened" — route to runtime-forensics

## Workflow

### Phase 1: Assess branch safety

Run `scripts/check_branch_safety.sh`. Read its JSON output.

**If `safe` is false and warnings include divergence or protected branch**: Stop.
Report the warnings to the operator and request explicit intent before proceeding.
**If `safe` is true**: Proceed to Phase 2.

### Phase 2: Detect commit style

Run `scripts/detect-commit-style.sh`. Use the detected style (SEMANTIC, SHORT,
PLAIN) and language to shape commit messages consistently with history.

**If no commits exist**: Default to SEMANTIC ENGLISH. Proceed to Phase 3.

### Phase 3: Plan the operation

Identify the minimum-blast-radius operation: `commit`, `history_search`,
`rebase`, `cherry-pick`, or `split`. Produce `git_context` and `commit_plan`.

**If the operation is destructive or hard to reverse**: Emit the plan but do NOT
execute. State the rollback posture and wait for confirmation.
**If non-destructive**: Proceed to Phase 4.

### Phase 4: Execute and report

Run the planned operation. Produce `git_operation_report` covering what changed,
what remains risky, and what follow-up is needed.

**If execution fails**: Record the error, reset to pre-operation state, report.
Do not retry without new information.

## Scripts

- `scripts/check_branch_safety.sh` — Input: none (reads git state). Output: JSON
  with `safe`, `branch`, `worktree_clean`, `upstream_status`, `diverged`,
  `warnings`. Run before any git mutation.
- `scripts/detect-commit-style.sh` — Input: optional commit limit (default 30).
  Output: key=value pairs for `language`, `style`, `total`, `semantic`, samples.
  Run before shaping commits.

## Decision Protocol

- Is the requested operation the safest way to achieve the intent?
- Would a non-destructive alternative (new branch, patch) achieve the same goal?
- Does the commit plan mix unrelated changes that should be separate?
- Can the operation be reversed with a single command if it goes wrong?

## Red Flags — STOP

If you catch yourself thinking any of these, STOP and return to Phase 1:

- "Just force-push, we can fix it later"
- "The worktree is dirty but it's probably fine"
- "Rebase will be cleaner" (without checking divergence)
- "One big commit is easier than splitting"

## Common Rationalizations

See `references/rationalizations.md` for the anti-pattern table.

## Concrete Example

See `references/example.md` for the grounded example output shape.

## Handoff Expectations

- `git_context` captures branch position, worktree state, upstream status, and
  constraints so downstream skills do not need to re-inspect git state.
- `commit_plan` defines atomic groupings, commit order, and message shape so the
  operator can execute without recomputing intent.
- `git_operation_report` records what was done, what remains risky, and what
  follow-up action is still needed.

## Stop Conditions

- The requested operation is destructive and operator has not confirmed rollback posture.
- Branch state is unclear after `check_branch_safety.sh` reports warnings.
- The task is really review, GitHub workflow, or runtime forensics — not git history.
- The worktree has unresolvable merge conflicts.
