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
  "skill_contract": {
    "outputs": ["runtime_trace", "session_summary", "artifact_findings"],
    "effects": {
      "allowed": ["workspace_read", "local_exec", "runtime_observe"],
      "denied": ["workspace_write"]
    },
    "default_lease": { "max_tool_calls": 80, "max_tokens": 160000 }
  },
  "skill_scaffold": "SKILL.md with v2 anatomy: Iron Law, 4-phase workflow with failure branches, 1 script, decision protocol, red flags, rationalizations table, concrete example with real JSON"
}
```
