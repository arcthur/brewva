import { SCHEDULE_EVENT_TYPE } from "../schedule/events.js";
import { TAPE_ANCHOR_EVENT_TYPE, TAPE_CHECKPOINT_EVENT_TYPE } from "../tape/events.js";
import { TASK_EVENT_TYPE } from "../task/ledger.js";
import { TRUTH_EVENT_TYPE } from "../truth/ledger.js";

export const TOOL_RESULT_RECORDED_EVENT_TYPE = "tool_result_recorded" as const;
export const TOOL_OUTPUT_OBSERVED_EVENT_TYPE = "tool_output_observed" as const;
export const TOOL_OUTPUT_DISTILLED_EVENT_TYPE = "tool_output_distilled" as const;
export const TOOL_OUTPUT_ARTIFACT_PERSISTED_EVENT_TYPE = "tool_output_artifact_persisted" as const;
export const TOOL_OUTPUT_ARTIFACT_PERSIST_FAILED_EVENT_TYPE =
  "tool_output_artifact_persist_failed" as const;
export const OBSERVABILITY_QUERY_EXECUTED_EVENT_TYPE = "observability_query_executed" as const;
export const OBSERVABILITY_ASSERTION_RECORDED_EVENT_TYPE =
  "observability_assertion_recorded" as const;
export const ITERATION_METRIC_OBSERVED_EVENT_TYPE = "iteration_metric_observed" as const;
export const ITERATION_GUARD_RECORDED_EVENT_TYPE = "iteration_guard_recorded" as const;
export const PROPOSAL_RECEIVED_EVENT_TYPE = "proposal_received" as const;
export const PROPOSAL_DECIDED_EVENT_TYPE = "proposal_decided" as const;
export const DECISION_RECEIPT_RECORDED_EVENT_TYPE = "decision_receipt_recorded" as const;
export const RESOURCE_LEASE_GRANTED_EVENT_TYPE = "resource_lease_granted" as const;
export const RESOURCE_LEASE_CANCELLED_EVENT_TYPE = "resource_lease_cancelled" as const;
export const RESOURCE_LEASE_EXPIRED_EVENT_TYPE = "resource_lease_expired" as const;
export const AGENT_END_EVENT_TYPE = "agent_end" as const;
export const BUDGET_ALERT_EVENT_TYPE = "budget_alert" as const;
export const CHANNEL_COMMAND_RECEIVED_EVENT_TYPE = "channel_command_received" as const;
export const OPERATOR_QUESTION_ANSWERED_EVENT_TYPE = "operator_question_answered" as const;
export const CHANNEL_SESSION_BOUND_EVENT_TYPE = "channel_session_bound" as const;
export const GATEWAY_SESSION_BOUND_EVENT_TYPE = "gateway_session_bound" as const;
export const CHANNEL_UPDATE_LOCK_BLOCKED_EVENT_TYPE = "channel_update_lock_blocked" as const;
export const CHANNEL_UPDATE_REQUESTED_EVENT_TYPE = "channel_update_requested" as const;
export const CONTEXT_COMPACTION_GATE_BLOCKED_TOOL_EVENT_TYPE =
  "context_compaction_gate_blocked_tool" as const;
export const CONTEXT_COMPACTION_GATE_CLEARED_EVENT_TYPE =
  "context_compaction_gate_cleared" as const;
export const CONTEXT_COMPACTION_AUTO_REQUESTED_EVENT_TYPE =
  "context_compaction_auto_requested" as const;
export const CONTEXT_COMPACTION_AUTO_COMPLETED_EVENT_TYPE =
  "context_compaction_auto_completed" as const;
