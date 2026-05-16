# Executable Evidence Bridge

## Intent

Use executable evidence as the default proof model. Prefer reproducible commands over narrative claims.

## Priority

1. `COMMAND_EVIDENCE`: run concrete commands and capture pass/fail signals.
2. `TOOL_BRIDGE`: if commands cannot verify the target, provide a reusable `bash`/`python` tool spec for human execution.
3. `MISSING_INPUT`: only request input when both command execution and tool bridging are blocked.

## Skill-Type Adaptation

- **Mutation-capable owners** (`implementation`, `debugging`, `git`, `agent-browser` when it changes external state):
  - command execution is mandatory before conclusions.
  - fallback is `TOOL_BRIDGE` when execution is blocked.
- **Read-mostly owners** (`plan`, `review`, `repository-analysis`, `runtime-forensics`, `extract`):
  - use command-backed evidence when available.
  - do not edit files directly; emit `TOOL_BRIDGE` handoff when proof requires executable tooling.
- **Project overlays and shared project guidance** (`skills/project/overlays/*`, `skills/project/shared/*`):
  - tighten evidence expectations for the base owner.
  - do not become separate execution owners.

## `TOOL_BRIDGE` Template

```text
TOOL_BRIDGE
- purpose: "<what this script verifies or reproduces>"
- language: <bash|python>
- script_path: "<repo-relative path>"
- inputs:
  - "<arg/env>"
- outputs:
  - "<artifact/log/report>"
- run_command: "<exact command>"
- success_criteria:
  - "<observable pass signal>"
- failure_criteria:
  - "<observable fail signal>"
- owner_handoff: "<skill/user who should execute it>"
```

## Contract Note

In Brewva, structured producer outputs live in
`skills/producers/<name>.yaml`. Do not add `tool_bridge` to a
ProducerContract unless every producer run must emit it.

`TOOL_BRIDGE` should be treated as:

- a section in the skill's narrative report, and/or
- an optional producer artifact captured by the caller when executable proof
  cannot run in the current environment.

## Language Selection

- Prefer `bash` for command orchestration, wrappers, and lightweight environment checks.
- Prefer `python` for parsing logs, data validation, protocol checks, or structured report generation.

## Quality Bar

- The command or script must be deterministic enough to rerun.
- Success/failure criteria must be observable from output or artifacts.
- Avoid "manual inspection only" unless no automation path exists.
- If automation is impossible, explain the exact blocker and the minimum missing prerequisite.
