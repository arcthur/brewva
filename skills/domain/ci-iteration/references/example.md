# Concrete Example

Input: "Fix the failing typecheck on PR #42 and stop if it turns out to be an architecture issue."

Output:

```json
{
  "ci_snapshot": {
    "pr": 42,
    "branch": "fix/type-check-regression",
    "failing_checks": [{ "name": "typecheck", "conclusion": "FAILURE" }],
    "passing_count": 6,
    "failing_count": 1,
    "pending_count": 0
  },
  "iteration_plan": {
    "mode": "repair_local",
    "in_scope": ["typecheck"],
    "verification": "bun run check",
    "stop_condition": "typecheck passes locally OR root cause is a missing interface contract"
  },
  "iteration_report": {
    "attempt": 1,
    "change": "Added type guard in normalize.ts:47",
    "local_verification": "bun run check — 0 errors",
    "remote_status": "pending — pushed, awaiting CI",
    "outcome": "done"
  },
  "remaining_blockers": []
}
```
