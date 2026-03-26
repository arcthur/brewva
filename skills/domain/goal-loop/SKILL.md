---
name: goal-loop
description: Use bounded multi-run continuity when progress requires repeated execution,
  explicit cadence, and objective iteration facts.
stability: experimental
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
consumes:
  - design_spec
  - execution_plan
  - verification_evidence
requires: []
---

# Goal Loop Skill

## Intent

Represent bounded continuity explicitly when progress depends on repeated runs,
objective feedback, and explicit timing for the next attempt.

`goal-loop` is not a generic implementation skill. It is the protocol skill
that keeps objective optimization and scheduler-backed continuity honest.

## Trigger

Use this skill when:

- the user asks to continue work over time
- repeated bounded runs are required to converge
- the next run needs explicit cadence or scheduler timing
- progress can be judged from objective iteration facts

Do not use this skill when:

- one normal execution pass can finish the work
- the task is still mostly design ambiguity rather than bounded execution
- progress cannot be measured with explicit observables

## Workflow

### Step 1: Preflight - prove loop viability

Before entering the loop, all of the following must hold:

1. Scope resolves. The proposed `scope` must map to real files or an explicit
   domain boundary.
2. Cadence is explicit. If another run is expected later, the contract must say
   when and how it will be triggered.
3. Metric is mechanical. The metric source must produce a parseable number.
4. Guard is runnable. If a guard exists, run it once before the loop starts.
5. Convergence is observable. The convergence predicate must be objective.
6. Escalation is concrete. The next owner on stuck or blocked states must be
   named explicitly.
7. Baseline is recorded. Emit a `metric_observation` fact before run 1 with
   `iteration_key = "<loop_key>/run-1/baseline"` and
   `source = "goal-loop:<loop_key>"`.

If any of these fail, route back to `design` or ask the user. Do not start a
fake loop.

### Step 2: Encode the loop contract

Produce:

- `loop_contract`: the durable contract for the whole bounded loop
- `continuation_plan`: the next-run handoff packet with timing and ownership

### Loop Contract Fields

Every `loop_contract` must include these fields:

| Field                   | Type     | Required | Description                                                            |
| ----------------------- | -------- | -------- | ---------------------------------------------------------------------- |
| `goal`                  | string   | yes      | Plain-language objective with a concrete target when possible          |
| `scope`                 | string[] | yes      | Files or domain boundaries the loop may touch                          |
| `cadence`               | object   | yes      | How and when the next bounded run should happen                        |
| `continuity_mode`       | string   | yes      | `inherit` or `fresh`; prefer `inherit` for scheduler-backed continuity |
| `loop_key`              | string   | yes      | Stable identifier for the whole loop across parent and child sessions  |
| `baseline`              | object   | yes      | Starting metric value and the evidence source that produced it         |
| `metric`                | object   | yes      | Metric key, direction, unit, aggregation, and optional `min_delta`     |
| `guard`                 | object   | no       | Secondary safety check that must remain green                          |
| `convergence_condition` | object   | yes      | Explicit observable predicate                                          |
| `max_runs`              | number   | yes      | Safety rail for the whole loop                                         |
| `escalation_policy`     | object   | yes      | Named next owner plus the trigger for escalation                       |

### Identity Discipline

The protocol must keep three identities distinct:

- `loop_key`: stable across the whole loop
- `run_key`: unique for one bounded run
- `iteration_key`: unique for one observation point inside a run

Recommended shape:

```text
loop_key      = "coverage-raise-2026-03-22"
run_key       = "<loop_key>/run-3"
iteration_key = "<run_key>/iter-2"
```

Baseline observations stay inside the same hierarchy:

```text
baseline iteration_key = "<loop_key>/run-1/baseline"
```

All recorded facts use:

```text
source = "goal-loop:<loop_key>"
```

If the loop schedules future work, `schedule_intent.goalRef` should use the same
source-grade identifier.

### Step 3: Record objective iteration evidence

Each iteration must persist only objective facts:

1. `metric_observation`
2. `guard_result` when a guard exists

Interpretation stays in skill outputs, not in `iteration_fact` writes. After
recording facts:

- compute the observed delta versus the prior comparable baseline
- classify the run in `iteration_report`
- when the run stops, converges, escalates, or hands off, explain that outcome
  in `convergence_report`

Evidence discipline:

```text
IF metric improved AND delta > min_delta AND (no guard OR guard passed):
    outcome = "progress"
ELIF metric improved AND guard failed:
    outcome = "guard_regression"
ELIF metric improved AND delta <= min_delta:
    outcome = "below_noise_floor"
ELIF metric unchanged or worse:
    outcome = "no_improvement"
ELIF execution crashed:
    outcome = "crash"
```

When reading prior history, use the inherited-run lineage view and narrow with:

- `source = "goal-loop:<loop_key>"`

Do not use "latest event in the current session" as a proxy for loop history.

### Step 4: Decide ownership and next-run timing

At the end of each bounded run, decide whether the next move:

- stays in `goal-loop`
- hands off to `design`
- hands off to `implementation`
- hands off to `debugging`
- hands off to `runtime-forensics`
- stops and escalates to the user or operator

If the loop continues, `continuation_plan` must say what happens next and when
it happens. If the next run is scheduler-backed, create or update
`schedule_intent` explicitly instead of leaving timing implied.

## Interaction Protocol

- Ask only when the objective, cadence, convergence predicate, or escalation
  path is too weak to make the loop safe.
- Re-ground every loop proposal in concrete observables: what the next run will
  try, what evidence counts as progress, and what condition ends the loop.
- Explain continuity honestly. The runtime stores facts and schedule state; it
  does not make long-running work magically safe.
- Prefer a narrower scope and one causal unit per iteration over a larger but
  harder-to-explain batch of changes.

## Convergence Protocol

- Use explicit, observable predicates. If no predicate exists, stop and route
  back to `design`.
- Treat `max_runs` as a safety rail, not the business definition of done.
- Apply `min_delta` when the metric is noisy. Improvements below the noise floor
  do not count as progress.
- A run is useful only if it improves the metric, protects the guard, reduces
  uncertainty, or produces a stronger handoff packet.
- If the last several iterations show flat metrics, repeated guard regression,
  or no stronger handoff packet, re-read the full in-scope context, inspect
  lineage-scoped fact history, and either change strategy or escalate
  explicitly.

## Handoff Expectations

- `loop_contract` should make later runs impossible to reinterpret casually. It
  must include cadence, continuity mode, loop identity, metric, convergence
  predicate, and escalation path.
- `iteration_report` should include the objective slice, `iteration_key`,
  fact references, numeric delta, guard status, observed outcome, and
  one-sentence summary.
- `convergence_report` should include the `run_key`, status, reason code,
  metric trajectory summary, and the observable evidence for continue or stop.
- `continuation_plan` should define the next run objective, next owner, next run
  trigger, next run timing, and the evidence the next run must gather.

## Exit And Ownership Protocol

- Stay in `goal-loop` only while it is coordinating bounded continuity plus
  objective iteration evidence.
- Hand off to `design` when the contract or convergence predicate is unclear.
- Hand off to `implementation` when the next move is straightforward execution.
- Hand off to `debugging` or `runtime-forensics` when failure evidence, not loop
  coordination, is the main problem.
- Return to `goal-loop` only when new evidence, new timing, or a narrower next
  iteration justifies another bounded run.

## Stop Conditions

- one normal execution pass can finish the task
- convergence cannot be defined from observable runtime signals
- cadence or scheduling is still undefined
- the real work is still design or implementation, not bounded continuity

## Anti-Patterns

- routing ordinary complex implementation here by default
- writing "keep trying until done" with no explicit convergence logic
- recording facts without stable `loop_key`, `run_key`, and `iteration_key`
- reading only the current child session and pretending it represents loop history
- using continuity as a substitute for explicit next-run timing

## Example

Input: "Keep improving the migration verification loop over the next few days.
Stop when the P0 checklist is fully green or the loop escalates after repeated
flat or regressing runs."

Output: `loop_contract`, `iteration_report`, `convergence_report`,
`continuation_plan`.
