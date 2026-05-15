# Concrete Example

Input: "Check whether this branch is ready for a PR and tell me what still blocks release."

```json
{
  "ship_decision": "needs_follow_up",
  "ship_report": {
    "release_path": "PR handoff",
    "evidence_summary": {
      "review": "ready — approved with no blocking findings",
      "verifier": "pass — onboarding flow exercised, adversarial probe passed",
      "ci": "unknown — pipeline not yet triggered for latest push",
      "branch": "clean — no uncommitted changes, up to date with target"
    },
    "blocking_gates": ["ci"],
    "operator_next_step": "Trigger CI pipeline. Once green, PR is ready to open."
  },
  "release_checklist": [
    { "gate": "review", "status": "clear", "detail": "Approved, no blocking findings" },
    { "gate": "verifier", "status": "clear", "detail": "Pass with adversarial coverage" },
    { "gate": "ci", "status": "blocking", "detail": "Pipeline not yet run on latest commit" },
    { "gate": "branch", "status": "clear", "detail": "Clean, up to date" }
  ]
}
```
