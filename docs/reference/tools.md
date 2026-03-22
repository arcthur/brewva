# Reference: Tools

Tool registry entrypoint: `packages/brewva-tools/src/index.ts`.

## Default Bundle

Default tools registered by `buildBrewvaTools()`:

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
- `output_search`
- `workflow_status`
- `schedule_intent`
- `tape_handoff`
- `tape_info`
- `tape_search`
- `resource_lease`
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

Optional channel tools:

- `agent_send`
- `agent_broadcast`
- `agent_list`

## Tool Families

### Code Navigation

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

Notes:

- `lsp_diagnostics.severity` canonical values are
  `error | warning | information | hint | all`
- `toc_document` is the preferred structural overview tool
- `read_spans` is the preferred bounded follow-up after `toc_document` or
  `toc_search`
- `ast_grep_search` / `ast_grep_replace` require the `sg` binary

### Execution And Observability

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
- `output_search`
- `workflow_status`
- `tape_handoff`
- `tape_info`
- `tape_search`

These tools are the preferred path for evidence reuse and replay inspection.

`workflow_status` is advisory only. It derives readiness from runtime events and
session state, but it does not prescribe or enforce a workflow path.

### Browser Automation

Browser tools wrap the local `agent-browser` CLI behind managed Brewva tool
metadata and governance.

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

Current posture:

- browser sessions are scoped per Brewva session
- default artifacts are written under `.orchestrator/browser-artifacts/<session>`
- explicit browser artifact paths must stay inside the workspace root
- `browser_snapshot`, `browser_diff_snapshot`, and `browser_get` with
  `field=text` retain workspace artifacts; when outputs are too large, hosted
  sessions expose distilled summaries to the model instead of feeding the full
  page content back verbatim

### Recovery, Scheduling, And Task State

- `resource_lease`
- `session_compact`
- `rollback_last_patch`
- `schedule_intent`
- `task_set_spec`
- `task_add_item`
- `task_update_item`
- `task_record_blocker`
- `task_resolve_blocker`
- `task_view_state`

### Skills And Delegation

- `skill_load`
- `skill_complete`
- `subagent_run`
- `subagent_fanout`
- `subagent_status`
- `subagent_cancel`
- `worker_results_merge`
- `worker_results_apply`

## Governance Metadata

Managed Brewva tools expose exact metadata on the definition object:

- `brewva.surface`
- `brewva.governance`

`brewva.governance` declares:

- `effects`
- `defaultRisk`
- `boundary`

Current public boundary vocabulary:

- `safe`
- `effectful`

`effectful` does not mean “always requires approval”. Some `effectful` tools
are rollbackable and execute directly; approval is required only when the tool's
exact governance descriptor says so.

Managed Brewva tools accept both `camelCase` and `snake_case` parameter keys.
This reference shows the canonical agent-facing spellings only.

## Tool Surface Layers

The static registry is larger than the visible per-turn surface.

Current layering:

- `base tools`
  - always-on session, recovery, and inspection tools
- `skill-informed tools`
  - tools implied by the active skill's execution hints and effect policy
- `operator tools`
  - observability and control tools that are hidden by default unless routing
    scope or explicit `$tool_name` disclosure requests expose them

Visible surface does not grant authority on its own. Runtime effect gating is
the fail-closed backstop.

`tool_surface_resolved` records the visible surface chosen for the turn.

## `resource_lease`

Requests, lists, or cancels temporary budget expansions for the active skill.

Parameters:

- `action` (`request` | `list` | `cancel`, required)
- `reason` (string, required for `request`)
- `leaseId` (string, required for `cancel`)
- `maxToolCalls` (number, optional)
- `maxTokens` (number, optional)
- `maxParallel` (number, optional)
- `ttlMs` (number, optional)
- `ttlTurns` (number, optional)
- `includeInactive` (boolean, optional, `list` only)
- `skillName` (string, optional, `list` only)

Behavior:

- leases are budget-only
- leases never widen effect authority
- lease requests are clamped by the skill hard ceiling

## `subagent_run` And `subagent_fanout`

Delegation entrypoints:

- `subagent_run` for one run
- `subagent_fanout` for parallel runs

Current packet contract:

- `objective`
- `deliverable?`
- `constraints?`
- `sharedNotes?`
- `activeSkillName?`
- `entrySkill?`
- `requiredOutputs?`
- `executionHints?`
- `contextRefs?`
- `contextBudget?`
- `effectCeiling.boundary?` (`safe` | `effectful`)

Current delivery contract:

- `returnMode` (`text_only` | `supplemental`)
- `returnLabel?`
- `returnScopeId?`

Current wait contract:

- `waitMode` (`completion` | `start`)

Current mode contract:

- `mode` (`single` | `parallel`)

Semantics:

- `safe` is the default execution boundary
- `effectful` is reserved for isolated write-capable child runners
- `supplemental` appends same-turn return context to the parent session
- there is no proposal-backed return mode

## `subagent_status` And `subagent_cancel`

These tools inspect or stop existing delegated runs.

`subagent_status` returns run state plus:

- `live?`
- `cancelable?`

`subagent_cancel` records explicit cancellation intent. It does not erase run
history.

## `worker_results_merge` And `worker_results_apply`

Patch-producing delegated runs return `WorkerResult` artifacts for the parent.

- `worker_results_merge` is read-only and reports `empty | conflicts | merged`
- `worker_results_apply` mutates the parent workspace only after the parent
  explicitly adopts the merged result

## `skill_load` And `skill_complete`

Skill sequencing is model-native.

- `skill_load` activates the next skill explicitly
- `skill_complete` records output and runs completion/verification policy

There is no public skill-cascade or chain-control tool.

## `workflow_status`

Derived workflow inspection surface.

- summarizes planning, implementation, review, verification, and release
  readiness
- implementation may be `pending` when delegated patch results still await
  parent merge/apply
- reports blockers such as stale review/verification, task blockers, and
  pending worker results
- optionally includes recent derived workflow artifacts

This tool is advisory. It does not create a runtime-owned chain planner and it
does not force the model to follow a suggested path.
