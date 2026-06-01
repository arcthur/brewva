import type { ContextBudgetUsage } from "@brewva/brewva-vocabulary/context";
import type { BrewvaToolRuntime } from "../contracts/index.js";

export function recordTapeContinuationAnchor(
  runtime: BrewvaToolRuntime,
  sessionId: string,
  input: Parameters<BrewvaToolRuntime["capabilities"]["tape"]["handoff"]["record"]>[1],
): ReturnType<BrewvaToolRuntime["capabilities"]["tape"]["handoff"]["record"]> {
  return runtime.capabilities.tape.handoff.record(sessionId, input);
}

export function getTapeStatus(
  runtime: BrewvaToolRuntime,
  sessionId: string,
): ReturnType<BrewvaToolRuntime["capabilities"]["tape"]["status"]["get"]> {
  return runtime.capabilities.tape.status.get(sessionId);
}

export function getContextUsage(
  runtime: BrewvaToolRuntime,
  sessionId: string,
): ReturnType<BrewvaToolRuntime["capabilities"]["context"]["usage"]["get"]> {
  return runtime.capabilities.context.usage.get(sessionId);
}

export function getContextStatus(
  runtime: BrewvaToolRuntime,
  sessionId: string,
  usage: ContextBudgetUsage | undefined,
): ReturnType<BrewvaToolRuntime["capabilities"]["context"]["usage"]["getStatus"]> {
  return runtime.capabilities.context.usage.getStatus(sessionId, usage);
}

export function getActiveReasoningState(
  runtime: BrewvaToolRuntime,
  sessionId: string,
): ReturnType<BrewvaToolRuntime["capabilities"]["reasoning"]["state"]["getActive"]> {
  return runtime.capabilities.reasoning.state.getActive(sessionId);
}

export function searchTape(
  runtime: BrewvaToolRuntime,
  sessionId: string,
  input: Parameters<BrewvaToolRuntime["capabilities"]["tape"]["search"]["search"]>[1],
): ReturnType<BrewvaToolRuntime["capabilities"]["tape"]["search"]["search"]> {
  return runtime.capabilities.tape.search.search(sessionId, input);
}