export const CONTEXT_COMPACTION_AUTO_FAILED_EVENT_TYPE = "context_compaction_auto_failed" as const;
export const CONTEXT_COMPACTION_SKIPPED_EVENT_TYPE = "context_compaction_skipped" as const;
export const COST_UPDATE_EVENT_TYPE = "cost_update" as const;
export const FILE_SNAPSHOT_CAPTURED_EVENT_TYPE = "file_snapshot_captured" as const;
export const LEDGER_COMPACTED_EVENT_TYPE = "ledger_compacted" as const;
export const MESSAGE_END_EVENT_TYPE = "message_end" as const;
export const ROLLBACK_EVENT_TYPE = "rollback" as const;
export const SESSION_BEFORE_COMPACT_EVENT_TYPE = "session_before_compact" as const;
export const SESSION_BOOTSTRAP_EVENT_TYPE = "session_bootstrap" as const;
export const SESSION_COMPACT_EVENT_TYPE = "session_compact" as const;
export const SESSION_COMPACT_FAILED_EVENT_TYPE = "session_compact_failed" as const;
export const SESSION_COMPACT_REQUESTED_EVENT_TYPE = "session_compact_requested" as const;
export const SESSION_COMPACT_REQUEST_FAILED_EVENT_TYPE = "session_compact_request_failed" as const;
export const SESSION_SHUTDOWN_EVENT_TYPE = "session_shutdown" as const;
export const SESSION_START_EVENT_TYPE = "session_start" as const;
export const SESSION_TURN_TRANSITION_EVENT_TYPE = "session_turn_transition" as const;
export const TURN_INPUT_RECORDED_EVENT_TYPE = "turn_input_recorded" as const;
export const TURN_RENDER_COMMITTED_EVENT_TYPE = "turn_render_committed" as const;
export const SKILL_ACTIVATED_EVENT_TYPE = "skill_activated" as const;
export const SKILL_BUDGET_WARNING_EVENT_TYPE = "skill_budget_warning" as const;
export const SKILL_COMPLETED_EVENT_TYPE = "skill_completed" as const;
export const SKILL_REFRESH_RECORDED_EVENT_TYPE = "skill_refresh_recorded" as const;
export const SKILL_RECOMMENDATION_DERIVED_EVENT_TYPE = "skill_recommendation_derived" as const;
export const SKILL_PARALLEL_WARNING_EVENT_TYPE = "skill_parallel_warning" as const;
export const SKILL_PROMOTION_DRAFT_DERIVED_EVENT_TYPE = "skill_promotion_draft_derived" as const;
export const SKILL_PROMOTION_REVIEWED_EVENT_TYPE = "skill_promotion_reviewed" as const;
export const SKILL_PROMOTION_PROMOTED_EVENT_TYPE = "skill_promotion_promoted" as const;
export const SKILL_PROMOTION_MATERIALIZED_EVENT_TYPE = "skill_promotion_materialized" as const;
export const NARRATIVE_MEMORY_RECORDED_EVENT_TYPE = "narrative_memory_recorded" as const;
export const NARRATIVE_MEMORY_REVIEWED_EVENT_TYPE = "narrative_memory_reviewed" as const;
export const NARRATIVE_MEMORY_PROMOTED_EVENT_TYPE = "narrative_memory_promoted" as const;
export const NARRATIVE_MEMORY_ARCHIVED_EVENT_TYPE = "narrative_memory_archived" as const;
export const NARRATIVE_MEMORY_FORGOTTEN_EVENT_TYPE = "narrative_memory_forgotten" as const;
export const SEMANTIC_EXTRACTION_INVOKED_EVENT_TYPE = "semantic_extraction_invoked" as const;
export const SEMANTIC_RERANK_INVOKED_EVENT_TYPE = "semantic_rerank_invoked" as const;
export const TOOL_CALL_EVENT_TYPE = "tool_call" as const;
export const TOOL_CALL_BLOCKED_EVENT_TYPE = "tool_call_blocked" as const;
export const TOOL_CALL_MARKED_EVENT_TYPE = "tool_call_marked" as const;
export const TOOL_ATTEMPT_BINDING_MISSING_EVENT_TYPE = "tool_attempt_binding_missing" as const;
export const TOOL_CONTRACT_WARNING_EVENT_TYPE = "tool_contract_warning" as const;
export const TOOL_READ_PATH_GATE_ARMED_EVENT_TYPE = "tool_read_path_gate_armed" as const;
export const TOOL_READ_PATH_DISCOVERY_OBSERVED_EVENT_TYPE =
  "tool_read_path_discovery_observed" as const;
