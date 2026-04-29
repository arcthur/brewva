---
name: ci-iteration
description: Bounded repair loop for failing checks, PR feedback, current CI
  state, and local verification evidence.
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
    - delegation
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
consumes:
  - ci_findings
  - review_report
  - review_findings
  - verification_evidence
  - change_set
references:
  - references/example.md
  - references/rationalizations.md
scripts:
  - scripts/parse_ci_state.sh
  - scripts/check_loop_safety.sh
---

# CI Iteration Skill

## The Iron Law

```
NO RETRY WITHOUT FRESH EVIDENCE FROM THE LAST ATTEMPT
```

## When to Use

- The task centers on failing checks, PR review feedback, or repeated repair attempts
- The next move depends on current CI state plus local verification evidence
- A bounded retry loop needs explicit stop conditions

## When NOT to Use

- The work is still mostly discovery or design ambiguity
- There is no concrete PR, branch, or failing check to iterate on
- The user only wants a one-shot CI summary with no repair loop (use `github`)
- The failure is a deeper design or architecture problem, not a CI fix

## Workflow

### Phase 1: Resolve the repair target

Lock the target: repository, branch/PR, failing checks, and exit condition.

Run `scripts/parse_ci_state.sh <PR_NUMBER>` to get current check state.

**If the target is ambiguous**: Stop and clarify. Do not mutate code or remote state.
**If no failing checks exist**: Report clean state. Do not manufacture work.
**If resolved**: Proceed to Phase 2.

### Phase 2: Check loop safety

Run `scripts/check_loop_safety.sh` with the safety gate JSON on stdin.

**If `safe_to_continue` is false**: Stop. Address each item in `blocking` before proceeding.
**If safe**: Proceed to Phase 3.

### Phase 3: Plan the bounded attempt

Produce `ci_snapshot` (baseline) and `iteration_plan` naming:

- Chosen mode: `repair_local`, `delegate_patch`, or `review_only`
- Exact failing checks or review threads in scope
- Verification path for the next attempt
- Stop condition for this bounded run

**If the plan touches surfaces beyond the failing evidence**: Stop. Scope is drifting.
**If scoped**: Proceed to Phase 4.

### Phase 4: Execute one bounded attempt

1. Change only the surface justified by active CI or review evidence
2. Rerun the narrowest local verification that can falsify the fix
3. Record the outcome in `iteration_report`

Use `iteration_fact` for objective observations only — metric counts, guard results. Not narrative.

**If the fix introduces new failures**: Stop. Do not stack fixes.
**If clean**: Proceed to Phase 5.

### Phase 5: Decide exit

Choose exactly one:

- `done`: targeted failures resolved, verification evidence sufficient
- `continue`: fresh evidence justifies another bounded run — re-enter Phase 2
- `blocked`: external dependency or missing permission prevents progress
- `handoff`: route to a different skill, worker, or operator

Produce `remaining_blockers` listing only concrete blockers with the next owner named.

## Scripts

- `scripts/parse_ci_state.sh` — Input: PR number as CLI arg. Output: JSON with `failing_checks`, `passing_count`, `failing_count`, `pending_count`. Run at Phase 1.
- `scripts/check_loop_safety.sh` — Input: JSON on stdin with `target_pr`, `failing_evidence_current`, `next_verification_step`, `stop_condition`, `is_design_drift`. Output: JSON with `safe_to_continue`, `blocking`. Run at Phase 2 before every attempt.

## Decision Protocol

- Is the failing evidence current, or am I acting on stale state from a previous attempt?
- Is this still a CI iteration problem, or has it drifted into planning territory?
- Can I falsify this fix with a single narrowly-scoped local verification?
- If CI is green locally but red remotely, am I conflating "likely fixed" with "confirmed fixed"?

## Red Flags — STOP

If you catch yourself thinking any of these, STOP and return to Phase 1:

- "Same fix should work, let me just push again"
- "I'll fix this new failure too while I'm at it"
- "Local checks pass, so it's probably fine remotely"
- "One more attempt" (when already tried 2+)
- "I don't need to re-check CI state, nothing changed"

## Common Rationalizations

See `references/rationalizations.md` for the anti-pattern table.

## Concrete Example

See `references/example.md` for the grounded example output shape.

## Handoff Expectations

- `ci_snapshot` lets the next owner see the exact baseline without reopening the whole CI surface.
- `iteration_plan` says what this bounded run will try, how success is checked, and what ends the attempt.
- `iteration_report` distinguishes diagnosis, code change, local verification, and remote CI posture.
- `remaining_blockers` lists only concrete blockers with the next owner or authority boundary named.

## Stop Conditions

- Target repository or PR identity is unresolved
- The requested write exceeds the current effect or permission posture
- Failing evidence is stale enough that a new baseline is required
- The loop has become a deeper design or debugging problem
- Two consecutive attempts produced no measurable progress
