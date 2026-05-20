import type { BrewvaToolRuntime } from "../contracts/index.js";

export function queryLedger(
  runtime: BrewvaToolRuntime,
  sessionId: string,
  query: unknown,
): ReturnType<BrewvaToolRuntime["capabilities"]["ledger"]["store"]["query"]> {
  return runtime.capabilities.ledger.store.query(sessionId, query);
}
