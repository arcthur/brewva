import {
  SUBAGENT_CANCELLED_EVENT_TYPE,
  SUBAGENT_COMPLETED_EVENT_TYPE,
  SUBAGENT_DELIVERY_SURFACED_EVENT_TYPE,
  SUBAGENT_FAILED_EVENT_TYPE,
  SUBAGENT_KNOWLEDGE_ADOPTION_RECORDED_EVENT_TYPE,
  SUBAGENT_OUTCOME_PARSE_FAILED_EVENT_TYPE,
  SUBAGENT_RUNNING_EVENT_TYPE,
  SUBAGENT_SPAWNED_EVENT_TYPE,
  WORKER_RESULTS_APPLIED_EVENT_TYPE,
  WORKER_RESULTS_APPLY_FAILED_EVENT_TYPE,
} from "@brewva/brewva-runtime/protocol";
import type { HostedRuntimeAdapterPort } from "../hosted/api.js";

export type DelegationRuntimeEventType =
  | typeof SUBAGENT_CANCELLED_EVENT_TYPE
  | typeof SUBAGENT_COMPLETED_EVENT_TYPE
  | typeof SUBAGENT_DELIVERY_SURFACED_EVENT_TYPE
  | typeof SUBAGENT_FAILED_EVENT_TYPE
  | typeof SUBAGENT_KNOWLEDGE_ADOPTION_RECORDED_EVENT_TYPE
  | typeof SUBAGENT_OUTCOME_PARSE_FAILED_EVENT_TYPE
  | typeof SUBAGENT_RUNNING_EVENT_TYPE
  | typeof SUBAGENT_SPAWNED_EVENT_TYPE
  | typeof WORKER_RESULTS_APPLIED_EVENT_TYPE
  | typeof WORKER_RESULTS_APPLY_FAILED_EVENT_TYPE;

export function recordDelegationRuntimeEvent(input: {
  runtime: Pick<HostedRuntimeAdapterPort, "ops">;
  sessionId: string;
  type: DelegationRuntimeEventType;
  payload: object;
  turn?: number;
}): void {
  const event = {
    sessionId: input.sessionId,
    payload: input.payload,
    ...(typeof input.turn === "number" ? { turn: input.turn } : {}),
  };
  switch (input.type) {
    case SUBAGENT_CANCELLED_EVENT_TYPE:
      input.runtime.ops.delegation.lifecycle.cancelled(event);
      return;
    case SUBAGENT_COMPLETED_EVENT_TYPE:
      input.runtime.ops.delegation.lifecycle.completed(event);
      return;
    case SUBAGENT_DELIVERY_SURFACED_EVENT_TYPE:
      input.runtime.ops.delegation.lifecycle.deliverySurfaced(event);
      return;
    case SUBAGENT_FAILED_EVENT_TYPE:
      input.runtime.ops.delegation.lifecycle.failed(event);
      return;
    case SUBAGENT_KNOWLEDGE_ADOPTION_RECORDED_EVENT_TYPE:
      input.runtime.ops.delegation.lifecycle.knowledgeAdoptionRecorded(event);
      return;
    case SUBAGENT_OUTCOME_PARSE_FAILED_EVENT_TYPE:
      input.runtime.ops.delegation.lifecycle.outcomeParseFailed(event);
      return;
    case SUBAGENT_RUNNING_EVENT_TYPE:
      input.runtime.ops.delegation.lifecycle.running(event);
      return;
    case SUBAGENT_SPAWNED_EVENT_TYPE:
      input.runtime.ops.delegation.lifecycle.spawned(event);
      return;
    case WORKER_RESULTS_APPLIED_EVENT_TYPE:
      input.runtime.ops.delegation.workerResults.applied(event);
      return;
    case WORKER_RESULTS_APPLY_FAILED_EVENT_TYPE:
      input.runtime.ops.delegation.workerResults.applyFailed(event);
      return;
  }
}
