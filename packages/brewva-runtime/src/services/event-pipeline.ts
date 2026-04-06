import { formatISO } from "date-fns";
import type {
  BrewvaEventCategory,
  BrewvaEventQuery,
  BrewvaEventRecord,
  BrewvaReplaySession,
  BrewvaStructuredEvent,
} from "../contracts/index.js";
import {
  AGENT_END_EVENT_TYPE,
  BUDGET_ALERT_EVENT_TYPE,
  CHANNEL_COMMAND_RECEIVED_EVENT_TYPE,
  CHANNEL_SESSION_BOUND_EVENT_TYPE,
  CHANNEL_UPDATE_LOCK_BLOCKED_EVENT_TYPE,
  CHANNEL_UPDATE_REQUESTED_EVENT_TYPE,
  CONTEXT_COMPACTION_AUTO_COMPLETED_EVENT_TYPE,
  CONTEXT_COMPACTION_AUTO_FAILED_EVENT_TYPE,
  CONTEXT_COMPACTION_AUTO_REQUESTED_EVENT_TYPE,
  CONTEXT_COMPACTION_GATE_BLOCKED_TOOL_EVENT_TYPE,
  CONTEXT_COMPACTION_GATE_CLEARED_EVENT_TYPE,
  CONTEXT_COMPACTION_SKIPPED_EVENT_TYPE,
  COST_UPDATE_EVENT_TYPE,
  DECISION_RECEIPT_RECORDED_EVENT_TYPE,
  EFFECT_COMMITMENT_APPROVAL_CONSUMED_EVENT_TYPE,
  EFFECT_COMMITMENT_APPROVAL_DECIDED_EVENT_TYPE,
  EFFECT_COMMITMENT_APPROVAL_REQUESTED_EVENT_TYPE,
  EVENT_LISTENER_ERROR_EVENT_TYPE,
  FILE_SNAPSHOT_CAPTURED_EVENT_TYPE,
  GOVERNANCE_COMPACTION_INTEGRITY_CHECKED_EVENT_TYPE,
  GOVERNANCE_COMPACTION_INTEGRITY_ERROR_EVENT_TYPE,
  GOVERNANCE_COMPACTION_INTEGRITY_FAILED_EVENT_TYPE,
  GOVERNANCE_COST_ANOMALY_DETECTED_EVENT_TYPE,
  GOVERNANCE_COST_ANOMALY_ERROR_EVENT_TYPE,
  GOVERNANCE_METADATA_MISSING_EVENT_TYPE,
  GOVERNANCE_VERIFY_SPEC_ERROR_EVENT_TYPE,
  GOVERNANCE_VERIFY_SPEC_FAILED_EVENT_TYPE,
  GOVERNANCE_VERIFY_SPEC_PASSED_EVENT_TYPE,
  IDENTITY_PARSE_WARNING_EVENT_TYPE,
  ITERATION_GUARD_RECORDED_EVENT_TYPE,
  ITERATION_METRIC_OBSERVED_EVENT_TYPE,
  LEDGER_COMPACTED_EVENT_TYPE,
  MESSAGE_END_EVENT_TYPE,
  OBSERVABILITY_ASSERTION_RECORDED_EVENT_TYPE,
  OBSERVABILITY_QUERY_EXECUTED_EVENT_TYPE,
  OPERATOR_QUESTION_ANSWERED_EVENT_TYPE,
  PATCH_RECORDED_EVENT_TYPE,
  PROPOSAL_DECIDED_EVENT_TYPE,
  PROPOSAL_RECEIVED_EVENT_TYPE,
  RESOURCE_LEASE_CANCELLED_EVENT_TYPE,
  RESOURCE_LEASE_EXPIRED_EVENT_TYPE,
  RESOURCE_LEASE_GRANTED_EVENT_TYPE,
  ROLLBACK_EVENT_TYPE,
  REVERSIBLE_MUTATION_PREPARED_EVENT_TYPE,
  REVERSIBLE_MUTATION_RECORDED_EVENT_TYPE,
  REVERSIBLE_MUTATION_ROLLED_BACK_EVENT_TYPE,
  SCHEDULE_CHILD_SESSION_FAILED_EVENT_TYPE,
  SCHEDULE_CHILD_SESSION_FINISHED_EVENT_TYPE,
  SCHEDULE_CHILD_SESSION_STARTED_EVENT_TYPE,
  SCHEDULE_RECOVERY_DEFERRED_EVENT_TYPE,
  SCHEDULE_RECOVERY_SUMMARY_EVENT_TYPE,
  SCHEDULE_WAKEUP_EVENT_TYPE,
  SESSION_BEFORE_COMPACT_EVENT_TYPE,
  SESSION_BOOTSTRAP_EVENT_TYPE,
  SESSION_COMPACT_EVENT_TYPE,
  SESSION_COMPACT_FAILED_EVENT_TYPE,
  SESSION_COMPACT_REQUESTED_EVENT_TYPE,
  SESSION_COMPACT_REQUEST_FAILED_EVENT_TYPE,
  SESSION_SHUTDOWN_EVENT_TYPE,
  SESSION_START_EVENT_TYPE,
  SESSION_TURN_TRANSITION_EVENT_TYPE,
  SKILL_ACTIVATED_EVENT_TYPE,
  SKILL_BUDGET_WARNING_EVENT_TYPE,
  SKILL_COMPLETED_EVENT_TYPE,
  SKILL_PARALLEL_WARNING_EVENT_TYPE,
  SKILL_RECOMMENDATION_DERIVED_EVENT_TYPE,
  SKILL_PROMOTION_DRAFT_DERIVED_EVENT_TYPE,
  SKILL_PROMOTION_MATERIALIZED_EVENT_TYPE,
  SKILL_PROMOTION_PROMOTED_EVENT_TYPE,
  SKILL_PROMOTION_REVIEWED_EVENT_TYPE,
  SKILL_REFRESH_RECORDED_EVENT_TYPE,
  SUBAGENT_CANCELLED_EVENT_TYPE,
  SUBAGENT_COMPLETED_EVENT_TYPE,
  SUBAGENT_DELIVERY_SURFACED_EVENT_TYPE,
  SUBAGENT_FAILED_EVENT_TYPE,
  SUBAGENT_OUTCOME_PARSE_FAILED_EVENT_TYPE,
  SUBAGENT_RUNNING_EVENT_TYPE,
  SUBAGENT_SPAWNED_EVENT_TYPE,
  TASK_STALL_ADJUDICATED_EVENT_TYPE,
  TASK_STALL_ADJUDICATION_ERROR_EVENT_TYPE,
  TASK_STUCK_CLEARED_EVENT_TYPE,
  TASK_STUCK_DETECTED_EVENT_TYPE,
  TOOL_CALL_BLOCKED_EVENT_TYPE,
  TOOL_CALL_EVENT_TYPE,
  TOOL_CALL_MARKED_EVENT_TYPE,
  TOOL_ATTEMPT_BINDING_MISSING_EVENT_TYPE,
  TOOL_CONTRACT_WARNING_EVENT_TYPE,
  TOOL_READ_PATH_DISCOVERY_OBSERVED_EVENT_TYPE,
  TOOL_READ_PATH_GATE_ARMED_EVENT_TYPE,
  TOOL_EFFECT_GATE_SELECTED_EVENT_TYPE,
  TOOL_EXECUTION_END_EVENT_TYPE,
  TOOL_EXECUTION_START_EVENT_TYPE,
  TOOL_OUTPUT_ARTIFACT_PERSIST_FAILED_EVENT_TYPE,
  TOOL_OUTPUT_ARTIFACT_PERSISTED_EVENT_TYPE,
  TOOL_OUTPUT_DISTILLED_EVENT_TYPE,
  TOOL_OUTPUT_OBSERVED_EVENT_TYPE,
  TOOL_OUTPUT_SEARCH_EVENT_TYPE,
  TOOL_RESULT_RECORDED_EVENT_TYPE,
  TURN_INPUT_RECORDED_EVENT_TYPE,
  TURN_RENDER_COMMITTED_EVENT_TYPE,
  TURN_END_EVENT_TYPE,
  TURN_START_EVENT_TYPE,
  VERIFICATION_OUTCOME_RECORDED_EVENT_TYPE,
  VERIFICATION_STATE_RESET_EVENT_TYPE,
  VERIFICATION_WRITE_MARKED_EVENT_TYPE,
  WORKER_RESULTS_APPLIED_EVENT_TYPE,
  WORKER_RESULTS_APPLY_FAILED_EVENT_TYPE,
} from "../events/event-types.js";
import { BrewvaEventStore } from "../events/store.js";
import { SCHEDULE_EVENT_TYPE } from "../schedule/events.js";
import { TAPE_ANCHOR_EVENT_TYPE, TAPE_CHECKPOINT_EVENT_TYPE } from "../tape/events.js";
import { TASK_EVENT_TYPE } from "../task/ledger.js";
import { TRUTH_EVENT_TYPE } from "../truth/ledger.js";
import type { JsonValue } from "../utils/json.js";
import type { RuntimeCallback } from "./callback.js";

