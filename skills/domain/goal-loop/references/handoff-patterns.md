# Handoff Patterns Reference

Load this reference when `goal-loop` is unsure which owner should take the next
step of a run or how to carry artifacts across the cascade boundary.

## Owner Selection Matrix

| Situation                                            | Next owner                           | Carry forward                                               | Why                                                      |
| ---------------------------------------------------- | ------------------------------------ | ----------------------------------------------------------- | -------------------------------------------------------- |
| Goal contract is still fuzzy                         | `design`                             | goal statement, constraints, failed contract draft          | Loop should not own design ambiguity                     |
| Plan exists and the next run is straightforward work | `implementation`                     | current run objective, scoped task items, design artifacts  | Keep happy-path work in the implementation boundary      |
| Main question is whether the work is now proven      | `implementation` + verification gate | files changed, claimed success signal, prior evidence       | Verification is a runtime phase, not a public skill load |
| Repeated failures or no new runtime evidence         | `runtime-forensics`                  | latest failure artifact, verification outcome, current plan | Reconstruct the trace before proposing more edits        |
| A root cause must be isolated before more edits      | `debugging`                          | failing command, error output, hot path                     | Root-cause analysis stays distinct from execution        |

## Canonical Cascades

### Delivery-first loop

```text
goal-loop -> design -> implementation -> runtime verification -> goal-loop
```

Use when the loop repeatedly refines and ships bounded chunks with explicit proof.

### Failure-contained loop

```text
goal-loop -> runtime-forensics -> debugging -> implementation -> runtime verification -> goal-loop
```

Use when the loop encounters a concrete failure and should return only after a validated next move exists.

### Contract repair loop

```text
goal-loop -> design -> goal-loop
```

Use when the blocker is a bad goal contract rather than an implementation bug.

## Minimum Carry-Forward Packet

Every `LOOP_HANDOFF` should preserve:

- current run number
- objective slice attempted
- latest evidence or failure signal
- current convergence condition
- explicit reason for handoff

Suggested shape:

```text
LOOP_HANDOFF
- target_owner: "<skill or runtime phase>"
- reason: "<handoff trigger>"
- carry_forward:
  - "run=<N>"
  - "objective_slice=<what was attempted>"
  - "evidence=<latest result>"
  - "convergence=<current predicate>"
```

## Return Criteria Back to `goal-loop`

`goal-loop` should resume ownership only when at least one of these is true:

- a new executable plan exists
- a blocker has been resolved with fresh evidence
- a narrower next step is defined and still serves the original loop goal

If none are true, stay in the owning skill instead of bouncing ownership back prematurely.

## Anti-Patterns

- handing off to `runtime-forensics` with no concrete runtime failure signal
- treating verification as a public skill load instead of a runtime phase
- using `goal-loop` as a generic container for unresolved design work
- returning to `goal-loop` without changing evidence, plan, or ownership rationale
