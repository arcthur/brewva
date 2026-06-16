import { decideCompaction } from "@brewva/brewva-substrate/context-budget";
import type { BrewvaSessionModelDescriptor } from "@brewva/brewva-substrate/session";
import type { BrewvaCompactionRequest } from "@brewva/brewva-substrate/tools";
import {
  getRuntimeCompactionGateStatus,
  getRuntimeContextUsage,
  type HostedRuntimeAdapterPort,
} from "../session/runtime-ports.js";

export const MODEL_DOWNSHIFT_COMPACTION_INSTRUCTIONS =
  "Compact before switching to a model with a smaller context window. Preserve the current objective, latest user correction, failed attempt, and next step.";

export function shouldCompactForModelDownshift(input: {
  runtime: HostedRuntimeAdapterPort;
  sessionId: string;
  currentModel: BrewvaSessionModelDescriptor;
  targetModel: BrewvaSessionModelDescriptor;
}): boolean {
  const usage = getRuntimeContextUsage(input.runtime, input.sessionId);
  const usageKnown = typeof usage?.tokens === "number" && Number.isFinite(usage.tokens);
  const targetUsage = usageKnown
    ? {
        ...usage,
        contextWindow: input.targetModel.contextWindow,
        maxOutputTokens: input.targetModel.maxTokens,
      }
    : undefined;
  const gateStatus = getRuntimeCompactionGateStatus(input.runtime, input.sessionId, targetUsage);
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