export const TOOL_EXECUTION_END_EVENT_TYPE = "tool_execution_end" as const;
export const TOOL_EXECUTION_START_EVENT_TYPE = "tool_execution_start" as const;
export const TOOL_OUTPUT_SEARCH_EVENT_TYPE = "tool_output_search" as const;
export const PATCH_RECORDED_EVENT_TYPE = "patch_recorded" as const;
export const TURN_END_EVENT_TYPE = "turn_end" as const;
export const TURN_START_EVENT_TYPE = "turn_start" as const;

export const EXEC_ROUTED_EVENT_TYPE = "exec_routed" as const;
export const EXEC_FALLBACK_HOST_EVENT_TYPE = "exec_fallback_host" as const;
export const EXEC_BLOCKED_ISOLATION_EVENT_TYPE = "exec_blocked_isolation" as const;
export const EXEC_SANDBOX_ERROR_EVENT_TYPE = "exec_sandbox_error" as const;

export const VERIFICATION_WRITE_MARKED_EVENT_TYPE = "verification_write_marked" as const;
export const VERIFICATION_OUTCOME_RECORDED_EVENT_TYPE = "verification_outcome_recorded" as const;
export const VERIFICATION_STATE_RESET_EVENT_TYPE = "verification_state_reset" as const;
export const TASK_STUCK_DETECTED_EVENT_TYPE = "task_stuck_detected" as const;
export const TASK_STUCK_CLEARED_EVENT_TYPE = "task_stuck_cleared" as const;
export const TASK_STALL_ADJUDICATED_EVENT_TYPE = "task_stall_adjudicated" as const;
export const TASK_STALL_ADJUDICATION_ERROR_EVENT_TYPE = "task_stall_adjudication_error" as const;
export const TOOL_EFFECT_GATE_SELECTED_EVENT_TYPE = "tool_effect_gate_selected" as const;
export const REVERSIBLE_MUTATION_PREPARED_EVENT_TYPE = "reversible_mutation_prepared" as const;
export const REVERSIBLE_MUTATION_RECORDED_EVENT_TYPE = "reversible_mutation_recorded" as const;
export const REVERSIBLE_MUTATION_ROLLED_BACK_EVENT_TYPE =
  "reversible_mutation_rolled_back" as const;
export const EFFECT_COMMITMENT_APPROVAL_REQUESTED_EVENT_TYPE =
  "effect_commitment_approval_requested" as const;
export const EFFECT_COMMITMENT_APPROVAL_DECIDED_EVENT_TYPE =
  "effect_commitment_approval_decided" as const;
export const EFFECT_COMMITMENT_APPROVAL_CONSUMED_EVENT_TYPE =
  "effect_commitment_approval_consumed" as const;

export const PROJECTION_INGESTED_EVENT_TYPE = "projection_ingested" as const;
export const PROJECTION_REFRESHED_EVENT_TYPE = "projection_refreshed" as const;
export const CONTEXT_COMPOSED_EVENT_TYPE = "context_composed" as const;
export const TOOL_SURFACE_RESOLVED_EVENT_TYPE = "tool_surface_resolved" as const;
export const IDENTITY_PARSE_WARNING_EVENT_TYPE = "identity_parse_warning" as const;

export const SCHEDULE_RECOVERY_DEFERRED_EVENT_TYPE = "schedule_recovery_deferred" as const;
export const SCHEDULE_RECOVERY_SUMMARY_EVENT_TYPE = "schedule_recovery_summary" as const;
export const SCHEDULE_WAKEUP_EVENT_TYPE = "schedule_wakeup" as const;
export const SCHEDULE_CHILD_SESSION_STARTED_EVENT_TYPE = "schedule_child_session_started" as const;
export const SCHEDULE_CHILD_SESSION_FINISHED_EVENT_TYPE =
  "schedule_child_session_finished" as const;