const AUDIT_EVENT_TYPES = new Set<string>([
  TAPE_ANCHOR_EVENT_TYPE,
  TAPE_CHECKPOINT_EVENT_TYPE,
  TASK_EVENT_TYPE,
  TRUTH_EVENT_TYPE,
  TOOL_EFFECT_GATE_SELECTED_EVENT_TYPE,
  TOOL_OUTPUT_OBSERVED_EVENT_TYPE,
  TOOL_OUTPUT_DISTILLED_EVENT_TYPE,
  TOOL_OUTPUT_ARTIFACT_PERSISTED_EVENT_TYPE,
  TOOL_OUTPUT_ARTIFACT_PERSIST_FAILED_EVENT_TYPE,
  TOOL_RESULT_RECORDED_EVENT_TYPE,
  RESOURCE_LEASE_GRANTED_EVENT_TYPE,
  RESOURCE_LEASE_CANCELLED_EVENT_TYPE,
  RESOURCE_LEASE_EXPIRED_EVENT_TYPE,
  VERIFICATION_WRITE_MARKED_EVENT_TYPE,
  REVERSIBLE_MUTATION_PREPARED_EVENT_TYPE,
  REVERSIBLE_MUTATION_RECORDED_EVENT_TYPE,
  REVERSIBLE_MUTATION_ROLLED_BACK_EVENT_TYPE,
  PROPOSAL_RECEIVED_EVENT_TYPE,
  PROPOSAL_DECIDED_EVENT_TYPE,
  DECISION_RECEIPT_RECORDED_EVENT_TYPE,
  EFFECT_COMMITMENT_APPROVAL_REQUESTED_EVENT_TYPE,
  EFFECT_COMMITMENT_APPROVAL_DECIDED_EVENT_TYPE,
  EFFECT_COMMITMENT_APPROVAL_CONSUMED_EVENT_TYPE,
  OPERATOR_QUESTION_ANSWERED_EVENT_TYPE,
  OBSERVABILITY_QUERY_EXECUTED_EVENT_TYPE,
  OBSERVABILITY_ASSERTION_RECORDED_EVENT_TYPE,
  ITERATION_METRIC_OBSERVED_EVENT_TYPE,
  ITERATION_GUARD_RECORDED_EVENT_TYPE,
  VERIFICATION_OUTCOME_RECORDED_EVENT_TYPE,
  VERIFICATION_STATE_RESET_EVENT_TYPE,
  GOVERNANCE_VERIFY_SPEC_PASSED_EVENT_TYPE,
  GOVERNANCE_VERIFY_SPEC_FAILED_EVENT_TYPE,
  GOVERNANCE_VERIFY_SPEC_ERROR_EVENT_TYPE,
  GOVERNANCE_COST_ANOMALY_DETECTED_EVENT_TYPE,
  GOVERNANCE_COST_ANOMALY_ERROR_EVENT_TYPE,
  GOVERNANCE_METADATA_MISSING_EVENT_TYPE,
  GOVERNANCE_COMPACTION_INTEGRITY_CHECKED_EVENT_TYPE,
  GOVERNANCE_COMPACTION_INTEGRITY_FAILED_EVENT_TYPE,
  GOVERNANCE_COMPACTION_INTEGRITY_ERROR_EVENT_TYPE,
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
  SUBAGENT_DELIVERY_SURFACED_EVENT_TYPE,
  SUBAGENT_OUTCOME_PARSE_FAILED_EVENT_TYPE,
  WORKER_RESULTS_APPLIED_EVENT_TYPE,
  WORKER_RESULTS_APPLY_FAILED_EVENT_TYPE,
  TASK_STALL_ADJUDICATED_EVENT_TYPE,
  AGENT_END_EVENT_TYPE,
  BUDGET_ALERT_EVENT_TYPE,
  CHANNEL_SESSION_BOUND_EVENT_TYPE,
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
  SKILL_PARALLEL_WARNING_EVENT_TYPE,
  SKILL_RECOMMENDATION_DERIVED_EVENT_TYPE,
  SKILL_PROMOTION_DRAFT_DERIVED_EVENT_TYPE,
  SKILL_PROMOTION_REVIEWED_EVENT_TYPE,
  SKILL_PROMOTION_PROMOTED_EVENT_TYPE,
  SKILL_PROMOTION_MATERIALIZED_EVENT_TYPE,
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
]);

