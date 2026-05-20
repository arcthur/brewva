import type { BrewvaToolRuntime } from "../contracts/index.js";

export function requestResourceLease(
  runtime: BrewvaToolRuntime,
  sessionId: string,
  input: Parameters<BrewvaToolRuntime["capabilities"]["tools"]["resourceLeases"]["request"]>[1],
): ReturnType<BrewvaToolRuntime["capabilities"]["tools"]["resourceLeases"]["request"]> {
  return runtime.capabilities.tools.resourceLeases.request(sessionId, input);
}

export function listResourceLeases(
  runtime: BrewvaToolRuntime,
  sessionId: string,
  query?: Parameters<BrewvaToolRuntime["capabilities"]["tools"]["resourceLeases"]["list"]>[1],
): ReturnType<BrewvaToolRuntime["capabilities"]["tools"]["resourceLeases"]["list"]> {
  return runtime.capabilities.tools.resourceLeases.list(sessionId, query);
}

export function cancelResourceLease(
  runtime: BrewvaToolRuntime,
  sessionId: string,
  leaseId: string,
  reason?: string,
): ReturnType<BrewvaToolRuntime["capabilities"]["tools"]["resourceLeases"]["cancel"]> {
  return runtime.capabilities.tools.resourceLeases.cancel(sessionId, leaseId, reason);
}
