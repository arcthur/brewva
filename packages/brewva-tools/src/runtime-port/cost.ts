import type { BrewvaToolRuntime } from "../contracts/index.js";

export function getSessionCostSummary(
  runtime: BrewvaToolRuntime,
  sessionId: string,
): ReturnType<BrewvaToolRuntime["capabilities"]["cost"]["summary"]["get"]> {
  return runtime.capabilities.cost.summary.get(sessionId);
}
