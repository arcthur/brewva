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
  - scripts/check_branch_safety.sh
consumes:
  - change_set
  - files_changed
  - verification_evidence
  - review_report
requires: []
---

# Git Ops

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

| Excuse                                       | Reality                                                            |
| -------------------------------------------- | ------------------------------------------------------------------ |
| "Force-push is fine on a feature branch"     | Other collaborators may have fetched. Check first.                 |
| "History rewrite makes the graph prettier"   | Prettier graphs do not justify lost rollback safety.               |
| "Dirty worktree won't affect this operation" | Stashed or uncommitted work can silently leak into commits.        |
| "I'll split the commits later"               | Later never comes. Split now or commit to the monolith explicitly. |

## Concrete Example

Input: "Split this refactor into reviewable commits and summarize the safe execution order."

Output:

```json
{
  "git_context": {
    "branch": "feat/extract-context-port",
    "worktree_clean": true,
    "upstream_status": "ahead",
    "diverged": false,
    "commit_style": "SEMANTIC"
  },
  "commit_plan": [
    {
      "order": 1,
      "scope": "packages/brewva-runtime/src/context/",
      "message": "refactor(context): extract injection port from arena",
      "files": 3
    },
    {
      "order": 2,
      "scope": "packages/brewva-runtime/src/services/",
      "message": "refactor(services): wire new context port into pipeline",
      "files": 2
    },
    {
      "order": 3,
      "scope": "test/",
      "message": "test(context): add injection port integration tests",
      "files": 1
    }
  ],
  "git_operation_report": "3 atomic commits created on feat/extract-context-port. No history rewrite. Branch is 3 ahead of origin. Residual risk: none — each commit passes check independently."
}
```

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

Violating the letter is violating the spirit.
