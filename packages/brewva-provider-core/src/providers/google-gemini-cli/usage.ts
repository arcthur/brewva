import { calculateCost } from "../../catalog/index.js";
import type { AssistantMessage, Model } from "../../contracts/index.js";
import type { CloudCodeAssistResponseChunk } from "./contract.js";

export function applyGoogleGeminiCliUsage(
  output: AssistantMessage,
  model: Model<"google-gemini-cli">,
  usageMetadata: NonNullable<CloudCodeAssistResponseChunk["response"]>["usageMetadata"],
): void {
  const promptTokenCount = usageMetadata?.promptTokenCount || 0;
  const cachedContentTokenCount = usageMetadata?.cachedContentTokenCount || 0;
  output.usage = {
    input: Math.max(0, promptTokenCount - cachedContentTokenCount),
    output: (usageMetadata?.candidatesTokenCount || 0) + (usageMetadata?.thoughtsTokenCount || 0),
    cacheRead: cachedContentTokenCount,
    cacheWrite: 0,
    totalTokens: usageMetadata?.totalTokenCount || 0,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
  };
  calculateCost(model, output.usage);
}
