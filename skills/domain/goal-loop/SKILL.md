---
name: goal-loop
description: Bounded repeated improvement loop with cadence, continuation state, and objective
  convergence checks.
selection:
  when_to_use: Use when progress requires repeated bounded runs with explicit cadence, continuation
    state, and objective convergence checks.
references:
  - references/convergence-patterns.md
  - references/handoff-patterns.md
  - references/bounded-optimization-protocol.md
  - references/loop-contract-schema.md
  - references/identity-discipline.md
  - references/example.md
  - references/rationalizations.md
invariants:
  - invariants/preflight.md
  - invariants/loop-contract.md
  - invariants/outcome-classification.md
---

# Goal Loop Skill

## The Iron Law

```
NO LOOP WITHOUT OBSERVABLE CONVERGENCE PREDICATE
```

If convergence cannot be defined from observable runtime signals, route to
`plan`. Do not start a fake loop.

## When to Use

- The user asks to continue work over time
- Repeated bounded runs are required to converge on a metric
- The next run needs explicit cadence or scheduler timing

**Do NOT use when:**

- One normal execution pass can finish the work
- The task is still planning ambiguity, not bounded execution
- Progress cannot be measured with explicit observables

## Workflow

### Phase 1: Preflight — prove loop viability

Apply `invariants/preflight.md` to the 7 preflight conditions. All must pass
before entering the loop.

**If any check fails**: Route to `plan` or ask the user. Do not start the loop.
**If all pass**: Proceed to Phase 2.

### Phase 2: Encode the loop contract

Build the `loop_contract` JSON and validate it with
`invariants/loop-contract.md`.
Record a baseline `metric_observation` fact before run 1.

See `references/loop-contract-schema.md` for required fields.
See `references/identity-discipline.md` for `loop_key`/`run_key`/`iteration_key`.

**If validation fails**: Fix missing fields before proceeding.

### Phase 3: Record objective iteration evidence

Each iteration persists only objective facts via `iteration_fact`:
`metric_observation` and `guard_result` (when a guard exists).

Apply `invariants/outcome-classification.md` with the current metric and guard
data to get the deterministic outcome classification.

### Phase 4: Decide ownership and next-run timing

Based on the outcome from Phase 3:

- `progress` — continue in `goal-loop`, emit `continuation_plan`
- `below_noise_floor` (3+ consecutive) — escalate to `plan`
- `guard_regression` — hand off to `debugging`
- `crash` — hand off to `runtime-forensics`
- `no_improvement` — re-read context, change strategy or escalate

## Invariants

- `invariants/outcome-classification.md` — Deterministic convergence outcome classifier.
  Input: metric_improved, delta, min_delta, guard_passed, execution_crashed.
  Output: outcome + reason.
- `invariants/loop-contract.md` — Validates loop_contract JSON against schema.
  Output: valid, missing_fields, warnings.
- `invariants/preflight.md` — Checks 7 preflight conditions.
  Output: ready, checklist, blocking items.

## Decision Protocol

- Which observable metric and `min_delta` actually determine progress here?
- What deterministic outcome did `invariants/outcome-classification.md` return, and what
  owner does that imply next?
- Is another run still justified by cadence, `max_runs`, and fresh evidence, or
  would it just repeat the same loop state?
- If the last runs are flat, is this a strategy problem for `plan`, a defect
  for `debugging`, or a runtime failure for `runtime-forensics`?
- What evidence must the next owner inherit so they can continue without
  reconstructing loop history?

## Red Flags — STOP

If you catch yourself thinking any of these, STOP:

- "Keep trying until done" — without explicit convergence logic
- "One more run" — when last 3 runs showed no improvement
- "Metric looks close enough" — when delta is below min_delta
- "I'll figure out the cadence later" — cadence must be explicit before loop starts
- "The metric will eventually improve" — hope is not a convergence predicate

## Common Rationalizations

See `references/rationalizations.md` for the anti-pattern table.

## Concrete Example

See `references/example.md` for the grounded example output shape.

## Handoff Expectations

- `loop_contract` must include cadence, continuity mode, loop identity, metric,
  convergence predicate, and escalation path.
- `iteration_report` must include iteration_key, fact references, numeric delta,
  guard status, observed outcome, and summary.
- `convergence_report` must include run_key, status, reason code, and metric trajectory.
- `continuation_plan` must define next owner, next objective, and evidence for handoff.

## Stop Conditions

- One normal execution pass can finish the task
- Convergence cannot be defined from observable signals
- Cadence or scheduling is still undefined
- The real work is planning or implementation, not bounded continuity
