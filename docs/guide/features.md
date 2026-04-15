# Features

This guide summarizes the major Brewva capability areas. It is intentionally
high-level. For the authoritative tool and skill inventories, use
`docs/reference/tools.md` and `docs/reference/skills.md`.

## Runtime Capabilities

- Skill contract activation, validation, and completion tracking
- Tool access policy checks, effect boundaries, and budget checks
- Evidence ledger recording and replay-visible governance receipts
- Task and truth state management with event-sourced replay
- Verification gates (`quick`, `standard`, `strict`)
- Receipt-bearing rollback and approval surfaces for reversible mutation flows
- Context budget tracking, pressure reporting, and compaction signaling
- Event-first runtime persistence, replay, and deterministic recovery
- Cost observability and threshold-based budget alerts
- Derived workflow artifacts and advisory workflow inspection surfaces
- Typed planning and delegated-worker handoff artifacts
- Durable stall adjudication surfaced through explicit inspection, not hidden
  planning loops
- Iteration-fact persistence and lineage-aware query for bounded optimization
  loops
- Typed narrative and deliberation memory inspection surfaces
- Repository-native precedent retrieval and write-back under `docs/solutions/**`

## Operator And Delivery Surfaces

- Interactive CLI and one-shot CLI entrypoints
- Replay-first session inspection through `brewva inspect`
- Multi-session project analysis through `brewva insights`
- Gateway control-plane daemon for local hosted-session orchestration
- Scheduler daemon mode for intent execution
- Telegram channel host mode and webhook ingress integration
- Multi-agent channel orchestration when `channels.orchestration.enabled=true`

## Managed Tool Families

The default managed tool bundle covers these families:

- code navigation and structural search: `lsp_*`, `toc_*`, `grep`,
  `ast_grep_*`, `git_*`
- command and browser execution: `exec`, `process`, `browser_*`
- replay and observability inspection: `cost_view`, `obs_*`, `ledger_query`,
  `workflow_status`, `tape_*`, `output_search`
- memory and precedent surfaces: `deliberation_memory`, `narrative_memory`,
  `knowledge_search`, `knowledge_capture`, `precedent_audit`,
  `precedent_sweep`, `iteration_fact`, `optimization_continuity`
- delegation and workflow control: `skill_*`, `subagent_*`,
  `worker_results_*`, `task_*`, `follow_up`, `schedule_intent`,
  `resource_lease`, `session_compact`, `rollback_last_patch`

Channel-specific A2A tools (`agent_send`, `agent_broadcast`, `agent_list`) are
not part of the default bundle. They are registered by channel runtime plugins
when orchestration is enabled.

For the exact tool names and surface classification, use
`docs/reference/tools.md`.

## Current Tool Name Index

The exact current managed tool names are:

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
- `git_status`
- `git_diff`
- `git_log`
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
- `narrative_memory`
- `deliberation_memory`
- `knowledge_capture`
- `recall_search`
- `recall_curate`
- `knowledge_search`
- `precedent_audit`
- `precedent_sweep`
- `obs_query`
- `obs_slo_assert`
- `obs_snapshot`
- `ledger_query`
- `iteration_fact`
- `output_search`
- `workflow_status`
- `follow_up`
- `schedule_intent`
- `optimization_continuity`
- `tape_handoff`
- `tape_info`
- `tape_search`
- `reasoning_checkpoint`
- `reasoning_revert`
- `session_compact`
- `rollback_last_patch`
- `worker_results_merge`
- `worker_results_apply`
- `skill_load`
- `skill_complete`
- `skill_promotion`
- `subagent_run`
- `subagent_fanout`
- `subagent_status`
- `subagent_cancel`
- `task_set_spec`
- `task_add_item`
- `task_update_item`
- `task_record_acceptance`
- `task_record_blocker`
- `task_resolve_blocker`
- `task_view_state`
- `resource_lease`

`recall_search` is the default prior-work recall surface. `tape_search`
remains available for session-local tape forensics, and `recall_curate`
remains an operator-only curation surface.

Channel-conditional A2A tools:

- `agent_send`
- `agent_broadcast`
- `agent_list`

## Skill And Delegation Model

Skill taxonomy is now split by role rather than exposing one flat public
catalog:

- public routable semantic territory is primarily carried by `core` and
  `domain` skills
- `operator` and `meta` skills are still loaded catalog entries, but they are
  usually hidden from the standard routable index unless routing scopes
  explicitly include them
- runtime/control-plane workflow semantics such as verification, finishing, and
  recovery are not public skills

Authoring layout still uses the four directory families:

- core: repository analysis, planning, implementation, review, QA, and ship
  flows
- domain: environment-specific or problem-specific specialties such as browser,
  GitHub, Telegram, structured extraction, and bounded goal loops
- operator: replay, runtime, and git-operations oriented surfaces
- meta: skill-authoring and self-improvement surfaces

Project overlays and shared project context tighten behavior without creating a
second public catalog.

Delegated workers are a separate control-plane surface from skills. The stable
public specialist set is `advisor`, `qa`, and `patch-worker`; internal review
lanes remain control-plane implementation detail rather than public taxonomy.

For routing behavior, catalog layout, and the full skill inventory, use:

- `docs/guide/category-and-skills.md`
- `docs/reference/skills.md`

## Current Skill Name Index

Core capability skills:

- `repository-analysis`
- `discovery`
- `learning-research`
- `strategy-review`
- `design`
- `pre-implementation`
- `implementation`
- `debugging`
- `review`
- `qa`
- `ship`
- `retro`
- `knowledge-capture`

Domain capability skills:

- `agent-browser`
- `ci-iteration`
- `frontend-design`
- `github`
- `telegram`
- `structured-extraction`
- `goal-loop`
- `predict-review`

Operator skills:

- `runtime-forensics`
- `git-ops`

Meta skills:

- `skill-authoring`
- `self-improve`

Project overlays:

- `repository-analysis`
- `design`
- `implementation`
- `debugging`
- `review`
- `runtime-forensics`

Shared project context:

- `critical-rules`
- `migration-priority-matrix`
- `package-boundaries`
- `runtime-artifacts`

## Related Docs

- `docs/guide/cli.md`
- `docs/guide/category-and-skills.md`
- `docs/guide/understanding-runtime-system.md`
- `docs/guide/orchestration.md`
- `docs/reference/tools.md`
- `docs/reference/skills.md`
