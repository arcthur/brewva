import * as DelegationEvents from "@brewva/brewva-vocabulary/delegation";
import type { HostedRuntimeOpsContext } from "../runtime-ops-context.js";
import type { HostedRuntimeOpsPort } from "../runtime-ops-port.js";

export function buildDelegationRuntimeOps(
  ctx: HostedRuntimeOpsContext,
): HostedRuntimeOpsPort["delegation"] {
  return {
    lifecycle: {
      cancelled: ctx.recordInputPayload("subagent_cancelled"),
      completed: ctx.recordInputPayload("subagent_completed"),
      deliverySurfaced: ctx.recordInputPayload("subagent_delivery_surfaced"),
      failed: ctx.recordInputPayload("subagent_failed"),
      knowledgeAdoptionRecorded: ctx.recordInputPayload("subagent.knowledge_adoption.recorded"),
      outcomeParseFailed: ctx.recordInputPayload("subagent_outcome_parse_failed"),
      running: ctx.recordInputPayload("subagent_running"),
      spawned: ctx.recordInputPayload("subagent_spawned"),
    },
    workerResults: {
      applied: ctx.recordInputPayload(DelegationEvents.WORKER_RESULTS_APPLIED_EVENT_TYPE),
      applyFailed: ctx.recordInputPayload(DelegationEvents.WORKER_RESULTS_APPLY_FAILED_EVENT_TYPE),
      rejected: ctx.recordInputPayload(DelegationEvents.WORKER_RESULTS_REJECTED_EVENT_TYPE),
    },
  };
}
