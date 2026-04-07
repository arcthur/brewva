---
name: goal-loop
description: Use when progress requires repeated bounded runs with explicit cadence,
  continuation state, and objective convergence checks.
stability: experimental
selection:
  when_to_use: Use when progress requires repeated bounded runs with explicit cadence, continuation state, and objective convergence checks.
  examples:
    - Set up a recurring execution loop for this task.
    - Continue this work over time with explicit cadence.
    - Run bounded iterations until this objective converges.
  phases:
    - execute
    - blocked
intent:
  outputs:
    - loop_contract
    - iteration_report
    - convergence_report
    - continuation_plan
  output_contracts:
    loop_contract:
      kind: json
      min_items: 8
    iteration_report:
      kind: json
      min_items: 5
    convergence_report:
      kind: json
      min_items: 4
    continuation_plan:
      kind: json
      min_items: 3
effects:
  allowed_effects:
    - workspace_read
    - memory_write
    - schedule_mutation
resources:
  default_lease:
    max_tool_calls: 70
    max_tokens: 140000
  hard_ceiling:
    max_tool_calls: 110
    max_tokens: 200000
execution_hints:
  preferred_tools:
    - read
    - iteration_fact
  fallback_tools:
    - schedule_intent
    - task_view_state
    - ledger_query
    - read_spans
    - grep
    - skill_complete
references:
  - skills/meta/skill-authoring/references/authored-behavior.md
  - references/convergence-patterns.md
  - references/handoff-patterns.md
  - references/bounded-optimization-protocol.md
  - references/loop-contract-schema.md
  - references/identity-discipline.md
scripts:
  - scripts/classify_outcome.py
  - scripts/validate_loop_contract.py
  - scripts/validate_preflight.py
consumes:
  - design_spec
  - execution_plan
  - verification_evidence
requires: []
---

# Goal Loop Skill

## The Iron Law

```
NO LOOP WITHOUT OBSERVABLE CONVERGENCE PREDICATE
```

If convergence cannot be defined from observable runtime signals, route to
`design`. Do not start a fake loop.

**Violating the letter of this rule is violating the spirit of this rule.**

## When to Use

- The user asks to continue work over time
- Repeated bounded runs are required to converge on a metric
- The next run needs explicit cadence or scheduler timing

**Do NOT use when:**

- One normal execution pass can finish the work
- The task is still design ambiguity, not bounded execution
- Progress cannot be measured with explicit observables

## Workflow

### Phase 1: Preflight — prove loop viability

Run `scripts/validate_preflight.py` with the 7 preflight conditions. All must
pass before entering the loop.

**If any check fails**: Route to `design` or ask the user. Do not start the loop.
**If all pass**: Proceed to Phase 2.

### Phase 2: Encode the loop contract

Build the `loop_contract` JSON and validate it with `scripts/validate_loop_contract.py`.
Record a baseline `metric_observation` fact before run 1.

See `references/loop-contract-schema.md` for required fields.
See `references/identity-discipline.md` for `loop_key`/`run_key`/`iteration_key`.

**If validation fails**: Fix missing fields before proceeding.

### Phase 3: Record objective iteration evidence

Each iteration persists only objective facts via `iteration_fact`:
`metric_observation` and `guard_result` (when a guard exists).

Run `scripts/classify_outcome.py` with the current metric and guard data to
get the deterministic outcome classification.

### Phase 4: Decide ownership and next-run timing

Based on the outcome from Phase 3:

- `progress` — continue in `goal-loop`, emit `continuation_plan`
- `below_noise_floor` (3+ consecutive) — escalate to `design`
- `guard_regression` — hand off to `debugging`
- `crash` — hand off to `runtime-forensics`
- `no_improvement` — re-read context, change strategy or escalate

## Scripts

- `scripts/classify_outcome.py` — Deterministic convergence outcome classifier.
  Input: metric_improved, delta, min_delta, guard_passed, execution_crashed.
  Output: outcome + reason.
- `scripts/validate_loop_contract.py` — Validates loop_contract JSON against schema.
  Output: valid, missing_fields, warnings.
- `scripts/validate_preflight.py` — Checks 7 preflight conditions.
  Output: ready, checklist, blocking items.

## Decision Protocol

- Which observable metric and `min_delta` actually determine progress here?
- What deterministic outcome did `scripts/classify_outcome.py` return, and what
  owner does that imply next?
- Is another run still justified by cadence, `max_runs`, and fresh evidence, or
  would it just repeat the same loop state?
- If the last runs are flat, is this a strategy problem for `design`, a defect
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

| Excuse                                  | Reality                                                                           |
| --------------------------------------- | --------------------------------------------------------------------------------- |
| "Complex work needs a loop by default"  | Most complex work needs `implementation`, not `goal-loop`                         |
| "One more run can't hurt"               | Each run burns tokens. Flat metrics = wrong strategy, not insufficient runs       |
| "The metric is noisy, ignore min_delta" | min_delta exists to filter noise. Ignoring it defeats the purpose                 |
| "Escalation feels like giving up"       | Escalation routes to the right owner. Continuing a stalled loop is the real waste |

## Concrete Example

Input: "Keep improving coverage. Stop when 85% or after 3 flat runs."

```json
{
  "loop_contract": {
    "goal": "Raise test coverage to 85%",
    "scope": ["packages/brewva-runtime/src/services/"],
    "cadence": { "type": "delay", "value": 900000 },
    "continuity_mode": "inherit",
    "loop_key": "coverage-raise-2026-04-06",
    "baseline": { "value": 70.0, "source": "bun test --coverage" },
    "metric": { "key": "coverage_pct", "direction": "up", "unit": "%", "min_delta": 1.0 },
    "convergence_condition": { "kind": "truth_resolved", "factId": "coverage_gte_85" },
    "max_runs": 12,
    "escalation_policy": { "trigger": "3 consecutive below_noise_floor", "next_owner": "design" }
  },
  "iteration_report": {
    "iteration_key": "coverage-raise-2026-04-06/run-4/iter-1",
    "metric_value": 72.1,
    "delta": -0.2,
    "guard_status": "pass",
    "outcome": "below_noise_floor",
    "summary": "Coverage unchanged. Delta -0.2 below min_delta 1.0."
  },
  "convergence_report": {
    "run_key": "coverage-raise-2026-04-06/run-4",
    "status": "escalate",
    "reason_code": "3 consecutive below_noise_floor",
    "metric_trajectory": [72.1, 72.3, 72.1]
  },
  "continuation_plan": {
    "next_owner": "design",
    "next_objective": "Redesign test strategy — remaining paths need DI refactor",
    "evidence_for_handoff": "3 runs below noise floor. Architectural change needed."
  }
}
```

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
- The real work is design or implementation, not bounded continuity
