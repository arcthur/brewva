# Features

## Runtime Capabilities

- Skill contract selection and activation
- Tool access policy checks and budget checks
- Evidence ledger and digest injection
- Task/truth state management with event-sourced replay
- Verification gates (`quick`, `standard`, `strict`)
- Extension-side automatic debug loop with deterministic failure snapshots and handoff packets
- Context budget tracking and compaction events
- Event-first runtime persistence and replay
- Cost observability and threshold-based budget alerts

## Tool Surface

- `lsp_goto_definition`
- `lsp_find_references`
- `lsp_symbols`
- `lsp_diagnostics`
- `lsp_prepare_rename`
- `lsp_rename`
- `toc_document`
- `toc_search`
- `ast_grep_search`
- `ast_grep_replace`
- `look_at`
- `read_spans`
- `grep`
- `exec`
- `process`
- `cost_view`
- `obs_query`
- `obs_slo_assert`
- `obs_snapshot`
- `ledger_query`
- `output_search`
- `schedule_intent`
- `tape_handoff`
- `tape_info`
- `tape_search`
- `session_compact`
- `rollback_last_patch`
- `skill_load`
- `skill_complete`
- `skill_chain_control`
- `task_set_spec`
- `task_add_item`
- `task_update_item`
- `task_record_blocker`
- `task_resolve_blocker`
- `task_view_state`

Tool registry source: `packages/brewva-tools/src/index.ts`

## Skill Surface

- Core capability skills: `repository-analysis`, `design`, `implementation`, `debugging`, `review`
- Domain capability skills: `agent-browser`, `frontend-design`, `github`, `telegram`, `structured-extraction`, `goal-loop`
- Operator skills: `runtime-forensics`, `git-ops`
- Meta skills: `skill-authoring`, `self-improve`
- Project overlays: `repository-analysis`, `design`, `implementation`, `debugging`, `review`, `runtime-forensics`
- Shared project context: `critical-rules`, `migration-priority-matrix`, `package-boundaries`, `runtime-artifacts`

Runtime-owned phases, not public skills:

- verification
- finishing
- recovery
- compose-style chain planning

Skill roots:

- `skills/core`
- `skills/domain`
- `skills/operator`
- `skills/meta`
- `skills/project/shared`
- `skills/project/overlays`
