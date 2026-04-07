# Loop Identity Discipline

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
