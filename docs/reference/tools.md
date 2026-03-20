# Reference: Tools

Tool registry entrypoint: `packages/brewva-tools/src/index.ts`.

## LSP Tools

- `lsp_goto_definition`
- `lsp_find_references`
- `lsp_symbols`
- `lsp_diagnostics`
- `lsp_prepare_rename`
- `lsp_rename`

Defined in `packages/brewva-tools/src/lsp.ts`.

`lsp_symbols` supports:

- `scope=document`: `filePath` must point to a file. Directories return a friendly error.
- `scope=workspace`: `query` is required and the tool scans code files under `cwd` (using runtime parallel-read when enabled).

`lsp_diagnostics` returns `status=unavailable` with
`reason=diagnostics_scope_mismatch` when `tsc` fails but no diagnostics match
the requested file/severity scope.

`lsp_diagnostics.severity` canonical values are
`error|warning|information|hint|all`; `warn` and `info` are accepted as aliases
for `warning` and `information`.

## TOC Tools

- `toc_document`
- `toc_search`

Defined in `packages/brewva-tools/src/toc.ts`.

Current scope is TS/JS only (`.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`).
The tools use TypeScript parser-based structural extraction, not regex-only
symbol scans.

`toc_document` returns:

- parameter: `file_path`
- module summary (top-of-file comment, first line only)
- imports
- top-level functions
- top-level interfaces, type aliases, and enums
- classes plus public methods/getters/setters
- line spans for targeted follow-up reads
- `status=unavailable` with `reason=file_too_large` when the file exceeds the
  structural parse budget; preferred follow-up is `read_spans` or `grep`

`toc_search` supports:

- `paths` (optional): one or more files/directories under the current workspace
- `limit` (optional): cap ranked matches
- broad-query fallback: returns `status=unavailable` with `reason=broad_query`
  when structural matches are too diffuse to be useful; preferred next step is
  a narrower symbol/import query or `grep`
- search-scope guard: returns `reason=search_scope_too_large` when the walk
  would index too many candidate files
- indexing-budget guard: returns `reason=indexing_budget_exceeded` when the
  current search would exceed the structural indexing byte budget
- follow-up contract: prefer `read_spans` for exact line ranges instead of
  whole-file reads

## AST Tools

- `ast_grep_search`
- `ast_grep_replace`

Defined in `packages/brewva-tools/src/ast-grep.ts`.

`ast_grep_search` / `ast_grep_replace` require the `sg` binary (ast-grep).
If `sg` is unavailable or execution fails, tools return `status=unavailable`
with a reason/next-step hint instead of regex fallback.
Parameter surface is intentionally minimal:

- `ast_grep_search`: `pattern`, `lang`, optional `paths`
- `ast_grep_replace`: `pattern`, `rewrite`, `lang`, optional `paths`, optional `dryRun`

## Runtime-Aware Tools

Default tool bundle (registered by `buildBrewvaTools()`):

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
- `resource_lease`
- `session_compact`
- `rollback_last_patch`
- `worker_results_merge`
- `worker_results_apply`
- `cognition_note`
- `skill_load`
- `skill_complete`
- `skill_chain_control`
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

Optional A2A tools (registered by channel orchestration extensions when an A2A adapter is available):

- `agent_send`
- `agent_broadcast`
- `agent_list`

Managed Brewva tools now expose governance metadata on the definition object
itself:

- `brewva.surface`
- `brewva.governance`

Parameter-key compatibility:

- managed Brewva tools accept top-level `camelCase` and `snake_case` spellings
  for the same field; this reference shows canonical spellings only
- if both spellings are present in one call, the documented canonical field wins

Parameter/value contract:

- documented parameter names and enum values are the `agent-facing` canonical
  surface
- managed-tool execution lowers that surface into runtime canonical values
  before tool logic runs when runtime storage or external adapters need a
  different value space
