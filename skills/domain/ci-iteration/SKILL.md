---
name: ci-iteration
description: Drive PR and CI repair loops with explicit exit conditions, verification
  evidence, and durable iteration discipline.
stability: experimental
selection:
  when_to_use: Use when failing checks, PR feedback, or repair loops need bounded iteration with current CI state and local verification evidence.
  examples:
    - Fix the failing CI and iterate until it is green.
    - Address PR review feedback and rerun verification.
    - Work the repair loop for this failing branch.
  paths:
    - .github/workflows
  phases:
    - execute
    - verify
intent:
  outputs:
    - ci_snapshot
    - iteration_plan
    - iteration_report
    - remaining_blockers
  output_contracts:
    ci_snapshot:
      kind: json
      min_items: 4
    iteration_plan:
      kind: json
      min_items: 4
    iteration_report:
      kind: json
      min_items: 4
    remaining_blockers:
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
    max_tool_calls: 110
    max_tokens: 190000
  hard_ceiling:
    max_tool_calls: 150
    max_tokens: 250000
execution_hints:
  preferred_tools:
    - exec
    - read
    - iteration_fact
  fallback_tools:
    - subagent_run
    - subagent_status
    - workflow_status
    - ledger_query
    - skill_complete
references:
  - skills/meta/skill-authoring/references/authored-behavior.md
consumes:
  - ci_findings
  - review_report
  - review_findings
  - verification_evidence
  - change_set
requires: []
---

# CI Iteration Skill

## Intent

Close the loop on CI failures and review feedback without turning repair work
into an unbounded retry treadmill.

## Trigger

Use this skill when:

- the task centers on failing checks, PR review feedback, or repeated repair attempts
- the next move depends on current CI state plus local verification evidence
- a bounded retry loop needs explicit stop conditions

Do not use this skill when:

- the work is still mostly discovery or design ambiguity
- there is no concrete PR, branch, workflow run, or failing check to iterate on
- the user only wants a one-shot CI summary with no repair loop

## Workflow

### Step 1: Resolve the repair target

Lock the target before acting:

- repository
- branch or PR reference
- failing checks or actionable review threads
- exit condition for the current loop

If the target is ambiguous, stop and clarify before mutating code or remote
state.

### Step 2: Capture the baseline snapshot

Produce `ci_snapshot` with:

- current failing checks and their status
- review feedback that still needs action
- current branch / PR posture
- local verification posture and any already-known blockers

The snapshot is the baseline. Do not compare later attempts against memory.

### Step 3: Choose the iteration shape

Pick one explicit mode:

- `repair_local`: apply a direct bounded fix locally
- `delegate_patch`: isolate the repair into a delegated patch worker
- `review_only`: stop at diagnosis and handoff because the requested write is not authorized

`iteration_plan` must name:

- the chosen mode
- the exact failing checks or threads in scope
- the verification path for the next attempt
- the stop condition for this bounded run

### Step 4: Execute one bounded attempt

For a repair attempt:

1. change only the surface justified by the active CI or review evidence
2. rerun the narrowest local verification that can falsify the fix
3. record the outcome honestly in `iteration_report`

If repeated attempts are expected, persist only objective loop facts:

- a metric observation such as failing-check count, failing-test count, or lint-error count
- a guard result such as "branch still clean", "targeted tests pass", or "no new failures introduced"

Use `iteration_fact` for evidence, not for narrative interpretation.

### Step 5: Stop, continue, or escalate

At the end of the bounded run, decide one:

- `done`: the targeted failures are resolved and verification evidence is sufficient
- `continue`: another bounded run is justified by fresh evidence and an explicit next plan
- `blocked`: an external dependency or missing permission prevents progress
- `handoff`: the next owner should be a different skill, worker, or operator

`remaining_blockers` must list only real blockers, not generic uncertainty.

## Loop Safety Gate

Before starting or continuing a repair loop, all of these must be true:

- [ ] the target PR / branch / workflow run is explicit
- [ ] the failing evidence is current enough to act on
- [ ] the next verification step is concrete
- [ ] the stop condition for this run is explicit
- [ ] the loop is still a CI iteration problem rather than design drift

If any box is false, stop and route back to `github`, `design`, `debugging`, or
the user.

## Interaction Protocol

- Re-ground every attempt in concrete failing evidence instead of assuming the
  prior hypothesis is still right.
- Ask only when repository identity, write authority, or the requested retry
  boundary is ambiguous enough to risk acting on the wrong target.
- Prefer one bounded causal repair per attempt over multi-cause speculative batching.
- If CI is green locally but still red remotely, separate "likely fixed" from
  "confirmed fixed" in the report.

## Delegation Protocol

- Use `delegate_patch` when the repair is bounded but benefits from isolated execution.
- Keep delegated objectives narrow: one failing check family, one review thread,
  or one root-cause hypothesis per child run.
- Inspect `subagent_status` before merging or retrying; do not guess whether a
  delegated attempt produced a usable patch or only diagnosis.

## Handoff Expectations

- `ci_snapshot` should let the next owner see the exact baseline without
  reopening the whole CI surface.
- `iteration_plan` should say what this bounded run will try, how success is
  checked, and what ends the attempt.
- `iteration_report` should distinguish diagnosis, code change, local
  verification, and remote CI posture.
- `remaining_blockers` should list only concrete blockers with the next owner or
  authority boundary named explicitly.

## Stop Conditions

- target repository or PR identity is unresolved
- the requested write exceeds the current effect or permission posture
- failing evidence is stale enough that a new baseline is required
- the loop has become a deeper design or debugging problem instead of CI iteration

## Anti-Patterns

- retrying the same fix without fresh evidence
- collapsing diagnosis, patching, push, and remote waiting into one opaque step
- treating green local checks as proof that remote CI is resolved
- storing loop narrative inside `iteration_fact`

## Example

Input: "Iterate on this PR until the failing type-check and lint jobs are fixed, and stop if the failure is external."

Output: `ci_snapshot`, `iteration_plan`, `iteration_report`, `remaining_blockers`.
