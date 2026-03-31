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
- `deliberation_memory`
- `knowledge_capture`
- `knowledge_search`
- `precedent_audit`
- `precedent_sweep`
- `obs_query`
- `obs_slo_assert`
- `obs_snapshot`
- `optimization_continuity`
- `ledger_query`
- `iteration_fact`
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

- `lsp_*`, `toc_*`, `look_at`, `read_spans`, `grep`, and `ast_grep_*` resolve
  file access against the current task target roots; when a task target
  descriptor is present they cannot escape the allowed roots
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
- `deliberation_memory`
- `knowledge_capture`
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
- `tape_handoff`
- `tape_info`
- `tape_search`

These tools are the preferred path for evidence reuse and replay inspection.

Scope notes:

- `exec` shares the same target-root descriptor as code-navigation tools;
  `exec.workdir` must stay inside the current task target roots before host or
  sandbox routing is evaluated
- `process` is the explicit follow-up surface for background `exec` sessions;
  long-running commands are not an implicit hidden control plane

`workflow_status` is advisory only. It derives workflow status and ship posture
from runtime events and session state, but it does not prescribe or
enforce a workflow path. The default hosted path does not maintain a hidden
workflow brief; inspection happens when the model or operator explicitly reads
this surface.

`deliberation_memory` is the explicit inspection surface for deliberation
artifacts that would otherwise only appear through hosted context injection.
It lists retained artifacts, shows retention metadata, and runs query-scored
retrieval without creating new memory or mutating runtime truth.
Repository-scoped retrieval filters repository artifacts to the current task
target roots instead of mixing unrelated repositories that share a workspace.

`knowledge_search` is the explicit repository-native precedent retrieval
surface. It searches `docs/solutions/**` first, then adjacent bootstrap
knowledge roots such as architecture, reference, research, troubleshooting, and
incident docs when needed. Results carry `source_type`, `authority_rank`, and
`freshness` so planning and review can inspect repository precedent without
pretending that hidden memory is authoritative. Retrieval is query-intent-aware:
`precedent_lookup` prefers solution and incident precedents, while
`normative_lookup` prefers stable docs; the returned `authority_rank` still
follows the canonical authority table rather than inventing a second ranking
scheme.

`precedent_audit` is the explicit repository-maintenance inspection surface for
authority overlap and stale routing. It compares a candidate or existing
solution record against stable docs and sibling precedents so contradiction
handling remains explicit instead of being flattened into silent write-back.

`precedent_sweep` is the explicit repository-wide maintenance surface. It
scans `docs/solutions/**` on demand and aggregates actionable stale-routing,
overlap, and invalid-record findings without turning broad maintenance sweeps
into a default hosted path.

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
- browser artifact path rules are stricter than task-target-root scoping for
  code and exec tools; browser outputs remain workspace-root scoped even when a
  task targets external repositories
- `browser_snapshot`, `browser_diff_snapshot`, and `browser_get` with
  `field=text` retain workspace artifacts; when outputs are too large, hosted
  sessions expose distilled summaries to the model instead of feeding the full
  page content back verbatim

### Recovery, Scheduling, And Task State

- `resource_lease`
- `session_compact`
- `deliberation_memory`
- `rollback_last_patch`
- `optimization_continuity`
- `schedule_intent`
- `task_set_spec`
- `task_add_item`
- `task_update_item`
- `task_record_acceptance`
- `task_record_blocker`
- `task_resolve_blocker`
- `task_view_state`

### Skills And Delegation

- `skill_load`
- `skill_complete`
- `skill_promotion`
- `subagent_run`
- `subagent_fanout`
- `subagent_status`
- `subagent_cancel`
- `worker_results_merge`
- `worker_results_apply`

Naming taxonomy:

- `subagent_*` is the stable agent-facing tool family for delegated child runs
- runtime/session APIs use `delegation` for the durable child-run ledger and
  delivery handoff state