- capability detail, invocation repair hints, and injected task/runtime text
  are expected to speak the same agent-facing vocabulary as this reference;
  runtime storage words are not the model-facing contract

For built-in managed tools this is a canonical view over the runtime's exact
managed-tool policy, not a second authored copy. The default gateway/extension
path imports that metadata only when runtime does not already have an exact
descriptor for the tool, so tool disclosure and runtime effect governance can
share one policy source instead of drifting into parallel registries.

## Tool Surface Layers

The static registry is larger than the per-turn visible tool surface.

Current extension composition resolves three layers before `before_agent_start`:

- `base tools`
  - built-in core tools plus Brewva base governance tools
- `skill-informed tools`
  - preferred/fallback hints plus effect-authorized managed skill tools derived
    from the current active, pending-dispatch, or cascade-step skill contracts
- `operator tools`
  - operator-facing observability and control tools shown only for operator/full
    routing profiles by default or explicit `$tool_name` tool-surface requests
    in current-turn capability disclosure

Default product behavior:

- capability disclosure is rendered from the current-turn semantic capability
  view, and its summary reflects only the tools that are visible now
- renderer output is tiered: summary/policy are essential, inventory is
  optional, and explicit `$tool_name` requests produce requested detail blocks
- hidden managed Brewva tools can be surfaced for one turn by explicitly
  requesting `$tool_name`
- explicit `$tool_name` requests change disclosure for the current turn only;
  they do not grant authority on their own
- current skill/pending dispatch/cascade commitment still exposes its normal
  task-specific tool surface without needing `$tool_name`
- routing scopes that include `operator` or `meta` keep operator tools visible
  by default

This is enforced through active-tool selection, not by mutating kernel policy:

- runtime/skill contracts determine the exploration-oriented surface
- extensions narrow the visible tool list for the current turn
- runtime gates remain the fail-closed backstop for actual execution

Third-party or custom tools should register exact governance descriptors on the
owning runtime through `runtime.tools.registerGovernanceDescriptor(...)` if they
need effect authorization to participate in strict policy enforcement.
Registrations are runtime-scoped, not process-global. Regex hint fallback
remains available as a migration path, but when an active skill exercises a
hint-resolved tool runtime emits `governance_metadata_missing` until exact
metadata is provided.

Deprecation policy:

- as of `2026-03-17`, no first-party Brewva tool may ship relying on regex hint
  fallback; managed tool bundles are expected to carry exact governance
  metadata and contract tests enforce that expectation
- regex hint fallback remains only for third-party or custom tools as a
  temporary migration path until exact descriptors are registered on the owning
  runtime

Explicit exception:

- a small runtime-owned set of control-plane tools stays available for recovery,
  compaction, scheduling, and lease negotiation even when effect gating would
  otherwise hide them

`tool_surface_resolved` records the resolved visible surface for audit/ops
telemetry.

Notes:

- `grep` is a read-only workspace search tool intended to replace ad-hoc `exec` usage for text search in read-only skills.
- `read_spans` is the preferred targeted follow-up after `toc_document` / `toc_search`; it reads bounded line ranges from one file instead of replaying a whole file.
- `skill_chain_control` is the control-plane tool for inspecting and steering explicit cascade progression.
- Repeated `read`, `grep`, `read_spans`, `look_at`, `toc_*`, navigation-only `lsp_*`, `ast_grep_search`, or low-signal `exec` turns can trigger the scan convergence guard. Preferred recovery tools are `output_search`, `ledger_query`, `tape_search`, `task_view_state`, and `task_*` ledger actions before resuming more retrieval.
- `obs_query`, `obs_slo_assert`, and `obs_snapshot` are evidence-reuse tools. They inspect current-session runtime events and do not count as low-signal retrieval for scan-convergence reset.
- `cognition_note` is an operator teaching tool. It writes append-only
  external cognition artifacts (`reference`, `procedure`, `episode`) under
  `.brewva/cognition/*` and never mutates kernel truth/task state directly.