const OPS_EVENT_TYPES = new Set<string>([
  TASK_STUCK_DETECTED_EVENT_TYPE,
  TASK_STUCK_CLEARED_EVENT_TYPE,
  TASK_STALL_ADJUDICATION_ERROR_EVENT_TYPE,
  "channel_agent_created",
  "channel_agent_deleted",
  CHANNEL_COMMAND_RECEIVED_EVENT_TYPE,
  "channel_command_rejected",
  "channel_conversation_bound",
  "channel_discussion_round",
  "channel_fanout_finished",
  "channel_fanout_started",
  "channel_focus_changed",
  "channel_ingress_started",
  "channel_ingress_stopped",
  "channel_runtime_evicted",
  "channel_skill_policy_degraded",
  "channel_turn_bridge_error",
  "channel_turn_dispatch_end",
  "channel_turn_dispatch_start",
  "channel_turn_emitted",
  "channel_turn_ingested",
  "channel_turn_outbound_complete",
  "channel_turn_outbound_error",
  CHANNEL_UPDATE_LOCK_BLOCKED_EVENT_TYPE,
  CHANNEL_UPDATE_REQUESTED_EVENT_TYPE,
  "channel_workspace_cost_summary",
  "context_arena_slo_enforced",
  "context_compacted",
  "context_compaction_advisory",
  "context_compaction_auto_completed",
  "context_compaction_auto_failed",
  "context_compaction_auto_requested",
  "context_compaction_gate_armed",
  "context_compaction_gate_cleared",
  "context_compaction_requested",
  "context_compaction_skipped",
  "context_injected",
  "context_injection_dropped",
  "context_usage",
  "exec_blocked_isolation",
  "exec_fallback_host",
  "exec_routed",
  "exec_sandbox_error",
  IDENTITY_PARSE_WARNING_EVENT_TYPE,
  "parallel_slot_rejected",
  "projection_ingested",
  "projection_refreshed",
  SKILL_REFRESH_RECORDED_EVENT_TYPE,
  "tool_parallel_read",
  "tool_surface_resolved",
]);

