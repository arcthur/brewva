# Runtime Events

This reference summarizes the current runtime event families used across
replay, hosted execution, and operator inspection.

## Event Envelope

Every runtime event follows the same shape:

- `id`
- `sessionId`
- `type`
- `timestamp`
- `turn?`
- `payload?`

## Query Contract

`runtime.inspect.events.query(...)`, `queryStructured(...)`, and `list(...)` share the
same query fields:

- `type`
- `after`
- `before`
- `last`
- `offset`
- `limit`

Result order remains tape order from oldest to newest.

## Durability Classification

The central registry contains more than one durability class.

- `durable source of truth`
  - event families retained on tape and used for replay, receipts, task/truth
    folding, approval truth, and other authoritative outcomes
- `rebuildable state`
  - derived-state telemetry such as projection refresh signals that may be
    persisted but are not semantic replay inputs
- `cache`
  - live-stream or UX-only surfaces that are not retained on durable tape

`durable transient` does not primarily appear as a runtime event family here.
That class is represented by Recovery WAL and rollback material outside the event
registry.

## Registry Surface

The exported constant registry lives in
`packages/brewva-runtime/src/events/event-types.ts`.

The runtime also reserves a small set of accepted event families directly in
`packages/brewva-runtime/src/services/event-pipeline.ts` for hosted/context
flows that do not need public constant exports.

Use this reference as the stable, operator-relevant runtime event surface
across both files.

### Core Ledger And Projection

- `anchor`
- `checkpoint`
- `task_event`
- `truth_event`
- `schedule_intent`
- `projection_ingested`
- `projection_refreshed`

`projection_ingested` and `projection_refreshed` describe rebuildable-state
maintenance. They do not promote projection files into source-of-truth inputs.

### Session, Turn, And Hosted Lifecycle

- `channel_command_received`
- `operator_question_answered`
- `channel_session_bound`
- `gateway_session_bound`
- `channel_update_requested`
- `channel_update_lock_blocked`
- `session_bootstrap`
- `session_start`
- `session_shutdown`
- `session_turn_transition`
- `turn_input_recorded`
- `turn_render_committed`
- `session_before_compact`
- `session_compact`
- `session_compact_requested`
- `session_compact_failed`
- `session_compact_request_failed`
- `context_compaction_requested`
- `context_compaction_gate_armed`
- `context_compaction_gate_cleared`
- `context_compaction_auto_requested`
- `context_compaction_auto_completed`
- `context_compaction_auto_failed`
- `context_compaction_skipped`
- `turn_start`
- `turn_end`
- `message_end`
- `agent_end`

`session_turn_transition` is the rebuildable hosted-flow contract for bounded
recovery, compaction retry, interrupt, approval-pending, delegation handoff,
and WAL-resume continuations. The payload includes:

- `reason`
- `status`
- `sequence`
- `family`
- `attempt`
- `sourceEventId`
- `sourceEventType`
- `error`
- `breakerOpen`
- `model`

Hosted compaction telemetry remains audit-visible because gateway continuity,
breaker rehydration, and post-compaction state inspection depend on it. These
events stay hosted/experience-ring signals; they do not widen kernel authority
or replace receipt-bearing runtime facts.

`session_shutdown` remains the durable terminal receipt for a session. When the
worker process cannot record it itself, gateway reconciliation writes the
receipt directly to the persisted agent event log path. There is no config- or
workspace-derived fallback synthesis path.

`gateway_session_bound` is the gateway control-plane receipt that binds a
public gateway session id to an agent session id and its durable event-log
segment. Gateway session replay uses this control-tape binding instead of
process-local registry state. The receipt is recorded under the gateway control
session `gateway:session-bindings`; it is replay-critical for public
session-history lookup, but it is not itself a frontend session-wire frame.

Typical hosted recovery reasons include:

- `reason=compaction_gate_blocked`
- `reason=compaction_retry`
- `reason=output_budget_escalation`
- `reason=provider_fallback_retry`
- `reason=max_output_recovery`
- `reason=effect_commitment_pending`
- `reason=subagent_delivery_pending`
- `reason=wal_recovery_resume`
- `reason=user_submit_interrupt`
- `reason=signal_interrupt`
- `reason=timeout_interrupt`

`brewva inspect` projects this history into a rebuildable hosted transition
snapshot so operators can inspect pending family state, breaker posture, and
latest continuation reason without relying on process-local gateway memory.

`reason=output_budget_escalation` represents a capability-gated retry of the
same semantic request with a larger provider output budget when the hosted
provider-request recovery hook can patch the next outbound payload.