### `resource_lease`

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

- leases are budget-only; they do not grant new effect authorization
- lease requests require an active skill and are scoped to that skill
- granted budget is clamped by the skill hard ceiling before the lease is recorded
- requests fail when the active skill has no remaining headroom between
  `default_lease` and `hard_ceiling`
- granted, cancelled, and expired leases are replayable session events
- `resource_lease` is a narrow governance-owned direct-commit flow; it records
  budget receipts without widening effect authority

### `worker_results_merge`

Inspects the current session's recorded worker results and reports whether the
current patch set is empty, conflicting, or cleanly mergeable.

Parameters: none.

Behavior:

- read-only inspection tool; it never changes worker state or parent workspace
- returns `status=empty` when no worker results are recorded
- returns `status=conflicts` plus conflicting paths/worker ids when patch merge
  would be ambiguous
- returns `status=merged` plus a merged patch summary when the current worker
  set can be adopted by the parent
- this is the canonical merge inspection surface for patch-producing subagents;
  a separate `subagent_merge` tool is unnecessary while delegated patch
  adoption remains worker-result based

### `worker_results_apply`

Merges the current session's worker results and applies the merged patch set to
the parent workspace.

Parameters: none.

Behavior:

- parent-controlled adoption path for patch-producing workers and subagents
- requires a clean merge; conflicts are reported and nothing is written
- successful application records a reversible patch set, clears the transient
  worker-result buffer, and can be undone with `rollback_last_patch`
- apply failures preserve worker results so the parent can inspect or rerun
  delegation
- together with `worker_results_merge`, this is the canonical parent-side
  replacement for a dedicated `subagent_merge` verb

### `subagent_run`

Delegates a bounded task to an isolated subagent profile and returns structured
outcomes.

Parameters:

- `profile` (string, required)
- `mode` (`single` | `parallel`, optional)
- `objective` (string, required for `single`)
- `deliverable` (string, optional)
- `constraints` (string[], optional)
- `sharedNotes` (string[], optional)
- `activeSkillName` (string, optional)
- `entrySkill` (string, optional)
- `requiredOutputs` (string[], optional)
- `executionHints.preferredTools` (string[], optional)
- `executionHints.fallbackTools` (string[], optional)
- `executionHints.preferredSkills` (string[], optional)
- `contextRefs` (array, optional)
- `contextBudget` (object, optional)
- `effectCeiling.posture` (`observe` | `reversible_mutate`, optional)
- `waitMode` (`completion` | `start`, optional)
- `timeoutMs` (number, optional)
- `returnMode` (`text_only` | `supplemental` | `context_packet` | `both`, optional)
- `returnLabel` (string, optional)
- `returnScopeId` (string, optional)
- `returnPacketKey` (string, optional)
- `returnTtlMs` (number, required when `returnMode` includes `context_packet`)
- `tasks` (array, required for `parallel`)

Behavior:

- `single` runs delegate one bounded packet; `parallel` fans out independent
  task packets
- `waitMode=completion` waits for outcomes in the current turn; `waitMode=start`
  launches background delegation and returns run ids for later inspection or
  cancellation
- the parent keeps authoritative skill lifecycle and only receives structured
  delegated outcomes
- context should be passed by compact references and bounded budgets, not by
  copying the entire parent conversation
- `activeSkillName`, `requiredOutputs`, and `executionHints.*` align the child
  with the parent skill contract without changing authority ownership
- `reversible_mutate` posture is reserved for isolated write-capable runners;
  read-only profiles should stay on `observe`
- `returnMode=supplemental` appends a compact same-turn outcome summary through
  runtime supplemental context injection
- `returnMode=context_packet` persists a replayable outcome handoff through the
  existing `context_packet` proposal boundary
- `returnMode=both` performs both deliveries; `text_only` leaves the result on
  the visible tool channel only

### `subagent_fanout`

