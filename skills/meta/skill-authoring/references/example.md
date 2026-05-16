# Concrete Example

Input: "Design a new runtime-forensics skill for Brewva."

Output:

```json
{
  "skill_spec": {
    "name": "runtime-forensics",
    "territory": "Runtime artifact inspection and causal trace reconstruction",
    "trigger": "Task asks what happened at runtime from artifact evidence",
    "non_goals": ["source-level debugging", "fix implementation", "hypothetical analysis"]
  },
  "skill_card": {
    "name": "runtime-forensics",
    "description": "Inspect runtime artifacts and reconstruct causal traces from durable evidence.",
    "selection": {
      "when_to_use": "Use when the task asks what happened at runtime from logs, events, WAL, or artifacts.",
      "triggers": ["runtime trace", "WAL replay", "artifact evidence"],
      "path_globs": ["packages/brewva-runtime/src/**", "test/**/runtime/**"]
    }
  },
  "producer_contract": {
    "producer": "runtime-forensics",
    "outputs": ["runtime_trace", "session_summary", "artifact_findings"],
    "output_contracts": {
      "runtime_trace": { "kind": "json", "min_items": 1 },
      "session_summary": { "kind": "text", "min_words": 20 },
      "artifact_findings": { "kind": "json", "min_items": 0 }
    }
  },
  "skill_scaffold": "SKILL.md with v2 anatomy: Iron Law, 4-phase workflow with failure branches, 1 script, decision protocol, red flags, rationalizations table, concrete example with real JSON"
}
```
