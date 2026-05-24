import type { BrewvaToolRuntime } from "../contracts/index.js";

export function mergeWorkerResults(
  runtime: BrewvaToolRuntime,
  sessionId: string,
): ReturnType<BrewvaToolRuntime["capabilities"]["session"]["workerResults"]["merge"]> {
  return runtime.capabilities.session.workerResults.merge(sessionId);
}

export function listWorkerResults(
  runtime: BrewvaToolRuntime,
  sessionId: string,
): ReturnType<BrewvaToolRuntime["capabilities"]["session"]["workerResults"]["list"]> {
  return runtime.capabilities.session.workerResults.list(sessionId);
}
