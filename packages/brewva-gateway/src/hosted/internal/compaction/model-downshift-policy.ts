import type { BrewvaHostedRuntimePort } from "@brewva/brewva-runtime";
import type { BrewvaSessionModelDescriptor } from "@brewva/brewva-substrate/session";
import type { BrewvaCompactionRequest } from "@brewva/brewva-substrate/tools";
import { decideCompaction } from "./policy.js";

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
  const usage = input.runtime.inspect.context.usage.get(input.sessionId);
  const usageKnown = typeof usage?.tokens === "number" && Number.isFinite(usage.tokens);
  const targetUsage = usageKnown
    ? {
        ...usage,
        contextWindow: input.targetModel.contextWindow,
        maxOutputTokens: input.targetModel.maxTokens,
      }
    : undefined;
  const gateStatus = input.runtime.inspect.context.compaction.getGateStatus(
    input.sessionId,
    targetUsage,
  );
  return (
    decideCompaction({
      caller: "model_downshift",
      gateStatus,
      currentContextWindow: input.currentModel.contextWindow,
      targetContextWindow: input.targetModel.contextWindow,
      usageKnown,
    }).decision === "execute"
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
