import { calculateCost } from "../../../catalog/index.js";
import type { AssistantMessage, Model } from "../../../contracts/index.js";

export interface GoogleUsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  thoughtsTokenCount?: number;
  toolUsePromptTokenCount?: number;
  totalTokenCount?: number;
  cachedContentTokenCount?: number;
}

export function applyGoogleUsage<TApi extends "google-genai">(
  output: AssistantMessage,
  model: Model<TApi>,
  usageMetadata: GoogleUsageMetadata | undefined,
): void {
  const promptTokenCount = usageMetadata?.promptTokenCount || 0;
  const cachedContentTokenCount = usageMetadata?.cachedContentTokenCount || 0;
  output.usage = {
    input: Math.max(0, promptTokenCount - cachedContentTokenCount),
    output: (usageMetadata?.candidatesTokenCount || 0) + (usageMetadata?.thoughtsTokenCount || 0),
    cacheRead: cachedContentTokenCount,
    cacheWrite: output.usage.cacheWrite,
    totalTokens: usageMetadata?.totalTokenCount || output.usage.totalTokens,
    cost: output.usage.cost,
  };
  calculateCost(model, output.usage);
}