Delegates multiple independent slices of work to the same isolated subagent
profile and returns structured parallel outcomes.

Parameters:

- `profile` (string, required)
- `objective` (string, optional shared objective)
- `deliverable` (string, optional shared deliverable)
- `constraints` (string[], optional shared constraints)
- `sharedNotes` (string[], optional shared notes)
- `activeSkillName` (string, optional)
- `entrySkill` (string, optional)
- `requiredOutputs` (string[], optional)
- `executionHints.preferredTools` (string[], optional)
- `executionHints.fallbackTools` (string[], optional)
- `executionHints.preferredSkills` (string[], optional)
- `contextRefs` (array, optional shared references)
- `contextBudget` (object, optional)
- `effectCeiling.posture` (`observe` | `reversible_mutate`, optional)
- `waitMode` (`completion` | `start`, optional)
- `timeoutMs` (number, optional)
- `returnMode` (`text_only` | `supplemental` | `context_packet` | `both`, optional)
- `returnLabel` (string, optional)
- `returnScopeId` (string, optional)
- `returnPacketKey` (string, optional)
- `returnTtlMs` (number, required when `returnMode` includes `context_packet`)
- `tasks` (array, required)

Behavior:

- always runs in explicit parallel mode
- shared packet fields are merged into each task-specific packet before launch
- use this when the parent wants a clear fan-out boundary instead of one large
  delegated run with mixed concerns
- background starts and replayable return delivery follow the same rules as
  `subagent_run`

### `subagent_status`

Inspects active and recent delegated runs for the current session.

Parameters:

- `runId` (string, optional)
- `statuses` (`pending` | `running` | `completed` | `failed` | `timeout` |
  `cancelled` | `merged`, optional)
- `includeTerminal` (boolean, optional)
- `limit` (number, optional)

Behavior:

- returns replayable delegation state from `runtime.session.*`
- when a live orchestration adapter is present, also reports `live` and
  `cancelable`
- supports narrow inspection of one run id or filtered lifecycle slices
- includes compact delivery/handoff metadata when the run was configured to
  return through `supplemental`, `context_packet`, or `both`

### `subagent_cancel`

Cancels a live delegated run by `runId`.

Parameters:

- `runId` (string, required)
- `reason` (string, optional)

Behavior:

- only cancels runs that are still live in the current process
- terminal runs are reported as terminal; they are not rewritten into a fake
  cancelled state
- cancellation updates the delegation lifecycle state and emits
  `subagent_cancelled`

### `cognition_note`

Writes or supersedes high-signal operator cognition artifacts.

Parameters:

- `action` (`record` | `supersede` | `list`, required)
- `kind` (`reference` | `procedure` | `episode`, required for `record` and
  `supersede`)
- `name` (string, required for `record` and `supersede`)
- `title` (string, optional)
- `body` (string, optional)
- `sessionScope` (string, optional, `episode` only)
- `lessonKey` (string, optional, `procedure` only)
- `pattern` (string, optional, `procedure` only)
- `recommendation` (string, optional, `procedure` only)
- `focus` (string, optional, `episode` only)
- `nextAction` (string, optional, `episode` only)
- `blockedOn` (string or string[], optional, `episode` only)
- `limit` (number, optional, `list` only)

Behavior:

- `record`
  - appends a new operator-authored cognition artifact in the correct storage
    lane
  - rejects duplicate semantic names for the same `kind`
- `supersede`
  - appends a newer artifact with the same semantic name instead of editing the
    older file in place
  - retrieval and operator listing collapse older operator-authored versions by
    semantic key, so the newest artifact stays visible without rewriting
    history
- `list`
  - lists recent operator-authored cognition artifacts only
  - excludes system-generated memory artifacts
  - collapses superseded operator-authored versions to the latest semantic key

Storage mapping:

- `reference` -> `.brewva/cognition/reference/`
- `procedure` -> `.brewva/cognition/reference/`
- `episode` -> `.brewva/cognition/summaries/`

