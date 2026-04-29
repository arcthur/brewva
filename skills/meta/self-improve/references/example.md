# Concrete Example

Input: "The same bounded loop has stalled 3 times on guard-check regression. Use
iteration facts and review artifacts to decide what should change."

Output:

```json
{
  "improvement_hypothesis": {
    "pattern": "Guard-check regression after metric improvement",
    "occurrences": 3,
    "evidence": [
      {
        "source": "goal-loop:perf-opt",
        "iteration": 4,
        "fact": "guard_regressed",
        "metric": "p95_latency"
      },
      {
        "source": "goal-loop:perf-opt",
        "iteration": 7,
        "fact": "guard_regressed",
        "metric": "p95_latency"
      },
      {
        "source": "goal-loop:perf-opt",
        "iteration": 11,
        "fact": "guard_regressed",
        "metric": "p95_latency"
      }
    ],
    "root_cause": "Optimization steps do not run guard checks before committing, only after. Regressions are detected one iteration late."
  },
  "learning_backlog": [
    {
      "rank": 1,
      "fix": "Add pre-commit guard check to goal-loop optimization phase",
      "effort": "small",
      "evidence_refs": ["iter-4", "iter-7", "iter-11"]
    },
    {
      "rank": 2,
      "fix": "Add guard-regression counter to loop exit criteria",
      "effort": "medium",
      "evidence_refs": ["iter-7", "iter-11"]
    }
  ],
  "improvement_plan": "Add pre-commit guard check in goal-loop skill Phase 3. Target home: skills/domain/goal-loop/SKILL.md. Falsification: if next 3 iterations show zero guard regressions, the fix is validated."
}
```
