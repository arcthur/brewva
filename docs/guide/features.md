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
- First-class delegated planning contract with typed design artifacts and
  planning-assurance workflow posture
- Durable stall adjudication surfaced through workflow inspection rather than a
  hidden recovery planner
- Objective iteration fact persistence and lineage-aware query for
  model-native optimization loops
- Typed narrative memory with explicit inspection, selective recall, and
  provenance-bearing storage for collaboration semantics that are not
  derivable from code or git
- Deliberation memory retention, pruning, and explicit inspection surfaces for
  durable evidence-backed artifacts
- Repository-native compound knowledge under `docs/solutions/**` with explicit
  precedent retrieval rather than hidden recall

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
- `narrative_memory`
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
- `schedule_intent`
- `optimization_continuity`
- `tape_handoff`
- `tape_info`
- `tape_search`
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

Channel-conditional tools (available in a2a channels):

- `agent_send`
- `agent_broadcast`
- `agent_list`

Tool registry source: `packages/brewva-tools/src/index.ts`

## Skill Surface

- Core capability skills: `repository-analysis`, `discovery`, `learning-research`, `strategy-review`, `design`, `implementation`, `debugging`, `review`, `qa`, `ship`, `retro`, `knowledge-capture`
- Domain capability skills: `agent-browser`, `ci-iteration`, `frontend-design`, `github`, `telegram`, `structured-extraction`, `goal-loop`, `predict-review`
- Operator skills: `runtime-forensics`, `git-ops`
- Meta skills: `skill-authoring`, `self-improve`
- `goal-loop` is the bounded continuity and objective optimization protocol,
  not a generic implementation skill
- `ci-iteration` is the bounded PR / CI repair-loop skill for explicit retry,
  verification, and handoff posture
- `deliberation_memory` is the explicit surface for inspecting retained
  repository, user, agent, and loop memory artifacts
- `narrative_memory` is the explicit surface for typed collaboration semantics
  such as operator preferences, working conventions, project context notes, and
  external reference notes; it remains non-authoritative and distinct from
  repository precedent
- `knowledge_search` is the explicit precedent retrieval surface for
  `docs/solutions/**` plus bootstrap repository knowledge sources, with
  query-intent-aware ordering over a single canonical authority model
- `precedent_audit` is the explicit maintenance surface for authority overlap,
  stale routing, and contradiction review across repository precedents and
  stable docs
- `precedent_sweep` is the explicit repository-wide stale-document maintenance
  surface; it is available for deliberate cleanup passes but is not a default
  hosted behavior
- `skill_complete` can synthesize canonical `review_report`,
  `review_findings`, and `merge_decision` from durable delegated review lanes
  via `reviewEnsemble`, instead of requiring the parent reviewer to hand-copy
  child lane output
- `skill_complete` can also synthesize canonical `learning-research` outputs
  via `learningResearch`, turning repository precedent consult into a
  deterministic proof-of-consult packet instead of relying on handwritten
  summaries
- delegated `design -> plan` routing now uses a first-class planning payload
  rather than reusing exploration semantics, while downstream
  implementation/review/qa continue to consume the canonical `design` artifact
  lane
- `knowledge_capture` is the deterministic write-back surface that materializes
  canonical solution records under `docs/solutions/**`
- `learning-research` turns planning-time precedent retrieval into explicit
  handoff artifacts before non-trivial design or review
- `knowledge-capture` orchestrates terminal repository precedent capture and
  should prefer `knowledge_capture` for the actual canonical write-back path
- built-in public agent specs are `explore`, `plan`, `review`, `qa`, and
  `patch-worker`
- `explore`, `plan`, and `review` stay read-only; `qa` is executable but
  parent-source-non-mutating, and `patch-worker` remains the isolated patch
  executor
- `qa` is adversarial by contract: a stable `pass` requires evidence-backed
  executed checks, at least one adversarial probe, and no unresolved evidence
  gaps
- built-in review-lane delegates for internal fan-out are
  `review-correctness`, `review-boundaries`, `review-operability`,
  `review-security`, `review-concurrency`, `review-compatibility`, and
  `review-performance`; removed legacy aliases such as `researcher`,
  `reviewer`, and `verifier` now fail fast
- `optimization_continuity` is the inspection surface for deliberation-owned
  loop continuity, not a runtime-owned optimizer; its `attention` view surfaces
  overdue or long-running lineages for explicit review
- `predict-review` is an advisory multi-perspective debate skill built on
  public delegation tools and existing built-in agent specs / envelopes
- `self-improve` distills repeated evidence, including iteration-fact history,
  into explicit improvement hypotheses
- `skill_promotion` exposes the post-execution promotion pipeline for reviewing
  and materializing evidence-backed skill or rule drafts
- Project overlays: `repository-analysis`, `design`, `implementation`, `debugging`, `review`, `runtime-forensics`
- Shared project context: `critical-rules`, `migration-priority-matrix`, `package-boundaries`, `runtime-artifacts`

Runtime-owned workflow semantics, not public skills:

- verification
- finishing
- recovery
- compose-style workflow semantics

One common public delivery chain is:

`repository-analysis -> discovery -> strategy-review -> learning-research -> design -> implementation -> review -> qa -> ship -> retro -> knowledge-capture`

The chain is a skill-layer convention, not a runtime-owned DAG. Verification,
derived workflow status, and ship advisories remain explicit runtime inspection
surfaces rather than default injected planning hints.

`planning_posture` is part of the upstream handoff into non-trivial planning. It
is produced before `design`, not retroactively inferred by `design` itself.

Skill roots:

- `skills/core`
- `skills/domain`
- `skills/operator`
- `skills/meta`
- `skills/project/shared`
- `skills/project/overlays`
