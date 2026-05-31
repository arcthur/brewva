import type { BrewvaToolResult } from "@brewva/brewva-substrate/tools";

export function toolOutcomePayload(result: Pick<BrewvaToolResult, "outcome">): unknown {
  if (result.outcome.kind === "err") {
    return result.outcome.error;
  }
  return result.outcome.value ?? {};
}