export const SCHEDULE_CHILD_SESSION_FAILED_EVENT_TYPE = "schedule_child_session_failed" as const;
export const SUBAGENT_SPAWNED_EVENT_TYPE = "subagent_spawned" as const;
export const SUBAGENT_RUNNING_EVENT_TYPE = "subagent_running" as const;
export const SUBAGENT_COMPLETED_EVENT_TYPE = "subagent_completed" as const;
export const SUBAGENT_FAILED_EVENT_TYPE = "subagent_failed" as const;
export const SUBAGENT_CANCELLED_EVENT_TYPE = "subagent_cancelled" as const;
export const SUBAGENT_OUTCOME_PARSE_FAILED_EVENT_TYPE = "subagent_outcome_parse_failed" as const;
export const SUBAGENT_DELIVERY_SURFACED_EVENT_TYPE = "subagent_delivery_surfaced" as const;
export const WORKER_RESULTS_APPLIED_EVENT_TYPE = "worker_results_applied" as const;
export const WORKER_RESULTS_APPLY_FAILED_EVENT_TYPE = "worker_results_apply_failed" as const;

export const GOVERNANCE_VERIFY_SPEC_PASSED_EVENT_TYPE = "governance_verify_spec_passed" as const;
export const GOVERNANCE_VERIFY_SPEC_FAILED_EVENT_TYPE = "governance_verify_spec_failed" as const;
export const GOVERNANCE_VERIFY_SPEC_ERROR_EVENT_TYPE = "governance_verify_spec_error" as const;
export const GOVERNANCE_COST_ANOMALY_DETECTED_EVENT_TYPE =
  "governance_cost_anomaly_detected" as const;
export const GOVERNANCE_COST_ANOMALY_ERROR_EVENT_TYPE = "governance_cost_anomaly_error" as const;
export const GOVERNANCE_METADATA_MISSING_EVENT_TYPE = "governance_metadata_missing" as const;
export const GOVERNANCE_COMPACTION_INTEGRITY_CHECKED_EVENT_TYPE =
  "governance_compaction_integrity_checked" as const;
export const GOVERNANCE_COMPACTION_INTEGRITY_FAILED_EVENT_TYPE =
  "governance_compaction_integrity_failed" as const;
export const GOVERNANCE_COMPACTION_INTEGRITY_ERROR_EVENT_TYPE =
  "governance_compaction_integrity_error" as const;
export const EVENT_LISTENER_ERROR_EVENT_TYPE = "event_listener_error" as const;

