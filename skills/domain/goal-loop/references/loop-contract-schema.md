# Loop Contract Schema

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

Use `scripts/validate_loop_contract.py` to check a contract before entering the loop.
