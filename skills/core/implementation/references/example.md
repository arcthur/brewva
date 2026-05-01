# Concrete Example

Input: "Expose overlay origins in `.brewva/skills_index.json` and verify generated skill artifacts stay out of subagent patch sets."

Output:

```json
{
  "change_set": {
    "summary": "Extend the skill index contract with overlay provenance and emit it from the runtime registry write path.",
    "rationale": "Inspect consumers need the generated index to explain where a loaded skill came from without re-scanning the workspace or widening runtime root exports.",
    "intentional_non_changes": [
      "Did not change routing-scope construction rules or make gateway recompute skill metadata."
    ]
  },
  "files_changed": [
    "packages/brewva-runtime/src/domain/skills/types.ts",
    "packages/brewva-runtime/src/domain/skills/registry.ts",
    "test/contract/runtime/skills-discovery.contract.test.ts",
    "test/unit/gateway/subagent-workspace.unit.test.ts"
  ],
  "verification_evidence": {
    "commands_run": [
      { "cmd": "bun run check", "exit_code": 0, "note": "typecheck + lint clean" },
      {
        "cmd": "bun test test/contract/runtime/skills-discovery.contract.test.ts test/unit/gateway/subagent-workspace.unit.test.ts",
        "exit_code": 0,
        "note": "overlay provenance serialization and generated-artifact ignore behavior both pass"
      }
    ],
    "scope_drift_check": {
      "within_scope": true,
      "drifted_files": [],
      "target_coverage": 1.0
    }
  }
}
```
