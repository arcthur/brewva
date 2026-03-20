import { SCHEDULE_EVENT_TYPE } from "../schedule/events.js";
import { TAPE_ANCHOR_EVENT_TYPE, TAPE_CHECKPOINT_EVENT_TYPE } from "../tape/events.js";
import { TASK_EVENT_TYPE } from "../task/ledger.js";
import { TRUTH_EVENT_TYPE } from "../truth/ledger.js";

export const TOOL_RESULT_RECORDED_EVENT_TYPE = "tool_result_recorded" as const;
export const TOOL_OUTPUT_OBSERVED_EVENT_TYPE = "tool_output_observed" as const;
export const TOOL_OUTPUT_DISTILLED_EVENT_TYPE = "tool_output_distilled" as const;
export const TOOL_OUTPUT_ARTIFACT_PERSISTED_EVENT_TYPE = "tool_output_artifact_persisted" as const;
export const OBSERVABILITY_QUERY_EXECUTED_EVENT_TYPE = "observability_query_executed" as const;
export const OBSERVABILITY_ASSERTION_RECORDED_EVENT_TYPE =
  "observability_assertion_recorded" as const;
export const PROPOSAL_RECEIVED_EVENT_TYPE = "proposal_received" as const;
export const PROPOSAL_DECIDED_EVENT_TYPE = "proposal_decided" as const;
export const DECISION_RECEIPT_RECORDED_EVENT_TYPE = "decision_receipt_recorded" as const;
export const RESOURCE_LEASE_GRANTED_EVENT_TYPE = "resource_lease_granted" as const;
export const RESOURCE_LEASE_CANCELLED_EVENT_TYPE = "resource_lease_cancelled" as const;
export const RESOURCE_LEASE_EXPIRED_EVENT_TYPE = "resource_lease_expired" as const;

export const EXEC_ROUTED_EVENT_TYPE = "exec_routed" as const;
export const EXEC_FALLBACK_HOST_EVENT_TYPE = "exec_fallback_host" as const;
export const EXEC_BLOCKED_ISOLATION_EVENT_TYPE = "exec_blocked_isolation" as const;
export const EXEC_SANDBOX_ERROR_EVENT_TYPE = "exec_sandbox_error" as const;

export const VERIFICATION_WRITE_MARKED_EVENT_TYPE = "verification_write_marked" as const;
export const VERIFICATION_OUTCOME_RECORDED_EVENT_TYPE = "verification_outcome_recorded" as const;
export const VERIFICATION_STATE_RESET_EVENT_TYPE = "verification_state_reset" as const;
export const TASK_STUCK_DETECTED_EVENT_TYPE = "task_stuck_detected" as const;
export const TASK_STUCK_CLEARED_EVENT_TYPE = "task_stuck_cleared" as const;
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
export const SKILL_ROUTING_SELECTION_EVENT_TYPE = "skill_routing_selection" as const;

export const SCHEDULE_RECOVERY_DEFERRED_EVENT_TYPE = "schedule_recovery_deferred" as const;
export const SCHEDULE_RECOVERY_SUMMARY_EVENT_TYPE = "schedule_recovery_summary" as const;
export const SCHEDULE_WAKEUP_EVENT_TYPE = "schedule_wakeup" as const;
export const SCHEDULE_CHILD_SESSION_STARTED_EVENT_TYPE = "schedule_child_session_started" as const;
export const SCHEDULE_CHILD_SESSION_FINISHED_EVENT_TYPE =
  "schedule_child_session_finished" as const;
export const SCHEDULE_CHILD_SESSION_FAILED_EVENT_TYPE = "schedule_child_session_failed" as const;
export const SUBAGENT_SPAWNED_EVENT_TYPE = "subagent_spawned" as const;
export const SUBAGENT_COMPLETED_EVENT_TYPE = "subagent_completed" as const;
export const SUBAGENT_FAILED_EVENT_TYPE = "subagent_failed" as const;
export const SUBAGENT_CANCELLED_EVENT_TYPE = "subagent_cancelled" as const;
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
  OBSERVABILITY_QUERY_EXECUTED_EVENT_TYPE,
  OBSERVABILITY_ASSERTION_RECORDED_EVENT_TYPE,
  PROPOSAL_RECEIVED_EVENT_TYPE,
  PROPOSAL_DECIDED_EVENT_TYPE,
  DECISION_RECEIPT_RECORDED_EVENT_TYPE,
  RESOURCE_LEASE_GRANTED_EVENT_TYPE,
  RESOURCE_LEASE_CANCELLED_EVENT_TYPE,
  RESOURCE_LEASE_EXPIRED_EVENT_TYPE,
  EXEC_ROUTED_EVENT_TYPE,
  EXEC_FALLBACK_HOST_EVENT_TYPE,
  EXEC_BLOCKED_ISOLATION_EVENT_TYPE,
  EXEC_SANDBOX_ERROR_EVENT_TYPE,
  VERIFICATION_WRITE_MARKED_EVENT_TYPE,
  VERIFICATION_OUTCOME_RECORDED_EVENT_TYPE,
  VERIFICATION_STATE_RESET_EVENT_TYPE,
  TASK_STUCK_DETECTED_EVENT_TYPE,
  TASK_STUCK_CLEARED_EVENT_TYPE,
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
  SKILL_ROUTING_SELECTION_EVENT_TYPE,
  SCHEDULE_EVENT_TYPE,
  SCHEDULE_RECOVERY_DEFERRED_EVENT_TYPE,
  SCHEDULE_RECOVERY_SUMMARY_EVENT_TYPE,
  SCHEDULE_WAKEUP_EVENT_TYPE,
  SCHEDULE_CHILD_SESSION_STARTED_EVENT_TYPE,
  SCHEDULE_CHILD_SESSION_FINISHED_EVENT_TYPE,
  SCHEDULE_CHILD_SESSION_FAILED_EVENT_TYPE,
  SUBAGENT_SPAWNED_EVENT_TYPE,
  SUBAGENT_COMPLETED_EVENT_TYPE,
  SUBAGENT_FAILED_EVENT_TYPE,
  SUBAGENT_CANCELLED_EVENT_TYPE,
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