`turn_input_recorded` is the durable accepted-turn receipt that binds the
frontend-visible `turnId` to the tape turn index used by later hosted recovery,
approval, and delegation receipts. Its payload includes:

- `turnId`
- `trigger`
- `promptText`

`turn_render_committed` is the durable terminal presentation receipt for an
accepted turn. Its payload includes:

- `turnId`
- `attemptId`
- `status`
- `assistantText`
- `toolOutputs`

Together, `turn_input_recorded` and `turn_render_committed` are the durable
receipts that feed `runtime.inspect.sessionWire`. Replay derives final
frontend-visible turn text and tool summaries from these receipts, not from raw
message deltas or standalone tool-result transport frames.

### Tool, Verification, Mutation, And Recovery

- `tool_call`
- `tool_call_blocked`
- `tool_call_marked`
- `tool_contract_warning`
- `tool_read_path_gate_armed`
- `tool_read_path_discovery_observed`
- `tool_execution_start`
- `tool_execution_end`
- `tool_attempt_binding_missing`
- `tool_result_recorded`
- `tool_output_observed`
- `tool_output_distilled`
- `tool_output_artifact_persisted`
- `tool_output_artifact_persist_failed`
- `tool_output_search`
- `observability_query_executed`
- `observability_assertion_recorded`
- `resource_lease_granted`
- `resource_lease_cancelled`
- `resource_lease_expired`
- `exec_routed`
- `exec_fallback_host`
- `exec_blocked_isolation`
- `exec_sandbox_error`
- `verification_write_marked`
- `verification_outcome_recorded`
- `verification_state_reset`
- `event_listener_error`
- `tool_effect_gate_selected`
- `reversible_mutation_prepared`
- `reversible_mutation_recorded`

When a tool definition carries Brewva execution-traits metadata, `tool_call`
and `tool_execution_start` may include `executionTraits` payload fields. Those
fields are hosted scheduling metadata derived from the specific invocation
input; they do not replace governance descriptors or receipt-bearing authority
decisions.

For hosted session-wire live transport, repo-owned tool lifecycle receipts also
carry `attempt` when the hosted turn has an authoritative active attempt. Those
attempt numbers are turn-local and feed attempt-scoped live `tool.*` frames; a
missing authoritative binding is recorded as `tool_attempt_binding_missing`
instead of being silently guessed from the current active attempt.

`tool_execution_end` may also include a hosted `terminalReason` field. This
distinguishes direct SDK completion (`completed`, `failed`) from host-synthesized
closure after a durable tool result (`completed_after_tool_result`,
`failed_after_tool_result`) and interruption/supersession paths
(`cancelled_by_interrupt`, `cancelled_by_retry_supersession`,
`cancelled_by_shutdown`). This remains hosted audit telemetry rather than a new
effect-authoritative source of truth.

`tool_read_path_gate_armed` and `tool_read_path_discovery_observed` are the
hosted read-path recovery protocol for repeated missing-path `read` failures.
The gate event is the single activation receipt; recovery no longer infers an
active gate only from recent `ENOENT` history. Discovery evidence is emitted as
structured runtime events by tools that directly surface workspace file or
directory evidence to the model, such as direct file reads and path-bearing
search/navigation tools. The hosted read wrapper uses this evidence to decide
when later `read` calls are allowed again. There is no output-text parsing or
filesystem-probe compatibility shim in the recovery path.

- `reversible_mutation_rolled_back`
- `rollback`
- `patch_recorded`
- `file_snapshot_captured`
- `ledger_compacted`
- `context_compaction_gate_blocked_tool`
- `cost_update`
- `budget_alert`

### Skill Lifecycle And Budget

- `skill_activated`
- `skill_completed`
- `skill_refresh_recorded`
- `skill_budget_warning`
- `skill_parallel_warning`
- `skill_promotion_draft_derived`
- `skill_promotion_reviewed`
- `skill_promotion_promoted`
- `skill_promotion_materialized`

`skill_refresh_recorded` is an ops-level control receipt emitted only when a
host calls `runtime.maintain.skills.refresh({ sessionId, ... })`. It records explicit
skill-registry rebuild activity for inspection, including the refresh reason,
the rewritten index path, and bundled system-install summary. It is not replay
truth.

### Narrative Memory And Semantic Recall

- `narrative_memory_recorded`
- `narrative_memory_reviewed`
- `narrative_memory_promoted`
- `narrative_memory_archived`
- `narrative_memory_forgotten`
- `semantic_extraction_invoked`
- `semantic_rerank_invoked`