Scope model:

- operator-authored `reference` and `procedure` notes are workspace-scoped
- resumable `summary` process memory remains session-scoped through
  `session_scope`
- `cognition_note` may attach `sessionScope` to operator-authored `episode`
  notes when the note should participate in same-session rehydration

This tool is intentionally operator-scoped. It improves external cognition
input quality without bypassing the proposal boundary.

### `grep`

Wraps `ripgrep` (`rg`) with bounded output. Requires `rg` to be available on `PATH`.

Parameters:

- `query` (string, required): search pattern (regex by default)
- `paths` (string[], optional, max 20): paths to search (defaults to `["."]`)
- `glob` (string[], optional, max 20): glob filters passed to `rg --glob`
- `case` (`smart` | `insensitive` | `sensitive`, default `smart`): case
  sensitivity mode; `smart_case`, `case_insensitive`,
  `case-insensitive`, `case_sensitive`, and `case-sensitive` are accepted as
  aliases
- `fixed` (boolean, default `false`): treat `query` as a literal string (`--fixed-strings`)
- `max_lines` (number, 1–500, default `200`): output line cap; search is killed on truncation
- `timeout_ms` (number, 100–120000, default `30000`): execution timeout
- `workdir` (string, optional): working directory (resolved relative to runtime `cwd`)

If `rg` is not found, the tool returns a hint to install ripgrep.

### `read_spans`

Reads exact line ranges from one file with bounded output.

Parameters:

- `file_path` (string, required): file to read
- `spans` (array, required, max 16): line ranges with `start_line` / `end_line`

Behavior:

- overlapping or adjacent spans are merged before reading
- ranges are clipped to file length
- when all requested ranges are outside the file, returns `status=unavailable`
  with `reason=out_of_bounds`
- when output is capped, the tool returns `last_line_returned` and
  `truncated_at_line` so follow-up calls can resume without recounting lines
- output is capped to avoid whole-file replay; use multiple narrower calls if needed
- when called after `toc_document` / `toc_search` in the same session, it
  reuses the same source-text cache instead of rereading the file immediately

### `skill_chain_control`

Inspects or controls the skill cascade intent lifecycle.

Parameters:

- `action` (`status` | `pause` | `resume` | `cancel` | `start`, required)
- `reason` (string, optional, max 500 chars): context for pause/resume/cancel
- `steps` (array, required for `start`, max 64): explicit chain steps, each with:
  - `skill` (string, required)
  - `consumes` (string[], optional)
  - `produces` (string[], optional)
  - `lane` (string, optional)

`status` returns the current intent snapshot or reports no active cascade.
`start` requires at least one step; other actions operate on the existing intent.

`task_*` ledger tools use an agent-facing surface and lower to runtime storage
values on write:

- `task_set_spec.verification.level`
  - agent-facing values: `smoke|targeted|full|none`
  - accepted read-only aliases: `inspection|investigate|readonly|read_only|read-only->none`
  - runtime storage lowering: `smoke->quick`, `targeted->standard`,
    `full->strict`, `none->(omit stored level)`
  - because `task_set_spec` rewrites the spec, include
    `verification.commands` again in the same call if they should be preserved
- `task_add_item` / `task_update_item` `status`
  - agent-facing values: `pending|in_progress|done|blocked`
  - accepted alias: `in-progress->in_progress`
  - runtime storage lowering: `pending->todo`, `in_progress->doing`,
    `done->done`, `blocked->blocked`

`schedule_intent` supports `action=create|update|cancel|list`:

- `create` requires `reason` and exactly one schedule target:
  - one-shot: `runAt` or `delayMs` (`delayMs` is a tool-level convenience parameter that gets resolved to `runAt` before the runtime API call)
  - recurring: `cron` (optional `timeZone`)
  - `runAt` / `delayMs` / `cron` are mutually exclusive, and `timeZone` is only valid with `cron`
