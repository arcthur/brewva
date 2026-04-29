# Goal Loop Preflight Invariant

Use this invariant before starting a bounded loop.

Required checks:

- `scope_resolves`: scope maps to real files or an explicit domain boundary
- `cadence_explicit`: next run timing and trigger mechanism are explicit
- `metric_mechanical`: metric source produces a parseable number
- `convergence_observable`: convergence predicate is objective and observable
- `escalation_concrete`: next owner on stuck or blocked state is named explicitly
- `baseline_recorded`: baseline metric observation fact is recorded

Optional check:

- `guard_runnable`: guard check can be executed when a guard is declared; null means no guard is declared

Rules:

- Missing required checks fail preflight.
- False required checks fail preflight.
- False `guard_runnable` fails preflight.
- Null `guard_runnable` passes with a note that no guard is declared.

Output:

- `ready`: boolean
- `checklist`: array of check results
- `blocking`: array of failed required checks
