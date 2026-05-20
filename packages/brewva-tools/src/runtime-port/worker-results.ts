import type { BrewvaToolRuntime } from "../contracts/index.js";

export function mergeWorkerResults(
  runtime: BrewvaToolRuntime,
  sessionId: string,
): ReturnType<BrewvaToolRuntime["capabilities"]["session"]["workerResults"]["merge"]> {
  return runtime.capabilities.session.workerResults.merge(sessionId);
}

export function applyMergedWorkerResults(
  runtime: BrewvaToolRuntime,
  sessionId: string,
  input: unknown,
): ReturnType<BrewvaToolRuntime["capabilities"]["session"]["workerResults"]["applyMerged"]> {
  return runtime.capabilities.session.workerResults.applyMerged(sessionId, input);
}

export function listWorkerResults(
  runtime: BrewvaToolRuntime,
  sessionId: string,
): ReturnType<BrewvaToolRuntime["capabilities"]["session"]["workerResults"]["list"]> {
  return runtime.capabilities.session.workerResults.list(sessionId);
}
