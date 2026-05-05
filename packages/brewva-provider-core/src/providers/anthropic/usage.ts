import { calculateCost } from "../../catalog/index.js";
import type { AssistantMessage, Model } from "../../contracts/index.js";

export function applyAnthropicUsageTotals(
  output: AssistantMessage,
  model: Model<"anthropic-messages">,
): void {
  output.usage.totalTokens =
    output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
  calculateCost(model, output.usage);
}