- `worker_results_*` operates only on `WorkerResult` artifacts emitted by
  patch-producing delegated runs

`skill_promotion` operates on post-execution promotion drafts derived from
`skill_completed` evidence. Promotion materializes review packets under
`.brewva/skill-broker/materialized/<draft-id>/` and does not patch the live
skill catalog automatically.

`optimization_continuity` exposes deliberation-owned continuity artifacts folded
from `goal-loop` outputs, `schedule_intent`, and `iteration_fact` evidence. It
is inspection-only: use it to inspect continuation, convergence, and escalation
helpers without turning runtime execution into a hidden optimizer. The
`attention` action is the operator-oriented view for overdue, escalated, or
long-running lineages.

## Governance Metadata

Managed Brewva tools expose exact metadata on the definition object:

- `brewva.surface`
- `brewva.governance`

`brewva.governance` declares:

- `effects`
- `defaultRisk`
- `boundary`
- `rollbackable`

Current public boundary vocabulary:

- `safe`
- `effectful`

`effectful` does not mean "always requires approval". Some `effectful` tools
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

## `iteration_fact`

Records or inspects durable objective iteration facts without creating a
runtime-owned optimizer.

Supported actions:

- `record_metric`
- `record_guard`
- `list`

Canonical parameters vary by action:

- `record_metric`
  - `metric_key`, `value`, optional `unit`, `aggregation`, `sample_count`,
    `iteration_key`, required `evidence_refs`, optional `source`, `summary`
- `record_guard`
  - `guard_key`, `status`, optional `iteration_key`, required `evidence_refs`,
    optional `source`, `summary`
- `list`
  - optional `fact_kind`, `history_limit`, `metric_key`, `guard_key`,
    `iteration_key`, `source`, `session_scope`

Behavior:

- only objective facts should be recorded
- durable writes require concrete `evidence_refs`
- decision-like or convergence-control facts are not part of this tool's
  stable contract
- this tool does not prescribe the next step in a loop
- fact history is durable and replay-visible through `runtime.events.*`
- `session_scope` defaults to `current_session`
- cross-session lineage aggregation is a scheduler/control-plane concern, not
  part of the runtime iteration-fact tool contract
- `source` is the stable protocol filter for one loop or experiment lineage;
  bounded `goal-loop` runs should reuse `goal-loop:<loop_key>`
- derived workflow artifacts may surface metric and guard evidence as advisory
  working state

## `rollback_last_patch`

`rollback_last_patch` is the stable agent-facing tool id for rolling back the
latest tracked `PatchSet`. It maps to `runtime.tools.rollbackLastPatchSet(...)`
and the CLI `--undo` flow.

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
- `executionHints?`
- `contextRefs?`
- `contextBudget?`
- `completionPredicate?`
- `effectCeiling.boundary?` (`safe` | `effectful`)
  - optional per-run boundary narrowing only

Current delegation selector contract:

- `agentSpec?`
  - named delegated worker configuration
- `envelope?`
  - explicit runtime posture override or ad hoc runtime posture
- `skillName?`
  - explicit delegated semantic contract
- `fallbackResultMode?`
  - transport-level fallback schema for ad hoc runs without `skillName`
- `executionShape.resultMode?` (`exploration` | `review` | `verification` | `patch`)
- `executionShape.boundary?` (`safe` | `effectful`)
  - optional preset narrowing only
- `executionShape.model?`
- `executionShape.managedToolMode?` (`direct` | `runtime_plugin`)

When `skillName` is present, the delegated output contract is owned by the
skill document and validated through `skillOutputs`. There is no separate
packet-level required-output list.

Current delivery contract:

- `returnMode` (`text_only` | `supplemental`)
- `returnLabel?`
- `returnScopeId?`

Current wait contract:

- `waitMode` (`completion` | `start`)

Current mode contract:

- `mode` (`single` | `parallel`)

Semantics:

