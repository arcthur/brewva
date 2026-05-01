import {
  readDelegationLifecycleEventPayload,
  readWorkerResultsAppliedEventPayload,
} from "../../events/descriptors.js";
import {
  SUBAGENT_CANCELLED_EVENT_TYPE,
  SUBAGENT_COMPLETED_EVENT_TYPE,
  SUBAGENT_FAILED_EVENT_TYPE,
  SUBAGENT_RUNNING_EVENT_TYPE,
  SUBAGENT_SPAWNED_EVENT_TYPE,
  WORKER_RESULTS_APPLIED_EVENT_TYPE,
} from "../../events/registry.js";
import type { BrewvaEventRecord } from "../../events/types.js";
import type { DelegationRunStatus } from "../delegation/api.js";
import { isDelegationRunTerminalStatus } from "../delegation/api.js";

export interface DerivedParallelBudgetState {
  activeRunIds: string[];
  totalStarted: number;
  latestEventId?: string;
}

export function deriveParallelBudgetStateFromEvents(
  events: readonly BrewvaEventRecord[],
): DerivedParallelBudgetState {
  const started = new Set<string>();
  const active = new Set<string>();

  for (const event of events) {
    if (event.type === WORKER_RESULTS_APPLIED_EVENT_TYPE) {
      const payload = readWorkerResultsAppliedEventPayload(event);
      for (const workerId of payload?.workerIds ?? []) {
        active.delete(workerId);
      }
      continue;
    }

    if (
      event.type !== SUBAGENT_SPAWNED_EVENT_TYPE &&
      event.type !== SUBAGENT_RUNNING_EVENT_TYPE &&
      event.type !== SUBAGENT_COMPLETED_EVENT_TYPE &&
      event.type !== SUBAGENT_FAILED_EVENT_TYPE &&
      event.type !== SUBAGENT_CANCELLED_EVENT_TYPE
    ) {
      continue;
    }

    const payload = readDelegationLifecycleEventPayload(event);
    const runId = payload?.runId;
    if (!runId) {
      continue;
    }

    started.add(runId);
    if (event.type === SUBAGENT_RUNNING_EVENT_TYPE) {
      active.add(runId);
      continue;
    }

    if (event.type === SUBAGENT_SPAWNED_EVENT_TYPE) {
      const status: DelegationRunStatus = payload.status ?? "pending";
      if (!isDelegationRunTerminalStatus(status)) {
        active.add(runId);
      } else {
        active.delete(runId);
      }
      continue;
    }

    active.delete(runId);
  }

  return {
    activeRunIds: [...active],
    totalStarted: started.size,
    latestEventId: events[events.length - 1]?.id,
  };
}
