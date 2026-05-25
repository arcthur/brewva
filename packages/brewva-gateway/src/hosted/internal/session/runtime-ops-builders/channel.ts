import {
  CHANNEL_SESSION_CONVERSATION_BOUND_EVENT_TYPE,
  OPERATOR_QUESTION_ANSWERED_EVENT_TYPE,
} from "@brewva/brewva-vocabulary/wire";
import type { HostedRuntimeOpsContext } from "../runtime-ops-context.js";
import type { HostedRuntimeOpsPort } from "../runtime-ops-port.js";

export function buildChannelRuntimeOps(
  ctx: HostedRuntimeOpsContext,
): HostedRuntimeOpsPort["channel"] {
  return {
    a2a: {
      blocked: ctx.recordInputPayload("channel_a2a_blocked"),
      invoked: ctx.recordInputPayload("channel_a2a_invoked"),
    },
    agent: {
      created: ctx.recordInputPayload("channel_agent_created"),
      deleted: ctx.recordInputPayload("channel_agent_deleted"),
      focusChanged: ctx.recordInputPayload("channel_agent_focus_changed"),
    },
    command: {
      operatorQuestionAnswered: ctx.recordInputPayload(OPERATOR_QUESTION_ANSWERED_EVENT_TYPE),
      received: ctx.recordInputPayload("channel_command_received"),
      rejected: ctx.recordInputPayload("channel_command_rejected"),
      updateLockBlocked: ctx.recordInputPayload("channel_update_lock_blocked"),
      updateRequested: ctx.recordInputPayload("channel_update_requested"),
    },
    discussion: {
      round: ctx.recordInputPayload("channel_discussion_round"),
    },
    fanout: {
      finished: ctx.recordInputPayload("channel_fanout_finished"),
      started: ctx.recordInputPayload("channel_fanout_started"),
    },
    ingress: {
      started: ctx.recordInputPayload("channel_ingress_started"),
      stopped: ctx.recordInputPayload("channel_ingress_stopped"),
    },
    recovery: {
      walAppended: ctx.recordInputPayload("channel_recovery_wal_appended"),
      walCompacted: ctx.recordInputPayload("channel_recovery_wal_compacted"),
      walRecoveryCompleted: ctx.recordInputPayload("channel_recovery_wal_recovery_completed"),
      walStatusChanged: ctx.recordInputPayload("channel_recovery_wal_status_changed"),
    },
    runtime: {
      evicted: ctx.recordInputPayload("channel_runtime_evicted"),
    },
    session: {
      bound: ctx.recordInputPayload("channel.session.bound"),
      conversationBound: ctx.recordInputPayload(CHANNEL_SESSION_CONVERSATION_BOUND_EVENT_TYPE),
      workspaceCostSummary: ctx.recordInputPayload("channel_session_workspace_cost_summary"),
    },
    turn: {
      approvalTargetUnresolved: ctx.recordInputPayload("channel_turn_approval_target_unresolved"),
      bridgeError: ctx.recordInputPayload("channel_turn_bridge_error"),
      dispatchEnd: ctx.recordInputPayload("channel_turn_dispatch_end"),
      dispatchStart: ctx.recordInputPayload("channel_turn_dispatch_start"),
      emitted: ctx.recordInputPayload("channel_turn_emitted"),
      ingested: ctx.recordInputPayload("channel_turn_ingested"),
      outboundComplete: ctx.recordInputPayload("channel_turn_outbound_complete"),
      outboundError: ctx.recordInputPayload("channel_turn_outbound_error"),
    },
  };
}
