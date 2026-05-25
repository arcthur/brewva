import type {
  ReasoningRevertInput,
  RecordReasoningCheckpointInput,
} from "@brewva/brewva-vocabulary/iteration";
import type { BrewvaToolRuntime } from "../contracts/index.js";

export function recordReasoningCheckpoint(
  runtime: BrewvaToolRuntime,
  sessionId: string,
  input: RecordReasoningCheckpointInput,
): ReturnType<BrewvaToolRuntime["capabilities"]["reasoning"]["checkpoints"]["record"]> | undefined {
  return runtime.capabilities.reasoning?.checkpoints?.record(sessionId, input);
}

export function revertReasoning(
  runtime: BrewvaToolRuntime,
  sessionId: string,
  input: ReasoningRevertInput,
): ReturnType<BrewvaToolRuntime["capabilities"]["reasoning"]["reverts"]["revert"]> | undefined {
  return runtime.capabilities.reasoning?.reverts?.revert(sessionId, input);
}