const DEBUG_EVENT_TYPES = new Set<string>(["tool_parallel_read"]);

const RECOVERY_WAL_EVENT_TYPES = new Set<string>([
  "recovery_wal_appended",
  "recovery_wal_status_changed",
  "recovery_wal_recovery_completed",
  "recovery_wal_compacted",
]);

const RESERVED_RUNTIME_EVENT_PREFIXES = [
  "budget_",
  "channel_",
  "context_",
  "cost_",
  "decision_receipt_",
  "exec_",
  "governance_",
  "iteration_",
  "model_",
  "projection_",
  "proposal_",
  "resource_lease_",
  "schedule_",
  "session_",
  "skill_",
  "subagent_",
  "tool_",
  "turn_",
  "verification_",
  "worker_results_",
] as const;

export interface RuntimeRecordEventInput<TPayload extends object = Record<string, JsonValue>> {
  sessionId: string;
  type: string;
  turn?: number;
  payload?: TPayload;
  timestamp?: number;
  skipTapeCheckpoint?: boolean;
}

export type RuntimeRecordEvent = <TPayload extends object>(
  input: RuntimeRecordEventInput<TPayload>,
) => BrewvaEventRecord | undefined;

export interface EventPipelineServiceOptions {
  events: BrewvaEventStore;
  level: "audit" | "ops" | "debug";
  inferEventCategory: RuntimeCallback<[type: string], BrewvaEventCategory>;
  observeReplayEvent: RuntimeCallback<[event: BrewvaEventRecord]>;
  ingestProjectionEvent: RuntimeCallback<[event: BrewvaEventRecord]>;
  maybeRecordTapeCheckpoint: RuntimeCallback<[event: BrewvaEventRecord]>;
}

