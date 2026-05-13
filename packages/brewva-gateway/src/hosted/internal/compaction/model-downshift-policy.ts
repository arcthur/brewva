import type { BrewvaHostedRuntimePort } from "@brewva/brewva-runtime";
import type { BrewvaSessionModelDescriptor } from "@brewva/brewva-substrate/session";
import type { BrewvaCompactionRequest } from "@brewva/brewva-substrate/tools";

export const MODEL_DOWNSHIFT_COMPACTION_INSTRUCTIONS =
  "Compact before switching to a model with a smaller context window. Preserve the current objective, latest user correction, failed attempt, and next step.";

export const FALLBACK_MODEL_DOWNSHIFT_COMPACTION_INSTRUCTIONS =
  "Compact before switching to a fallback model with a smaller context window. Preserve the current objective, latest user correction, failed attempt, and next step.";

export function shouldCompactForModelDownshift(input: {
  runtime: BrewvaHostedRuntimePort;
  sessionId: string;
  currentModel: BrewvaSessionModelDescriptor;
  targetModel: BrewvaSessionModelDescriptor;
}): boolean {
  if (
    input.currentModel.contextWindow <= 0 ||
    input.targetModel.contextWindow <= 0 ||
    input.targetModel.contextWindow >= input.currentModel.contextWindow
  ) {
    return false;
  }

  const usage = input.runtime.inspect.context.usage.get(input.sessionId);
  if (typeof usage?.tokens !== "number" || !Number.isFinite(usage.tokens)) {
    return false;
  }

  const targetUsage = {
    ...usage,
    contextWindow: input.targetModel.contextWindow,
    maxOutputTokens: input.targetModel.maxTokens,
  };
  const gateStatus = input.runtime.inspect.context.compaction.getGateStatus(
    input.sessionId,
    targetUsage,
  );
  if (gateStatus.recentCompaction) {
    return false;
  }
  const targetStatus = gateStatus.status;
  return (
    targetStatus.forcedCompaction ||
    targetStatus.compactionAdvised ||
    targetStatus.predictedOverflow
  );
}

export async function requestCompactionAndWait(
  requestCompaction: (request?: BrewvaCompactionRequest) => void,
  request?: Omit<BrewvaCompactionRequest, "onComplete" | "onError">,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    try {
      requestCompaction({
        ...request,
        onComplete: (event) => resolve(event),
        onError: (error) => reject(error),
      });
    } catch (error) {
      reject(error);
    }
  });
}
