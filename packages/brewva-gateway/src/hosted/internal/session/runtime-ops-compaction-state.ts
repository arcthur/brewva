import type { HostedRuntimeOpsContext } from "./runtime-ops-context.js";
import type { RuntimeLineageRecordInput } from "./runtime-ops-port.js";

function readNonNegativeFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : null;
}

export function rememberCommittedCompactionContextState(
  ctx: HostedRuntimeOpsContext,
  sessionId: string,
  payload: RuntimeLineageRecordInput,
): void {
  ctx.state.pendingContextCompactionReasons.delete(sessionId);
  ctx.state.latestCompactionGateStatus.delete(sessionId);

  const previousUsage = ctx.state.latestContextUsage.get(sessionId);
  const toTokens = readNonNegativeFiniteNumber(payload.toTokens);
  if (toTokens !== null) {
    const contextWindow =
      readNonNegativeFiniteNumber(payload.contextWindow) ?? previousUsage?.contextWindow ?? 0;
    ctx.state.latestContextUsage.set(sessionId, {
      tokens: toTokens,
      contextWindow,
      percent: contextWindow > 0 ? (toTokens / contextWindow) * 100 : null,
      maxOutputTokens:
        readNonNegativeFiniteNumber(payload.maxOutputTokens) ??
        previousUsage?.maxOutputTokens ??
        null,
    });
    return;
  }

  if (previousUsage) {
    ctx.state.latestContextUsage.set(sessionId, {
      ...previousUsage,
      tokens: null,
      percent: null,
    });
  }
}