- `update` requires `intentId` and supports patching `reason`, `goalRef`,
  `continuityMode`, `maxRuns`, `convergenceCondition`, and schedule target fields;
  empty patches are rejected with `empty_update`
- `cancel` requires `intentId`
- `list` supports `status` filtering (`all|active|cancelled|converged|error`) and
  `includeAllSessions` (global scope), and returns projection `watermarkOffset`;
  `canceled` is accepted as an alias for `cancelled`

Structured `convergenceCondition` predicates include:
`truth_resolved`, `task_phase`, `max_runs`, `all_of`, `any_of`.

For cron intents, runtime defaults `maxRuns` to `10000` when omitted.

`output_search` supports query-mode and inventory-mode:

- query-mode: pass `query` or `queries`; results are ranked per artifact and include compact snippets.
- inventory-mode: omit both `query` and `queries` to list recent persisted artifacts.
- search behavior: exact -> partial -> fuzzy layered fallback.
- fuzzy results are emitted only when confidence gates pass; otherwise search reports no matches.
- throttling: repeated single-query calls can be limited or blocked; batch with `queries` to avoid pressure.
- source data: only persisted `tool_output_artifact_persisted` artifacts are scanned.

`obs_query` supports current-session structured event queries:

- filters: `types`, `where` (payload top-level exact match), `windowMinutes`, `last`
- optional metric aggregation: `count`, `min`, `max`, `avg`, `p50`, `p95`, `latest`
- output model: raw result is written as a tool-output artifact and the tool returns only a compact summary plus `query_ref`
- throttling: aligned with `output_search` single-query throttling (`90s` window; reduce after `4`; block after `10`)

`obs_slo_assert` evaluates a metric assertion over current-session runtime events:

- required fields: `metric`, `aggregation`, `operator`, `threshold`
- optional fields: `types`, `where`, `windowMinutes`, `minSamples`, `severity`
  (`info|warn|error`; `information` and `warning` are accepted as aliases)
- verdicts: `pass`, `fail`, `inconclusive`
- failure path: records observability assertion evidence and can sync to truth/task state through runtime truth extraction

`obs_snapshot` returns a compact runtime health view:

- tape status
- context pressure
- cost summary
- task phase and blocker count
- latest verification outcome, when available

Definitions:

- `packages/brewva-tools/src/toc.ts`
- `packages/brewva-tools/src/look-at.ts`
- `packages/brewva-tools/src/read-spans.ts`
- `packages/brewva-tools/src/a2a.ts`
- `packages/brewva-tools/src/exec.ts`
- `packages/brewva-tools/src/grep.ts`
- `packages/brewva-tools/src/process.ts`
- `packages/brewva-tools/src/cost-view.ts`
- `packages/brewva-tools/src/observability/obs-query.ts`
- `packages/brewva-tools/src/observability/obs-slo-assert.ts`
- `packages/brewva-tools/src/observability/obs-snapshot.ts`
- `packages/brewva-tools/src/ledger-query.ts`
- `packages/brewva-tools/src/output-search.ts`
- `packages/brewva-tools/src/schedule-intent.ts`
- `packages/brewva-tools/src/tape.ts`
- `packages/brewva-tools/src/session-compact.ts`
- `packages/brewva-tools/src/rollback-last-patch.ts`
- `packages/brewva-tools/src/skill-load.ts`
- `packages/brewva-tools/src/skill-complete.ts`
- `packages/brewva-tools/src/skill-chain-control.ts`
- `packages/brewva-tools/src/cognition-note.ts`
- `packages/brewva-tools/src/resource-lease.ts`
- `packages/brewva-tools/src/task-ledger.ts`

`look_at` returns `status=unavailable` when it cannot find high-confidence
goal matches; it no longer falls back to returning top-of-file lines.
`look_at.goal` is English-ASCII only; non-ASCII goals return
`status=unavailable` with `reason=unsupported_goal_language`.
