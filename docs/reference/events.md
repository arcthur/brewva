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

### Tool, Verification, And Mutation

- `tool_result_recorded`
- `tool_output_observed`
- `tool_output_distilled`
- `tool_output_artifact_persisted`
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
- `skill_routing_selection`
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
- `worker_results_applied`
- `worker_results_apply_failed`

## Audit-Critical Families

The audit-retained core includes:

- `anchor`
- `checkpoint`
- `task_event`
- `truth_event`
- `tool_result_recorded`
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
- `worker_results_applied`
- `worker_results_apply_failed`
- schedule lifecycle events

`tool_result_recorded` is the durable outcome event. When present,
`effectCommitmentRequestId` and `toolCallId` link the result back to the exact
approval-bearing request that authorized it.

`event_listener_error` is also audit-retained because it records fan-out
degradation without dropping the source event.

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
- `supplementalAppended`

`worker_results_applied` and `worker_results_apply_failed` record the
parent-controlled adoption outcome for child-produced patches.