export class EventPipelineService {
  private readonly events: BrewvaEventStore;
  private readonly level: "audit" | "ops" | "debug";
  private readonly inferEventCategory: (type: string) => BrewvaEventCategory;
  private readonly observeReplayEvent: (event: BrewvaEventRecord) => void;
  private readonly ingestProjectionEvent: (event: BrewvaEventRecord) => void;
  private readonly maybeRecordTapeCheckpoint: (event: BrewvaEventRecord) => void;
  private readonly eventListeners = new Set<(event: BrewvaStructuredEvent) => void>();

  constructor(options: EventPipelineServiceOptions) {
    this.events = options.events;
    this.level = options.level;
    this.inferEventCategory = options.inferEventCategory;
    this.observeReplayEvent = options.observeReplayEvent;
    this.ingestProjectionEvent = options.ingestProjectionEvent;
    this.maybeRecordTapeCheckpoint = options.maybeRecordTapeCheckpoint;
  }

  recordEvent<TPayload extends object>(
    input: RuntimeRecordEventInput<TPayload>,
  ): BrewvaEventRecord | undefined {
    return this.appendEvent(input, { emitListeners: true });
  }

  private appendEvent<TPayload extends object>(
    input: RuntimeRecordEventInput<TPayload>,
    options: { emitListeners: boolean },
  ): BrewvaEventRecord | undefined {
    if (!this.shouldEmit(input.type)) {
      return undefined;
    }

    const row = this.events.append({
      sessionId: input.sessionId,
      type: input.type,
      turn: input.turn,
      payload: input.payload,
      timestamp: input.timestamp,
    });
    if (!row) return undefined;

    this.observeReplayEvent(row);

    let listenerErrors:
      | Array<{
          listenerIndex: number;
          listenerName: string;
          errorName: string;
          errorMessage: string;
          errorStack?: string;
        }>
      | undefined;
    if (options.emitListeners) {
      const structured = this.toStructuredEvent(row);
      listenerErrors = this.notifyListeners(structured);
    }

    this.ingestProjectionEvent(row);
    if (!input.skipTapeCheckpoint) {
      this.maybeRecordTapeCheckpoint(row);
    }

    if (listenerErrors && listenerErrors.length > 0) {
      for (const listenerError of listenerErrors) {
        this.appendEvent(
          {
            sessionId: row.sessionId,
            type: EVENT_LISTENER_ERROR_EVENT_TYPE,
            turn: row.turn,
            timestamp: row.timestamp,
            payload: {
              sourceEventId: row.id,
              sourceEventType: row.type,
              listenerIndex: listenerError.listenerIndex,
              listenerName: listenerError.listenerName,
              errorName: listenerError.errorName,
              errorMessage: listenerError.errorMessage,
              errorStack: listenerError.errorStack,
            },
            skipTapeCheckpoint: true,
          },
          { emitListeners: false },
        );
      }
    }

    return row;
  }

