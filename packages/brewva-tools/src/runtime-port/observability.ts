import { VERIFICATION_OUTCOME_RECORDED_EVENT_TYPE } from "@brewva/brewva-vocabulary/iteration";
import type { BrewvaToolRuntime } from "../contracts/index.js";
import {
  BOX_EXEC_FAILED_EVENT_TYPE,
  EXEC_FAILED_EVENT_TYPE,
  projectRecentExecFailures,
} from "./verification-diagnostics.js";

const RECENT_EXEC_FAILURE_SCAN_LIMIT = 100;

export function readObservabilitySnapshotState(runtime: BrewvaToolRuntime, sessionId: string) {
  const tape = runtime.capabilities.tape.status.get(sessionId);
  const usage = runtime.capabilities.context.usage.get(sessionId);
  const promptStability = runtime.capabilities.context.evidence.latest(
    sessionId,
    "prompt_stability",
  )?.payload;
  const transientReduction = runtime.capabilities.context.evidence.latest(
    sessionId,
    "transient_reduction",
  )?.payload;
  const contextStatus = runtime.capabilities.context.usage.getStatus(sessionId, usage);
  const cost = runtime.capabilities.cost.summary.get(sessionId);
  const task = runtime.capabilities.task.state.get(sessionId);
  // Canonical current verification state.
  const verificationEvent = runtime.capabilities.events.records.list(sessionId, {
    type: VERIFICATION_OUTCOME_RECORDED_EVENT_TYPE,
    last: 1,
  })[0];
  // Recent exec/box-exec failure detail behind that state, projected
  // deterministically from committed receipts so the model can orient on the
  // exec layer without scraping scattered events.
  const recentExecFailures = projectRecentExecFailures({
    hostFailures: runtime.capabilities.events.records.list(sessionId, {
      type: EXEC_FAILED_EVENT_TYPE,
      last: RECENT_EXEC_FAILURE_SCAN_LIMIT,
    }),
    boxFailures: runtime.capabilities.events.records.list(sessionId, {
      type: BOX_EXEC_FAILED_EVENT_TYPE,
      last: RECENT_EXEC_FAILURE_SCAN_LIMIT,
    }),
    scanLimitPerSandbox: RECENT_EXEC_FAILURE_SCAN_LIMIT,
  });

  return {
    tape,
    usage,
    promptStability,
    transientReduction,
    contextStatus,
    cost,
    task,
    verificationEvent,
    recentExecFailures,
  };
}