export const BREWVA_REGISTERED_EVENT_TYPES = [
  TAPE_ANCHOR_EVENT_TYPE,
  TAPE_CHECKPOINT_EVENT_TYPE,
  TASK_EVENT_TYPE,
  TRUTH_EVENT_TYPE,
  TOOL_RESULT_RECORDED_EVENT_TYPE,
  TOOL_OUTPUT_OBSERVED_EVENT_TYPE,
  TOOL_OUTPUT_DISTILLED_EVENT_TYPE,
  TOOL_OUTPUT_ARTIFACT_PERSISTED_EVENT_TYPE,
  TOOL_OUTPUT_ARTIFACT_PERSIST_FAILED_EVENT_TYPE,
  OBSERVABILITY_QUERY_EXECUTED_EVENT_TYPE,
  OBSERVABILITY_ASSERTION_RECORDED_EVENT_TYPE,
  ITERATION_METRIC_OBSERVED_EVENT_TYPE,
  ITERATION_GUARD_RECORDED_EVENT_TYPE,
  PROPOSAL_RECEIVED_EVENT_TYPE,
  PROPOSAL_DECIDED_EVENT_TYPE,
  DECISION_RECEIPT_RECORDED_EVENT_TYPE,
  RESOURCE_LEASE_GRANTED_EVENT_TYPE,
  RESOURCE_LEASE_CANCELLED_EVENT_TYPE,
  RESOURCE_LEASE_EXPIRED_EVENT_TYPE,
  AGENT_END_EVENT_TYPE,
  BUDGET_ALERT_EVENT_TYPE,
  CHANNEL_COMMAND_RECEIVED_EVENT_TYPE,
  OPERATOR_QUESTION_ANSWERED_EVENT_TYPE,
  CHANNEL_SESSION_BOUND_EVENT_TYPE,
  GATEWAY_SESSION_BOUND_EVENT_TYPE,
  CHANNEL_UPDATE_LOCK_BLOCKED_EVENT_TYPE,
  CHANNEL_UPDATE_REQUESTED_EVENT_TYPE,
  CONTEXT_COMPACTION_GATE_BLOCKED_TOOL_EVENT_TYPE,
  CONTEXT_COMPACTION_GATE_CLEARED_EVENT_TYPE,
  CONTEXT_COMPACTION_AUTO_REQUESTED_EVENT_TYPE,
  CONTEXT_COMPACTION_AUTO_COMPLETED_EVENT_TYPE,
  CONTEXT_COMPACTION_AUTO_FAILED_EVENT_TYPE,
  CONTEXT_COMPACTION_SKIPPED_EVENT_TYPE,
  COST_UPDATE_EVENT_TYPE,
  FILE_SNAPSHOT_CAPTURED_EVENT_TYPE,
  LEDGER_COMPACTED_EVENT_TYPE,
  MESSAGE_END_EVENT_TYPE,
  ROLLBACK_EVENT_TYPE,
  SESSION_BEFORE_COMPACT_EVENT_TYPE,
  SESSION_BOOTSTRAP_EVENT_TYPE,
  SESSION_COMPACT_EVENT_TYPE,
  SESSION_COMPACT_FAILED_EVENT_TYPE,
  SESSION_COMPACT_REQUESTED_EVENT_TYPE,
  SESSION_COMPACT_REQUEST_FAILED_EVENT_TYPE,
  SESSION_SHUTDOWN_EVENT_TYPE,
  SESSION_START_EVENT_TYPE,
  SESSION_TURN_TRANSITION_EVENT_TYPE,
  TURN_INPUT_RECORDED_EVENT_TYPE,
  TURN_RENDER_COMMITTED_EVENT_TYPE,
  SKILL_ACTIVATED_EVENT_TYPE,
  SKILL_BUDGET_WARNING_EVENT_TYPE,
  SKILL_COMPLETED_EVENT_TYPE,
  SKILL_REFRESH_RECORDED_EVENT_TYPE,
  SKILL_RECOMMENDATION_DERIVED_EVENT_TYPE,
  SKILL_PARALLEL_WARNING_EVENT_TYPE,
  SKILL_PROMOTION_DRAFT_DERIVED_EVENT_TYPE,
  SKILL_PROMOTION_REVIEWED_EVENT_TYPE,
  SKILL_PROMOTION_PROMOTED_EVENT_TYPE,
  SKILL_PROMOTION_MATERIALIZED_EVENT_TYPE,
  NARRATIVE_MEMORY_RECORDED_EVENT_TYPE,
  NARRATIVE_MEMORY_REVIEWED_EVENT_TYPE,
  NARRATIVE_MEMORY_PROMOTED_EVENT_TYPE,
  NARRATIVE_MEMORY_ARCHIVED_EVENT_TYPE,
  NARRATIVE_MEMORY_FORGOTTEN_EVENT_TYPE,
  SEMANTIC_EXTRACTION_INVOKED_EVENT_TYPE,
  SEMANTIC_RERANK_INVOKED_EVENT_TYPE,
  TOOL_CALL_EVENT_TYPE,
  TOOL_CALL_BLOCKED_EVENT_TYPE,
  TOOL_CALL_MARKED_EVENT_TYPE,
  TOOL_ATTEMPT_BINDING_MISSING_EVENT_TYPE,
  TOOL_CONTRACT_WARNING_EVENT_TYPE,
  TOOL_READ_PATH_GATE_ARMED_EVENT_TYPE,
  TOOL_READ_PATH_DISCOVERY_OBSERVED_EVENT_TYPE,
  TOOL_EXECUTION_END_EVENT_TYPE,
  TOOL_EXECUTION_START_EVENT_TYPE,
  TOOL_OUTPUT_SEARCH_EVENT_TYPE,
  PATCH_RECORDED_EVENT_TYPE,
  TURN_END_EVENT_TYPE,
  TURN_START_EVENT_TYPE,
  EXEC_ROUTED_EVENT_TYPE,
  EXEC_FALLBACK_HOST_EVENT_TYPE,
  EXEC_BLOCKED_ISOLATION_EVENT_TYPE,
  EXEC_SANDBOX_ERROR_EVENT_TYPE,
  VERIFICATION_WRITE_MARKED_EVENT_TYPE,
  VERIFICATION_OUTCOME_RECORDED_EVENT_TYPE,
  VERIFICATION_STATE_RESET_EVENT_TYPE,
  TASK_STUCK_DETECTED_EVENT_TYPE,
  TASK_STUCK_CLEARED_EVENT_TYPE,
  TASK_STALL_ADJUDICATED_EVENT_TYPE,
  TASK_STALL_ADJUDICATION_ERROR_EVENT_TYPE,
  TOOL_EFFECT_GATE_SELECTED_EVENT_TYPE,
  REVERSIBLE_MUTATION_PREPARED_EVENT_TYPE,
  REVERSIBLE_MUTATION_RECORDED_EVENT_TYPE,
  REVERSIBLE_MUTATION_ROLLED_BACK_EVENT_TYPE,
  EFFECT_COMMITMENT_APPROVAL_REQUESTED_EVENT_TYPE,
  EFFECT_COMMITMENT_APPROVAL_DECIDED_EVENT_TYPE,
  EFFECT_COMMITMENT_APPROVAL_CONSUMED_EVENT_TYPE,
  PROJECTION_INGESTED_EVENT_TYPE,
  PROJECTION_REFRESHED_EVENT_TYPE,
  CONTEXT_COMPOSED_EVENT_TYPE,
  TOOL_SURFACE_RESOLVED_EVENT_TYPE,
  IDENTITY_PARSE_WARNING_EVENT_TYPE,
  SCHEDULE_EVENT_TYPE,
  SCHEDULE_RECOVERY_DEFERRED_EVENT_TYPE,
  SCHEDULE_RECOVERY_SUMMARY_EVENT_TYPE,
  SCHEDULE_WAKEUP_EVENT_TYPE,
  SCHEDULE_CHILD_SESSION_STARTED_EVENT_TYPE,
  SCHEDULE_CHILD_SESSION_FINISHED_EVENT_TYPE,
  SCHEDULE_CHILD_SESSION_FAILED_EVENT_TYPE,
  SUBAGENT_SPAWNED_EVENT_TYPE,
  SUBAGENT_RUNNING_EVENT_TYPE,
  SUBAGENT_COMPLETED_EVENT_TYPE,
  SUBAGENT_FAILED_EVENT_TYPE,
  SUBAGENT_CANCELLED_EVENT_TYPE,
  SUBAGENT_OUTCOME_PARSE_FAILED_EVENT_TYPE,
  SUBAGENT_DELIVERY_SURFACED_EVENT_TYPE,
  WORKER_RESULTS_APPLIED_EVENT_TYPE,
  WORKER_RESULTS_APPLY_FAILED_EVENT_TYPE,
  GOVERNANCE_VERIFY_SPEC_PASSED_EVENT_TYPE,
  GOVERNANCE_VERIFY_SPEC_FAILED_EVENT_TYPE,
  GOVERNANCE_VERIFY_SPEC_ERROR_EVENT_TYPE,
  GOVERNANCE_COST_ANOMALY_DETECTED_EVENT_TYPE,
  GOVERNANCE_COST_ANOMALY_ERROR_EVENT_TYPE,
  GOVERNANCE_METADATA_MISSING_EVENT_TYPE,
  GOVERNANCE_COMPACTION_INTEGRITY_CHECKED_EVENT_TYPE,
  GOVERNANCE_COMPACTION_INTEGRITY_FAILED_EVENT_TYPE,
  GOVERNANCE_COMPACTION_INTEGRITY_ERROR_EVENT_TYPE,
  EVENT_LISTENER_ERROR_EVENT_TYPE,
] as const;

export type BrewvaRegisteredEventType = (typeof BREWVA_REGISTERED_EVENT_TYPES)[number];

export const BREWVA_REGISTERED_EVENT_TYPE_SET: ReadonlySet<BrewvaRegisteredEventType> = new Set(
  BREWVA_REGISTERED_EVENT_TYPES,
);

export function isBrewvaRegisteredEventType(value: string): value is BrewvaRegisteredEventType {
  return BREWVA_REGISTERED_EVENT_TYPE_SET.has(value as BrewvaRegisteredEventType);
}
