# Features

## Runtime Capabilities

- Skill contract activation and enforcement
- Tool access policy checks, effect boundaries, and budget checks
- Evidence ledger and digest injection
- Task/truth state management with event-sourced replay
- Verification gates (`quick`, `standard`, `strict`)
- Model-native review and repair with receipt-bearing rollback / approval surfaces
- Context budget tracking and compaction events
- Event-first runtime persistence and replay
- Cost observability and threshold-based budget alerts
- Derived workflow artifacts and explicit advisory inspection surfaces
- Objective iteration fact persistence and lineage-aware query for
  model-native optimization loops

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
- `browser_open`
- `browser_wait`
- `browser_snapshot`
- `browser_click`
- `browser_fill`
- `browser_get`
- `browser_screenshot`
- `browser_pdf`
- `browser_diff_snapshot`
- `browser_state_load`
- `browser_state_save`
- `browser_close`
- `process`
- `cost_view`
- `obs_query`
- `obs_slo_assert`
- `obs_snapshot`
- `ledger_query`
- `iteration_fact`
- `output_search`
- `workflow_status`
- `schedule_intent`
- `tape_handoff`
- `tape_info`
- `tape_search`
- `session_compact`
- `rollback_last_patch`
- `worker_results_merge`
- `worker_results_apply`
- `skill_load`
- `skill_complete`
- `subagent_run`
- `subagent_fanout`
- `subagent_status`
- `subagent_cancel`
- `task_set_spec`
- `task_add_item`
- `task_update_item`
- `task_record_blocker`
- `task_resolve_blocker`
- `task_view_state`
- `resource_lease`

Channel-conditional tools (available in a2a channels):

- `agent_send`
- `agent_broadcast`
- `agent_list`

Tool registry source: `packages/brewva-tools/src/index.ts`

## Skill Surface

- Core capability skills: `repository-analysis`, `discovery`, `strategy-review`, `design`, `implementation`, `debugging`, `review`, `qa`, `ship`, `retro`
- Domain capability skills: `agent-browser`, `frontend-design`, `github`, `telegram`, `structured-extraction`, `goal-loop`, `predict-review`
- Operator skills: `runtime-forensics`, `git-ops`
- Meta skills: `skill-authoring`, `self-improve`
- `goal-loop` is the bounded continuity and objective optimization protocol,
  not a generic implementation skill
- `predict-review` is an advisory multi-perspective debate skill built on
  public delegation tools and existing subagent profiles
- `self-improve` distills repeated evidence, including iteration-fact history,
  into explicit improvement hypotheses
- Project overlays: `repository-analysis`, `design`, `implementation`, `debugging`, `review`, `runtime-forensics`
- Shared project context: `critical-rules`, `migration-priority-matrix`, `package-boundaries`, `runtime-artifacts`

Runtime-owned workflow semantics, not public skills:

- verification
- finishing
- recovery
- compose-style workflow semantics

One common public delivery chain is:

`discovery -> strategy-review -> design -> implementation -> review -> qa -> ship -> retro`

The chain is a skill-layer convention, not a runtime-owned DAG. Verification,
derived workflow status, and ship advisories remain explicit runtime inspection
surfaces rather than default injected planning hints.

Skill roots:

- `skills/core`
- `skills/domain`
- `skills/operator`
- `skills/meta`
- `skills/project/shared`
- `skills/project/overlays`
