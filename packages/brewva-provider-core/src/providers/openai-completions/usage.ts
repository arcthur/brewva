import { calculateCost } from "../../catalog/index.js";
import type { AssistantMessage, Model } from "../../contracts/index.js";
import { isDeepSeekRoute } from "./compat.js";

function readUsageNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function normalizeOpenAICompletionsUsage(
  rawUsage: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    cached_tokens?: number;
    prompt_cache_hit_tokens?: number;
    prompt_cache_miss_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
    completion_tokens_details?: { reasoning_tokens?: number };
  },
  model: Model<"openai-completions">,
): AssistantMessage["usage"] {
  const promptTokens = readUsageNumber(rawUsage.prompt_tokens) ?? 0;
  const deepSeekCacheHitTokens = readUsageNumber(rawUsage.prompt_cache_hit_tokens);
  const deepSeekCacheMissTokens = readUsageNumber(rawUsage.prompt_cache_miss_tokens);
  const isDeepSeek = isDeepSeekRoute(model);
  const isDeepSeekUsage =
    isDeepSeek && (deepSeekCacheHitTokens !== undefined || deepSeekCacheMissTokens !== undefined);
  if (isDeepSeekUsage) {
    const cacheReadTokens = deepSeekCacheHitTokens ?? 0;
    const input = deepSeekCacheMissTokens ?? Math.max(0, promptTokens - cacheReadTokens);
    const outputTokens = readUsageNumber(rawUsage.completion_tokens) ?? 0;
    const usage: AssistantMessage["usage"] = {
      input,
      output: outputTokens,
      cacheRead: cacheReadTokens,
      cacheWrite: 0,
      totalTokens: input + outputTokens + cacheReadTokens,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
    calculateCost(model, usage);
    return usage;
  }

  const reportedCachedTokens =
    readUsageNumber(rawUsage.prompt_tokens_details?.cached_tokens) ??
    readUsageNumber(rawUsage.cached_tokens) ??
    0;
  const cacheWriteTokens = isDeepSeek
    ? 0
    : (readUsageNumber(rawUsage.prompt_tokens_details?.cache_write_tokens) ?? 0);
  const reasoningTokens = isDeepSeek
    ? 0
    : (readUsageNumber(rawUsage.completion_tokens_details?.reasoning_tokens) ?? 0);

  const cacheReadTokens =
    cacheWriteTokens > 0
      ? Math.max(0, reportedCachedTokens - cacheWriteTokens)
      : reportedCachedTokens;

  const input = Math.max(0, promptTokens - cacheReadTokens - cacheWriteTokens);
  const outputTokens = (readUsageNumber(rawUsage.completion_tokens) ?? 0) + reasoningTokens;
  const usage: AssistantMessage["usage"] = {
    input,
    output: outputTokens,
    cacheRead: cacheReadTokens,
    cacheWrite: cacheWriteTokens,
    totalTokens: input + outputTokens + cacheReadTokens + cacheWriteTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  calculateCost(model, usage);
  return usage;
}