- built-in agent specs remain stable presets: `explore`, `plan`, `review`,
  `general`, `verification`, and `patch-worker`
- built-in review-lane delegates are also available for internal review fan-out:
  `review-correctness`, `review-boundaries`, `review-operability`,
  `review-security`, `review-concurrency`, `review-compatibility`, and
  `review-performance`
- built-in execution envelopes are:
  `readonly-scout`, `readonly-planner`, `readonly-reviewer`,
  `readonly-general`, `verification-runner`, and `patch-worker`
- `agentSpec` supplies default `skillName`, envelope, and executor posture
- `envelope` may be used alone for ad hoc objective-only delegation, but such
  runs should also supply `fallbackResultMode` unless a named `agentSpec`
  already implies it
- when both `agentSpec` and `envelope` are supplied, the request envelope may
  only narrow the agent spec envelope; widening is rejected
- when no explicit worker is supplied, the gateway resolves a default agent
  spec from `skillName`, `fallbackResultMode`, or `executionShape.resultMode`
- `safe` is the default execution boundary
- `effectful` is reserved for isolated write-capable child runners
- delegated child model selection is inspectable: explicit
  `executionShape.model`, target-pinned models, and policy-backed auto routes
  all persist route metadata on the run record
- `contextRefs` are typed refs and may include `sourceSessionId` and advisory
  `hash`
- when `skillName` is present, the child prompt includes the delegated skill
  body and output contracts directly, and successful outcomes may include
  `skillOutputs` plus runner-produced `skillValidation`
- successful child outcomes may include typed `data` alongside `summary`,
  `assistantText`, `evidenceRefs`, and `artifactRefs`
- typed outcome extraction currently uses one sentinel-wrapped JSON block; if
  extraction fails, the outcome degrades gracefully to text-only fields
- `supplemental` appends same-turn return context to the parent session
- late detached outcomes surface through replay-visible pending delegation
  outcome state instead of a proposal-backed return mode
- workspace-defined delegated workers live under `.brewva/subagents/*.json`
  and must declare `kind: "envelope"` or `kind: "agentSpec"` with `extends`
  support; markdown worker files under `.brewva/agents/*.md` and
  `.config/brewva/agents/*.md` default to `agentSpec`; their frontmatter
  compiles into the hosted worker spec and the body becomes additive authored
  instructions; overrides remain narrowing-only

`task_record_acceptance` is an operator-visible closure write. It only succeeds
when the active `TaskSpec` explicitly requires acceptance, and it does not
create rollback receipts.

## `subagent_status` And `subagent_cancel`

These tools inspect or stop existing delegated runs.

`subagent_status` returns run state plus:

- `agentSpec?`
- `envelope?`
- `skillName?`
- `modelRoute?`
- `live?`
- `cancelable?`
- `delivery.handoffState?`
- `artifactRefs?`

`subagent_cancel` records explicit cancellation intent. It does not erase run
history.

## `worker_results_merge` And `worker_results_apply`

Patch-producing delegated runs return `WorkerResult` artifacts for the parent.

- `worker_results_merge` is read-only and reports `empty | conflicts | merged`
- `worker_results_apply` mutates the parent workspace only after the parent
  explicitly adopts the merged result

## `skill_load`, `skill_complete`, And `skill_promotion`

Skill sequencing is model-native.

- `skill_load` activates the next skill explicitly
- `skill_complete` records output and runs completion/verification policy
  including parent-side `reviewEnsemble` synthesis for canonical review outputs
  and `learningResearch` synthesis for canonical planning-time proof-of-consult
  artifacts
- `skill_promotion` inspects or advances post-execution promotion drafts

There is no public skill-cascade or chain-control tool.

## `optimization_continuity`

Deliberation-owned bounded optimization inspection surface.

- folds `goal-loop` outputs, `schedule_intent`, and lineage-scoped
  `iteration_fact` evidence into reviewable continuity artifacts
