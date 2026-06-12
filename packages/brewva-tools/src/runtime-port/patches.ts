import type { BrewvaToolRuntime } from "../contracts/index.js";

export function rollbackLastPatchSet(
  runtime: BrewvaToolRuntime,
  sessionId: string,
): ReturnType<BrewvaToolRuntime["capabilities"]["tools"]["patches"]["rollbackLastPatchSet"]> {
  return runtime.capabilities.tools.patches.rollbackLastPatchSet(sessionId);
}

export function rollbackCandidate(
  runtime: BrewvaToolRuntime,
  sessionId: string,
): ReturnType<BrewvaToolRuntime["capabilities"]["tools"]["patches"]["rollbackCandidate"]> {
  return runtime.capabilities.tools.patches.rollbackCandidate(sessionId);
}
