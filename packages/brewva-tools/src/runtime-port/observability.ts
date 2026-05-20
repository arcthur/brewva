import { VERIFICATION_OUTCOME_RECORDED_EVENT_TYPE } from "@brewva/brewva-runtime/protocol";
import type { BrewvaToolRuntime } from "../contracts/index.js";

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
  const verificationEvent = runtime.capabilities.events.records.list(sessionId, {
    type: VERIFICATION_OUTCOME_RECORDED_EVENT_TYPE,
    last: 1,
  })[0];

  return {
    tape,
    usage,
    promptStability,
    transientReduction,
    contextStatus,
    cost,
    task,
    verificationEvent,
  };
}
