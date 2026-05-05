import type {
  Model,
  OpenAICompletionsCompat,
  ResolvedOpenAICompletionsCompat,
} from "../../contracts/index.js";

export function isDeepSeekRoute(model: Model<"openai-completions">): boolean {
  if (model.provider === "deepseek") {
    return true;
  }
  try {
    const url = new URL(model.baseUrl);
    return url.hostname === "api.deepseek.com" || url.hostname.endsWith(".deepseek.com");
  } catch {
    return model.baseUrl.includes("deepseek.com");
  }
}

function detectCompat(model: Model<"openai-completions">): ResolvedOpenAICompletionsCompat {
  const provider = model.provider;
  const baseUrl = model.baseUrl;
  const isDeepSeek = isDeepSeekRoute(model);

  const isNonStandard = baseUrl.includes("api.x.ai") || baseUrl.includes("chutes.ai") || isDeepSeek;
  const useMaxTokens = baseUrl.includes("chutes.ai") || isDeepSeek;
  const hasXaiReasoningLimits = baseUrl.includes("api.x.ai");
  const hasGroqEndpointQuirk = baseUrl.includes("groq.com");
  const isOpenRouter = provider === "openrouter" || baseUrl.includes("openrouter.ai");
  const isOpenRouterAnthropic = isOpenRouter && model.id.startsWith("anthropic/");

  const reasoningEffortMap = isDeepSeek
    ? {
        minimal: "high",
        low: "high",
        medium: "high",
        high: "high",
        xhigh: "max",
      }
    : hasGroqEndpointQuirk && model.id === "qwen/qwen3-32b"
      ? {
          minimal: "default",
          low: "default",
          medium: "default",
          high: "default",
          xhigh: "default",
        }
      : {};
  return {
    supportsStore: !isNonStandard,
    supportsDeveloperRole: !isNonStandard,
    supportsReasoningEffort: !hasXaiReasoningLimits,
    reasoningEffortMap,
    supportsUsageInStreaming: true,
    maxTokensField: useMaxTokens ? "max_tokens" : "max_completion_tokens",
    requiresToolResultName: false,
    requiresAssistantAfterToolResult: false,
    requiresThinkingAsText: false,
    thinkingFormat: isDeepSeek ? "deepseek" : isOpenRouter ? "openrouter" : "openai",
    openRouterRouting: {},
    supportsStrictMode: !isDeepSeek,
    cacheControlFormat: isOpenRouterAnthropic ? "anthropic" : "none",
    supportsPromptCacheKey: undefined,
    sendSessionAffinityHeaders: false,
    supportsLongCacheRetention: isOpenRouterAnthropic ? true : undefined,
  };
}

export function resolveOpenAICompletionsCompat(
  model: Model<"openai-completions">,
): ResolvedOpenAICompletionsCompat {
  const detected = detectCompat(model);
  if (!model.compat) return detected;

  return {
    supportsStore: model.compat.supportsStore ?? detected.supportsStore,
    supportsDeveloperRole: model.compat.supportsDeveloperRole ?? detected.supportsDeveloperRole,
    supportsReasoningEffort:
      model.compat.supportsReasoningEffort ?? detected.supportsReasoningEffort,
    reasoningEffortMap: model.compat.reasoningEffortMap ?? detected.reasoningEffortMap,
    supportsUsageInStreaming:
      model.compat.supportsUsageInStreaming ?? detected.supportsUsageInStreaming,
    maxTokensField: model.compat.maxTokensField ?? detected.maxTokensField,
    requiresToolResultName: model.compat.requiresToolResultName ?? detected.requiresToolResultName,
    requiresAssistantAfterToolResult:
      model.compat.requiresAssistantAfterToolResult ?? detected.requiresAssistantAfterToolResult,
    requiresThinkingAsText: model.compat.requiresThinkingAsText ?? detected.requiresThinkingAsText,
    thinkingFormat: model.compat.thinkingFormat ?? detected.thinkingFormat,
    openRouterRouting: model.compat.openRouterRouting ?? {},
    supportsStrictMode: model.compat.supportsStrictMode ?? detected.supportsStrictMode,
    cacheControlFormat: model.compat.cacheControlFormat ?? detected.cacheControlFormat,
    supportsPromptCacheKey: model.compat.supportsPromptCacheKey ?? detected.supportsPromptCacheKey,
    sendSessionAffinityHeaders:
      model.compat.sendSessionAffinityHeaders ?? detected.sendSessionAffinityHeaders,
    supportsLongCacheRetention:
      model.compat.supportsLongCacheRetention ?? detected.supportsLongCacheRetention,
  };
}