These are control-plane audit receipts for the narrative memory product and
bounded semantic recall. In structured queries they classify as `category=control`,
remain non-authoritative, and do not become replay inputs for task truth,
approval truth, or WAL recovery.

### Iteration Facts

- `iteration_metric_observed`
- `iteration_guard_recorded`

Current guard notes:

- exact-call loop protection records `iteration_guard_recorded` with
  `guardKey=exact_call_loop`
- when exact-call protection runs in `block` mode, runtime also emits
  `tool_call_blocked` with the same reason text

### Proposal And Governance

- `proposal_received`
- `proposal_decided`
- `decision_receipt_recorded`
- `effect_commitment_approval_requested`
- `effect_commitment_approval_decided`
- `effect_commitment_approval_consumed`
- `governance_verify_spec_passed`
- `governance_verify_spec_failed`
- `governance_verify_spec_error`
- `governance_cost_anomaly_detected`
- `governance_cost_anomaly_error`
- `governance_metadata_missing`
- `governance_compaction_integrity_checked`
- `governance_compaction_integrity_failed`
- `governance_compaction_integrity_error`

### Context And Watchdog

- `context_composed`
- `tool_surface_resolved`
- `skill_recommendation_derived`
- `identity_parse_warning`
- `task_stuck_detected`
- `task_stuck_cleared`
- `task_stall_adjudicated`
- `task_stall_adjudication_error`

`skill_recommendation_derived` is the hosted control-plane receipt for
skill-first routing posture while no skill is active yet. The payload records
the control-plane `gateMode` (`none | task_spec_required | skill_load_required`),
whether TaskSpec is already present, and the ranked candidate set with
categories, scores, and matched reasons. The hosted path may emit another
receipt in the same turn after `task_set_spec` or other task-state mutations if
the routed posture changes.

### Schedule, Subagent, And Worker

- `schedule_recovery_deferred`
- `schedule_recovery_summary`
- `schedule_wakeup`
- `schedule_child_session_started`
- `schedule_child_session_finished`
- `schedule_child_session_failed`
- `subagent_spawned`
- `subagent_running`
- `subagent_completed`
- `subagent_failed`
- `subagent_cancelled`
- `subagent_outcome_parse_failed`
- `subagent_delivery_surfaced`
- `worker_results_applied`
- `worker_results_apply_failed`

Current schedule-recovery notes:

- `schedule_recovery_deferred.reason` may be
  `max_recovery_catchups_exceeded`, `recovery_wal_inflight`, or
  `stale_one_shot_recovery`
- `schedule_recovery_summary` remains per-parent-session telemetry for the
  same recovery pass

## Workflow-Derived Surfaces

Brewva does not define a dedicated `workflow_*` durable event family for
workflow chaining.

Instead, workflow artifacts and posture are derived from existing durable
events and session state:

- `skill_completed`
  - discovery, strategy-review, design plus planning handoff artifacts
    (`design_spec`, `execution_plan`, `risk_register`,
    `implementation_targets`), implementation, review, QA, ship, and retro
    artifacts
- `verification_outcome_recorded`
  - verification artifact freshness and block/ready outcome
- `verification_write_marked`
  - implementation-side write signal that can stale downstream review, QA, and
    verification artifacts
- `task_stall_adjudicated`
  - durable advisory stall classification used by inspection surfaces such as
    `workflow_status`
- `iteration_metric_observed`
  - `workflow.iteration_metric`
- `iteration_guard_recorded`
  - `workflow.iteration_guard`
- `subagent_*`
  - delegated patch-worker lifecycle signals
- `subagent_outcome_parse_failed`
  - typed outcome extraction fell back to prose-only handling
- `subagent_delivery_surfaced`
  - replayable background delegation outcome became visible to the parent turn
- `worker_results_applied` / `worker_results_apply_failed`
  - parent-controlled worker adoption outcomes

Those derived workflow surfaces are exposed through working projection and
`workflow_status`. They are advisory working-state views, not new audit-critical
authority events.

Those surfaces are explicit inspection views. They do not become a default
turn-time workflow brief or a hidden next-step controller.

`operator_question_answered` is not a derived workflow artifact. It is the
durable operator-input receipt for the questionnaire surface exposed through
`/questions` and `/answer`. The answer itself remains explicit, replay-visible
session input rather than hidden channel-local state.

## Audit-Critical Families

The audit-retained core includes:

- `anchor`
- `checkpoint`
- `task_event`
- `truth_event`
- session/turn lifecycle receipts such as `session_bootstrap`, `session_start`,
  `session_shutdown`, `turn_input_recorded`, `turn_render_committed`,
  `gateway_session_bound`,
  `turn_start`, `turn_end`, `message_end`, and `agent_end`
- hosted compaction receipts such as `session_compact_requested`,
  `session_compact`, and `session_turn_transition`
- tool execution receipts such as `tool_call`, `tool_execution_start`,
  `tool_execution_end`, and `tool_result_recorded`
- `tool_output_search`
- `iteration_metric_observed`
- `iteration_guard_recorded`
- `verification_write_marked`
- `verification_outcome_recorded`
- `proposal_received`
- `proposal_decided`
- `decision_receipt_recorded`
- `operator_question_answered`
- `effect_commitment_approval_requested`
- `effect_commitment_approval_decided`
- `effect_commitment_approval_consumed`
- `governance_cost_anomaly_detected`
- `governance_cost_anomaly_error`
- `governance_compaction_integrity_checked`
- `governance_compaction_integrity_failed`
- `governance_compaction_integrity_error`
- `subagent_spawned`
- `subagent_running`
- `subagent_completed`
- `subagent_failed`
- `subagent_cancelled`
- `subagent_outcome_parse_failed`
- `subagent_delivery_surfaced`
- `worker_results_applied`
- `worker_results_apply_failed`
- `skill_activated`
- `skill_completed`
- `skill_promotion_draft_derived`
- `skill_promotion_reviewed`
- `skill_promotion_promoted`
- `skill_promotion_materialized`
- `tool_output_artifact_persist_failed`
- `cost_update`
- `budget_alert`
- `rollback`
- `patch_recorded`
- schedule lifecycle events

This audit-retained set is the effective `durable source of truth` subset of
the event registry. It is the part of the registry that replay, restart, and
receipt linkage depend on.

`tool_result_recorded` is the durable outcome event. When present,
`effectCommitmentRequestId` and `toolCallId` link the result back to the exact
approval-bearing request that authorized it.

`tool_result_recorded` remains operator truth, but `session-wire.v2` replay
does not project it into standalone durable `tool.finished` frames. Final
frontend-facing tool outputs are carried by `turn_render_committed.toolOutputs`.
During live transport, gateway may still emit cache-class `tool.finished`
preview frames; frontends should treat `turn.committed.toolOutputs` as the
committed final state.

`event_listener_error` is also audit-retained because it records fan-out
degradation without dropping the source event.

`message_update` and `tool_execution_update` now remain only in the hosted
session live stream and are no longer written to the durable tape. The durable
side keeps only the `message_end` summary and the `tool_execution_end` result.

Those live-stream-only surfaces are `cache`-class transport views, not replay
inputs.

## Operational Semantics

`tool_effect_gate_selected` records the chosen public boundary plus execution
properties such as:

- `boundary`
- `requiresApproval`
- `rollbackable`

`subagent_*` lifecycle events carry delegated-run state such as:

- `runId`
- `delegate`
- `kind`
- `boundary`
- `deliveryMode`
- `deliveryHandoffState`
- `deliveryReadyAt`
- `deliverySurfacedAt`
- `supplementalAppended`

`subagent_spawned` records durable run creation. `subagent_running` records the
later transition where the child pid/session is actually live. Readers accept
older replay tapes that encoded the running transition as
`subagent_spawned(status=running)`.

`worker_results_applied` and `worker_results_apply_failed` record the
parent-controlled adoption outcome for child-produced patches. When a single
worker result is applied, `worker_results_applied` also includes `workerId`
alongside canonical `workerIds`.

`channel_command_received`, `channel_update_requested`, and
`channel_update_lock_blocked` record channel control-plane activity for
orchestrated slash commands. They remain ops-facing orchestration telemetry,
but they are now part of the formal registered event contract so replay,
documentation, and downstream consumers can rely on stable identifiers.

`subagent_outcome_parse_failed` records when typed-outcome extraction misses and
the delegated run falls back to prose-only summary handling.

`subagent_delivery_surfaced` records when a background delegation outcome is
surfaced into a later parent turn and its replayable handoff state advances.

Iteration fact events record objective optimization evidence only:

- `iteration_metric_observed`
  - measured value, optional aggregation, optional sample count, evidence refs
- `iteration_guard_recorded`
  - guard key, pass/fail-like status, and evidence refs

Workflow posture is computed from those durable families plus current task
blockers, pending worker-result state, and pending delegation outcomes awaiting
parent attention. The resulting advisory surfaces remain inspection-only and may
not prescribe a single legal workflow path.
