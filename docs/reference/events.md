# Runtime Events

This reference summarizes the current registered event families.

## Event Envelope

Every runtime event follows the same shape:

- `id`
- `sessionId`
- `type`
- `timestamp`
- `turn?`
- `payload?`

## Query Contract

`runtime.events.query(...)`, `queryStructured(...)`, and `list(...)` share the
same query fields:

- `type`
- `after`
- `before`
- `last`
- `offset`
- `limit`

Result order remains tape order from oldest to newest.

## Central Registry

The authoritative registry lives in
`packages/brewva-runtime/src/events/event-types.ts`.

### Core Ledger And Projection

- `anchor`
- `checkpoint`
- `task_event`
- `truth_event`
- `schedule_intent`
- `projection_ingested`
- `projection_refreshed`

### Session, Turn, And Hosted Lifecycle

- `channel_session_bound`
- `session_bootstrap`
- `session_start`
- `session_shutdown`
- `session_interrupted`
- `session_before_compact`
- `session_compact`
- `session_compact_requested`
- `session_compact_failed`
- `session_compact_request_failed`
- `session_turn_compaction_resume_requested`
- `session_turn_compaction_resume_dispatched`
- `session_turn_compaction_resume_failed`
- `turn_start`
- `turn_end`
- `message_end`
- `agent_end`

### Tool, Verification, Mutation, And Recovery

- `tool_call`
- `tool_call_blocked`
- `tool_call_marked`
- `tool_contract_warning`
- `tool_execution_start`
- `tool_execution_end`
- `tool_result_recorded`
- `tool_output_observed`
- `tool_output_distilled`
- `tool_output_artifact_persisted`
- `tool_output_search`
- `tool_call_normalized`
- `tool_call_normalization_failed`
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
- `reversible_mutation_rolled_back`
- `rollback`
- `file_snapshot_captured`
- `ledger_compacted`
- `context_compaction_gate_blocked_tool`
- `cost_update`
- `budget_alert`

### Skill Lifecycle And Budget

- `skill_activated`
- `skill_completed`
- `skill_budget_warning`
- `skill_parallel_warning`
- `skill_promotion_draft_derived`
- `skill_promotion_reviewed`
- `skill_promotion_promoted`
- `skill_promotion_materialized`

### Iteration Facts

- `iteration_metric_observed`
- `iteration_guard_recorded`

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
- `identity_parse_warning`
- `model_capability_profile_selected`
- `model_request_patched`
- `task_stuck_detected`
- `task_stuck_cleared`

### Schedule, Subagent, And Worker

- `schedule_recovery_deferred`
- `schedule_recovery_summary`
- `schedule_wakeup`
- `schedule_child_session_started`
- `schedule_child_session_finished`
- `schedule_child_session_failed`
- `subagent_spawned`
- `subagent_completed`
- `subagent_failed`
- `subagent_cancelled`
- `subagent_outcome_parse_failed`
- `subagent_delivery_surfaced`
- `worker_results_applied`
- `worker_results_apply_failed`

## Workflow-Derived Surfaces

Brewva does not define a dedicated `workflow_*` durable event family for
workflow chaining.

Instead, workflow artifacts and posture are derived from existing durable
events and session state:

- `skill_completed`
  - discovery, strategy-review, design, execution-plan, implementation,
    review, QA, ship, and retro artifacts
- `verification_outcome_recorded`
  - verification artifact freshness and block/ready outcome
- `verification_write_marked`
  - implementation-side write signal that can stale downstream review, QA, and
    verification artifacts
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

## Audit-Critical Families

The audit-retained core includes:

- `anchor`
- `checkpoint`
- `task_event`
- `truth_event`
- session/turn lifecycle receipts such as `session_bootstrap`, `session_start`,
  `session_shutdown`, `turn_start`, `turn_end`, `message_end`, and `agent_end`
- hosted compaction receipts such as `session_compact_requested`,
  `session_compact`, and `session_turn_compaction_resume_requested`
- tool execution receipts such as `tool_call`, `tool_execution_start`,
  `tool_execution_end`, and `tool_result_recorded`
- `tool_result_recorded`
- `tool_output_search`
- `iteration_metric_observed`
- `iteration_guard_recorded`
- `verification_write_marked`
- `verification_outcome_recorded`
- `proposal_received`
- `proposal_decided`
- `decision_receipt_recorded`
- `effect_commitment_approval_requested`
- `effect_commitment_approval_decided`
- `effect_commitment_approval_consumed`
- `subagent_spawned`
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
- `cost_update`
- `budget_alert`
- `rollback`
- schedule lifecycle events

`tool_result_recorded` is the durable outcome event. When present,
`effectCommitmentRequestId` and `toolCallId` link the result back to the exact
approval-bearing request that authorized it.

`event_listener_error` is also audit-retained because it records fan-out
degradation without dropping the source event.

`message_update` and `tool_execution_update` now remain only in the hosted
session live stream and are no longer written to the durable tape. The durable
side keeps only the `message_end` summary and the `tool_execution_end` result.

## Operational Semantics

`tool_effect_gate_selected` records the chosen public boundary plus execution
properties such as:

- `boundary`
- `requiresApproval`
- `rollbackable`

`subagent_*` lifecycle events carry delegated-run state such as:

- `runId`
- `profile`
- `kind`
- `boundary`
- `deliveryMode`
- `deliveryHandoffState`
- `deliveryReadyAt`
- `deliverySurfacedAt`
- `supplementalAppended`

`worker_results_applied` and `worker_results_apply_failed` record the
parent-controlled adoption outcome for child-produced patches.

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
blockers and pending worker-result state. The resulting advisory surfaces remain
inspection-only and may not prescribe a single legal workflow path.

`tool_call_normalized` and `tool_call_normalization_failed` record whether the
pre-parse compatibility layer repaired or rejected a tool call. They are ops
telemetry rather than audit-default commitment memory.
`model_capability_profile_selected` and `model_request_patched` record which
capability profile the provider/model adapter selected and which request
patches it applied.