  private shouldEmit(type: string): boolean {
    if (this.level === "debug") return true;
    const eventLevel = this.classifyEventLevel(type);
    if (this.level === "ops") return eventLevel !== "debug";
    return eventLevel === "audit";
  }

  private classifyEventLevel(type: string): "audit" | "ops" | "debug" {
    if (DEBUG_EVENT_TYPES.has(type)) return "debug";
    if (AUDIT_EVENT_TYPES.has(type)) return "audit";
    if (type === EVENT_LISTENER_ERROR_EVENT_TYPE) return "audit";
    if (RECOVERY_WAL_EVENT_TYPES.has(type)) return "ops";
    if (OPS_EVENT_TYPES.has(type)) return "ops";
    for (const prefix of RESERVED_RUNTIME_EVENT_PREFIXES) {
      if (type.startsWith(prefix)) {
        return "ops";
      }
    }
    return "audit";
  }

  queryEvents(sessionId: string, query: BrewvaEventQuery = {}): BrewvaEventRecord[] {
    return this.events.list(sessionId, query);
  }

  queryStructuredEvents(sessionId: string, query: BrewvaEventQuery = {}): BrewvaStructuredEvent[] {
    return this.events.list(sessionId, query).map((event) => this.toStructuredEvent(event));
  }

  listReplaySessions(limit?: number): BrewvaReplaySession[] {
    const sessionIds = this.events.listSessionIds();
    const rows: BrewvaReplaySession[] = [];

    for (const sessionId of sessionIds) {
      const events = this.events.list(sessionId);
      if (events.length === 0) continue;
      rows.push({
        sessionId,
        eventCount: events.length,
        lastEventAt: events[events.length - 1]?.timestamp ?? 0,
      });
    }

    if (typeof limit === "number" && Number.isFinite(limit) && limit > 0) {
      return rows.slice(0, limit);
    }
    return rows;
  }

  subscribeEvents(listener: (event: BrewvaStructuredEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => {
      this.eventListeners.delete(listener);
    };
  }

  private notifyListeners(event: BrewvaStructuredEvent): Array<{
    listenerIndex: number;
    listenerName: string;
    errorName: string;
    errorMessage: string;
    errorStack?: string;
  }> {
    const errors: Array<{
      listenerIndex: number;
      listenerName: string;
      errorName: string;
      errorMessage: string;
      errorStack?: string;
    }> = [];
    let listenerIndex = 0;
    for (const listener of this.eventListeners.values()) {
      listenerIndex += 1;
      try {
        listener(event);
      } catch (error) {
        errors.push({
          listenerIndex,
          listenerName: listener.name || "anonymous_listener",
          errorName: error instanceof Error ? error.name : "UnknownError",
          errorMessage: error instanceof Error ? error.message : String(error),
          errorStack: error instanceof Error ? error.stack : undefined,
        });
      }
    }
    return errors;
  }

  toStructuredEvent(event: BrewvaEventRecord): BrewvaStructuredEvent {
    return {
      schema: "brewva.event.v1",
      id: event.id,
      sessionId: event.sessionId,
      type: event.type,
      category: this.inferEventCategory(event.type),
      timestamp: event.timestamp,
      isoTime: formatISO(event.timestamp),
      turn: event.turn,
      payload: event.payload,
    };
  }
}
