---
name: github
description: Operate on GitHub issues, PRs, CI, and repository metadata through one
  coherent `gh`-driven workflow.
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
---

# GitHub Skill

## Intent

Handle issue, PR, and CI work as one domain so repository operations stay coherent and auditable.

## Trigger

Use this skill when:

- the request targets issues, PRs, checks, or workflow runs
- a repo action should happen through `gh`
- CI evidence or GitHub metadata is required

## Workflow

### Step 1: Resolve repo context

Verify `gh` availability, auth, and target repository.

### Step 2: Select workflow mode

Choose `issue`, `pull_request`, `ci`, or `api_query`.

### Step 3: Emit domain artifacts

Produce:

- `github_context`: repo, auth, and target object
- `issue_brief` or `pr_brief`: actionable artifact draft
- `ci_findings`: failed checks and next actions when CI is involved

### Workflow Gate

Before leaving triage and touching a live GitHub target, clear this gate:

- [ ] repository and host are resolved
- [ ] auth posture and permissions are known
- [ ] workflow mode is explicit: `issue`, `pull_request`, `ci`, or `api_query`
- [ ] any write target is named exactly: issue number, PR number, comment, label, or workflow run

## Interaction Protocol

- Re-ground on repository, branch or PR, and requested GitHub action before
  issuing `gh` commands.
- Ask only when repository identity, permissions, or the intended write action
  are ambiguous enough to risk operating on the wrong target.
- Prefer one coherent GitHub workflow per request instead of mixing issue, PR,
  and CI actions opportunistically.

## Write Confirmation Gate

For GitHub writes, do not rely on implication. Before mutating remote state,
restate:

1. repository
2. target object
3. exact action
4. why that action matches the user's request

If the user did not explicitly ask for the write, stop at a draft `issue_brief`,
`pr_brief`, or `ci_findings` artifact instead of executing the mutation.

## Mode Selection Protocol

- Use `issue` when the main artifact is problem framing, triage, or actionable
  follow-up work.
- Use `pull_request` when the center of gravity is a diff, merge path, or PR
  communication.
- Use `ci` when the decisive evidence lives in checks, workflow runs, or job
  logs.
- Hand off to `ci-iteration` when the work has moved from CI triage into a
  bounded repair loop with explicit retry and verification posture.
- Use `api_query` only when the request is metadata-heavy and not well served by
  the higher-level workflows.

## Handoff Expectations

- `github_context` should identify the exact repository, auth posture, and
  target object so later steps do not risk drifting to a different repo or PR.
- `issue_brief` and `pr_brief` should be concrete, actionable, and tied to real
  acceptance or verification signals.
- `ci_findings` should separate failing checks, likely causes, and recommended
  next actions instead of dumping raw workflow output.

## Stop Conditions

- `gh` is unavailable or unauthenticated
- repository permissions block the requested write action
- the task needs browser-driven interaction rather than CLI workflows

## Anti-Patterns

- splitting issue triage and PR flow into separate public skills
- acting on the wrong repository context
- creating vague issues or PRs with no acceptance or verification signal
- treating raw CI logs as the final artifact instead of synthesizing next actions

## Example

Input: "Use gh to summarize the failing checks on this PR and draft a follow-up comment."

Output: `github_context`, `ci_findings`, `pr_brief`.
