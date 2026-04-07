---
name: github
description: Use when a request targets GitHub issues, pull requests, checks, or
  repository metadata and should run through one coherent gh workflow.
stability: stable
selection:
  when_to_use: Use when a request targets GitHub issues, pull requests, checks, or repository metadata and should run through one coherent gh workflow.
  examples:
    - Summarize this PR on GitHub.
    - Inspect the failing GitHub checks.
    - Operate on this issue or workflow run with gh.
  phases:
    - investigate
    - execute
    - verify
intent:
  outputs:
    - github_context
    - issue_brief
    - pr_brief
    - ci_findings
  output_contracts:
    github_context:
      kind: text
      min_words: 3
      min_length: 18
    issue_brief:
      kind: text
      min_words: 3
      min_length: 18
    pr_brief:
      kind: text
      min_words: 3
      min_length: 18
    ci_findings:
      kind: json
      min_items: 1
effects:
  allowed_effects:
    - workspace_read
    - local_exec
    - runtime_observe
resources:
  default_lease:
    max_tool_calls: 90
    max_tokens: 160000
  hard_ceiling:
    max_tool_calls: 130
    max_tokens: 220000
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
consumes:
  - change_set
  - verification_evidence
  - review_report
requires: []
scripts:
  - scripts/resolve_github_context.sh
---

# GitHub Skill

## The Iron Law

```
NO GITHUB WRITE WITHOUT EXPLICIT TARGET CONFIRMATION
```

## When to Use

- The request targets issues, PRs, checks, or workflow runs on GitHub
- A repository action should happen through `gh`
- CI evidence or GitHub metadata is required by a downstream skill

## When NOT to Use

- The task is general git work with no GitHub-specific surface
- The user only needs local branch operations
- The work has moved into a bounded CI repair loop (hand off to `ci-iteration`)
- Browser-driven GitHub interaction is required rather than CLI

## Workflow

### Phase 1: Resolve repo context

Run `scripts/resolve_github_context.sh` to detect repo, owner, auth, branch, and current PR.

**If gh is missing or unauthenticated**: Stop. Report the gap. Do not attempt workarounds.
**If repo is unresolvable**: Ask the user for the target repository explicitly.
**If resolved**: Proceed to Phase 2.

### Phase 2: Select workflow mode

Choose exactly one mode: `issue`, `pull_request`, `ci`, or `api_query`.

**If the mode is ambiguous**: Ask the user. Do not guess between PR and issue workflows.
**If clear**: Proceed to Phase 3.

### Phase 3: Confirm write targets

Before any mutation, restate: repository, target object, exact action, and why it matches the request.

**If the user did not explicitly request the write**: Stop at a draft artifact. Do not execute.
**If confirmed**: Proceed to Phase 4.

### Phase 4: Emit domain artifacts

Produce the relevant subset of:

- `github_context`: repo, auth, and target object
- `issue_brief` or `pr_brief`: actionable artifact draft tied to acceptance signals
- `ci_findings`: failing checks, likely causes, and recommended next actions

## Scripts

- `scripts/resolve_github_context.sh` — No input required. Output: JSON with `repo`, `owner`, `authenticated`, `current_pr`, `branch`. Run at Phase 1 before any `gh` commands.

## Decision Protocol

- Is the request a read (query/summary) or a write (create/update/close/merge)?
- Which single workflow mode covers the center of gravity: `issue`, `pull_request`, `ci`, or `api_query`?
- Does this need `ci-iteration` instead? The boundary is: triage stays here, bounded repair loops belong there.
- Is the write target named with enough precision to avoid acting on the wrong object?

## Red Flags — STOP

If you catch yourself thinking any of these, STOP and return to Phase 1:

- "I'll just create this issue/PR and the user can fix it later"
- "The repo is probably the one in the current directory"
- "I'll combine issue triage and PR creation in one pass"
- "The user implied they want this merged"

## Common Rationalizations

| Excuse                                         | Reality                                                            |
| ---------------------------------------------- | ------------------------------------------------------------------ |
| "Obvious which repo, skip context resolution"  | Wrong-repo writes are unrecoverable. Always resolve first.         |
| "User said 'fix it' so I should push directly" | 'Fix it' is not write confirmation. Restate the target and action. |
| "I'll batch issue + PR + CI in one workflow"   | Mixed modes drift. Pick one center of gravity per activation.      |
| "Raw gh output is good enough"                 | Downstream skills need synthesized artifacts, not log dumps.       |

## Concrete Example

Input: "Summarize the failing checks on PR #42 and draft a follow-up comment."

Output:

```json
{
  "github_context": {
    "repo": "brewva",
    "owner": "bytedance",
    "authenticated": true,
    "current_pr": 42,
    "branch": "fix/type-check-regression"
  },
  "ci_findings": {
    "failing_checks": [
      { "name": "typecheck", "conclusion": "FAILURE" },
      { "name": "lint", "conclusion": "FAILURE" }
    ],
    "passing_count": 5,
    "failing_count": 2,
    "pending_count": 0,
    "likely_causes": ["Type error in packages/brewva-runtime/src/config/normalize.ts:47"],
    "recommended_actions": ["Fix the type narrowing, rerun bun run check locally"]
  },
  "pr_brief": {
    "summary": "Two checks failing: typecheck and lint. Root cause is a missing type guard in normalize.ts. Suggested comment drafts a fix path and asks for confirmation before pushing.",
    "draft_comment": "CI shows typecheck + lint failures tracing to a missing type guard in `normalize.ts:47`. Proposed fix: add the narrowing guard and verify with `bun run check`. Want me to proceed?"
  }
}
```

## Handoff Expectations

- `github_context` identifies the exact repository, auth posture, and target object so later steps do not drift to a different repo or PR.
- `issue_brief` and `pr_brief` are concrete, actionable, and tied to real acceptance or verification signals.
- `ci_findings` separates failing checks, likely causes, and recommended next actions instead of dumping raw workflow output.

## Stop Conditions

- `gh` is unavailable or unauthenticated and cannot be resolved
- Repository permissions block the requested write action
- The task needs browser-driven interaction rather than CLI workflows
- The target object (issue number, PR number, workflow run) cannot be identified

Violating the letter of these rules is violating the spirit of these rules.