- exposes continuation, convergence, escalation, and metric/guard trajectory
  without creating runtime-owned optimizer state
- exposes an `attention` view for overdue, stale, or long-running lineages that
  merit explicit operator review
- remains read-only even when used during recovery or critical context pressure
- treats `continuityMode=fresh` child sessions as separate branches instead of
  folding them into inherited lineage history

## `deliberation_memory`

Explicit inspection surface for deliberation memory artifacts.

- lists retained repository, user, agent, and loop memory artifacts
- repository-scoped retrieval filters repository artifacts to the current task
  target roots and preserves artifact identity instead of collapsing different
  repositories into a single workspace bucket
- shows evidence-backed retention metadata such as band, decay, and retention
  score
- supports query-scored retrieval so the model or operator can inspect why a
  memory artifact would be injected, instead of relying on hidden recall
- remains read-only and non-authoritative; it does not write new memory or
  widen kernel truth

## `knowledge_search`

Explicit repository-native precedent retrieval surface.

- searches `docs/solutions/**` first and may bootstrap from adjacent
  repository-native documentation when the solution corpus is sparse
- returns typed source metadata including `source_type`, `authority_rank`, and
  `freshness`
- supports `query_intent` so precedent reuse and normative lookup can share the
  same authority model without sharing one universal presentation order
- supports free-text query plus module, boundary, tag, problem-kind, status,
  and source-type filters
- remains read-only and task-target-root scoped
- is the preferred proof-of-consult surface before non-trivial planning,
  debugging, or review

## `knowledge_capture`

Deterministic repository-native precedent materialization surface.

- writes canonical solution records under `docs/solutions/**`
- validates investigation-grade capture requirements for `bugfix` and
  `incident` records before writing
- upserts by explicit or derived canonical path and skips pure timestamp churn
- surfaces a lightweight discoverability signal so the precedent layer does not
  become write-only
- preserves runtime authority boundaries by writing repository docs instead of
  creating a new runtime knowledge domain

## `precedent_audit`

Read-only repository-native precedent maintenance surface.

- audits a candidate or existing `docs/solutions/**` record against higher
  authority stable docs and sibling solution precedents
- returns an explicit maintenance recommendation instead of silently deciding
  whether a record should stay active, become stale, or be superseded
- validates displacement routing so stale or superseded records point to a
  stable doc or successor precedent rather than only to a promotion candidate
- validates promotion-candidate derivative links so warm-memory follow-up stays
  inside `.brewva/skill-broker/**`
- keeps contradiction handling explicit and repository-scoped without widening
  runtime authority

## `precedent_sweep`

Explicit repository-wide precedent maintenance sweep.

- scans `docs/solutions/**` under the primary target root and runs the same
  authority and stale-routing checks used by `precedent_audit`
- reports only actionable entries by default so broad maintenance remains
  explicit rather than noisy
- surfaces invalid solution docs, higher-authority overlap, and missing
  displacement routing as sweep findings
- remains read-only; it does not mutate records or schedule hidden cleanup

## `workflow_status`

Derived workflow inspection surface.

- summarizes discovery, strategy, planning, implementation, review, QA,
  verification, ship, and retro posture
- implementation may be `pending` when delegated patch results still await
  parent merge/apply
- surfaces the latest durable stall adjudication when the control plane has
  classified an idle session as `continue`, `nudge`,
  `compact_recommended`, or `abort_recommended`
- reports blockers such as stale review/QA/verification/ship evidence, task
  blockers, pending worker results, and pending delegation outcomes awaiting
  a parent turn; pending worker results and pending delegation outcomes both
  keep ship posture blocked until the parent explicitly resolves them
- optionally includes recent derived workflow artifacts

This tool is advisory. It does not create a runtime-owned chain planner and it
does not force the model to follow a suggested path. Calling the tool is the
explicit inspection step; the runtime does not run a hidden next-step
controller behind it.
