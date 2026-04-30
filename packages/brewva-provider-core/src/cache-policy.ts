import type {
  Api,
  ProviderCacheCapability,
  ProviderCachePolicy,
  ProviderCacheRenderResult,
  ProviderCacheRetention,
  ProviderCacheWriteMode,
  Transport,
} from "./types.js";

export const DEFAULT_PROVIDER_CACHE_POLICY: ProviderCachePolicy = {
  retention: "short",
  writeMode: "readWrite",
  scope: "session",
  reason: "default",
};

export interface ProviderCacheBucketInput {
  provider: string;
  api: Api;
  model: string;
  sessionId?: string;
  policy?: ProviderCachePolicy;
}

export interface ProviderCacheCapabilityInput {
  api: Api;
  provider?: string;
  modelId?: string;
  baseUrl?: string;
  transport?: Transport;
  forceCache?: boolean;
}

export interface OpenAIResponsesCacheRender extends ProviderCacheRenderResult {
  promptCacheKey?: string;
  promptCacheRetention?: "24h";
}

export interface AnthropicCacheRender extends ProviderCacheRenderResult {
  cacheControl?: { type: "ephemeral"; ttl?: "1h" };
}

export interface GoogleGeminiCliCacheRender extends ProviderCacheRenderResult {
  cachedContentName?: string;
  cachedContentTtlSeconds?: number;
}

export interface OpenAICompletionsCacheRender extends ProviderCacheRenderResult {}

const KIMI_CODE_CACHE_REASON = "kimi_code_cache_contract_not_verified";
const DEEPSEEK_CACHE_REASON = "deepseek_context_disk_cache";

export function normalizeProviderCachePolicy(
  policy: ProviderCachePolicy | undefined,
): ProviderCachePolicy {
  if (!policy) {
    return { ...DEFAULT_PROVIDER_CACHE_POLICY };
  }
  return {
    retention: policy.retention,
    writeMode: policy.writeMode,
    scope: policy.scope,
    reason: policy.reason,
  };
}

export function buildProviderCacheBucketKey(input: ProviderCacheBucketInput): string {
  const policy = normalizeProviderCachePolicy(input.policy);
  return [
    `provider=${input.provider}`,
    `api=${input.api}`,
    `model=${input.model}`,
    `scope=${policy.scope}`,
    `retention=${policy.retention}`,
    `writeMode=${policy.writeMode}`,
    `session=${input.sessionId ?? "none"}`,
  ].join("|");
}

export function buildRenderBucketKey(input: {
  api: string;
  sessionId?: string;
  retention: ProviderCacheRetention;
  writeMode: ProviderCacheWriteMode;
}): string {
  return [
    input.api,
    `session=${input.sessionId ?? "none"}`,
    `retention=${input.retention}`,
    `writeMode=${input.writeMode}`,
  ].join("|");
}

function disabledRender(input: {
  api: string;
  sessionId?: string;
  writeMode: ProviderCacheWriteMode;
  capability?: ProviderCacheCapability;
}): ProviderCacheRenderResult {
  return {
    status: "disabled",
    reason: "cache_policy_disabled",
    renderedRetention: "none",
    bucketKey: buildRenderBucketKey({
      api: input.api,
      sessionId: input.sessionId,
      retention: "none",
      writeMode: input.writeMode,
    }),
    capability: input.capability,
  };
}

function missingSessionRender(input: {
  api: string;
  writeMode: ProviderCacheWriteMode;
  capability?: ProviderCacheCapability;
}): ProviderCacheRenderResult {
  return {
    status: "unsupported",
    reason: "session_id_required_for_session_cache",
    renderedRetention: "none",
    bucketKey: buildRenderBucketKey({
      api: input.api,
      sessionId: undefined,
      retention: "none",
      writeMode: input.writeMode,
    }),
    capability: input.capability,
  };
}

function unsupportedReadOnlyRender(input: {
  api: string;
  sessionId?: string;
  capability?: ProviderCacheCapability;
}): ProviderCacheRenderResult {
  return {
    status: "unsupported",
    reason: "cache_write_mode_read_only_not_supported",
    renderedRetention: "none",
    bucketKey: buildRenderBucketKey({
      api: input.api,
      sessionId: input.sessionId,
      retention: "none",
      writeMode: "readOnly",
    }),
    capability: input.capability,
  };
}

function unsupportedCapabilityRender(input: {
  api: string;
  sessionId?: string;
  writeMode: ProviderCacheWriteMode;
  capability: ProviderCacheCapability;
}): ProviderCacheRenderResult {
  return {
    status: "unsupported",
    reason: input.capability.reason,
    renderedRetention: "none",
    bucketKey: buildRenderBucketKey({
      api: input.api,
      sessionId: input.sessionId,
      retention: "none",
      writeMode: input.writeMode,
    }),
    capability: input.capability,
  };
}

export function resolveProviderCacheCapability(
  input: ProviderCacheCapabilityInput,
): ProviderCacheCapability {
  const api = input.api.toLowerCase();
  const provider = (input.provider ?? "").toLowerCase();
  const modelId = (input.modelId ?? "").toLowerCase();
  const baseUrl = (input.baseUrl ?? "").toLowerCase();
  const transport = input.transport ?? "auto";

  if (isKimiCodeCacheRoute({ provider, baseUrl })) {
    return {
      strategies: ["unsupported"],
      cacheCounters: "none",
      shortRetention: false,
      longRetention: "none",
      readOnlyWriteMode: "unsupported",
      reason: KIMI_CODE_CACHE_REASON,
    };
  }

  if (api === "openai-completions" && isDeepSeekRoute({ provider, baseUrl })) {
    return {
      strategies: ["implicitPrefix"],
      cacheCounters: "readOnly",
      shortRetention: true,
      longRetention: "none",
      readOnlyWriteMode: "unsupported",
      reason: DEEPSEEK_CACHE_REASON,
    };
  }

  if (api === "anthropic-messages") {
    return {
      strategies: ["explicitCacheMarker"],
      cacheCounters: "readWrite",
      shortRetention: true,
      longRetention: baseUrl.includes("api.anthropic.com") ? "1h" : "none",
      readOnlyWriteMode: "unsupported",
      reason: "anthropic_cache_control",
    };
  }

  if (api === "openai-codex-responses") {
    return {
      strategies: ["promptCacheKey"],
      cacheCounters: "readOnly",
      shortRetention: true,
      longRetention: "none",
      readOnlyWriteMode: "unsupported",
      continuation:
        transport === "sse"
          ? undefined
          : {
              family: "openai-responses",
              modes: ["websocketConnection", "previousResponseId"],
              authority: "efficiency",
              reason: "openai_codex_websocket_previous_response_id_affinity",
            },
      reason: "openai_codex_responses_prompt_cache_key",
    };
  }

  if (api === "openai-responses") {
    const directOpenAI = baseUrl.includes("api.openai.com");
    const providerIsOpenAI = provider === "" || provider === "openai";
    if (directOpenAI && providerIsOpenAI && modelSupportsOpenAIPromptCacheKey(modelId)) {
      return {
        strategies: ["promptCacheKey"],
        cacheCounters: "readOnly",
        shortRetention: true,
        longRetention: "24h",
        readOnlyWriteMode: "unsupported",
        reason: "openai_responses_prompt_cache_key",
      };
    }
    return {
      strategies: ["implicitPrefix"],
      cacheCounters: "none",
      shortRetention: false,
      longRetention: "none",
      readOnlyWriteMode: "unsupported",
      reason: "provider_model_does_not_advertise_prompt_cache_key",
    };
  }

  if (api === "google-gemini-cli") {
    return {
      strategies: ["implicitPrefix", "explicitCachedContent"],
      cacheCounters: "readOnly",
      shortRetention: true,
      longRetention: "1h",
      readOnlyWriteMode: "supported",
      reason: "google_gemini_context_caching",
    };
  }

  if (api === "openai-completions") {
    return {
      strategies: ["implicitPrefix"],
      cacheCounters: "readOnly",
      shortRetention: true,
      longRetention: "none",
      readOnlyWriteMode: "unsupported",
      reason: "openai_compatible_implicit_prefix_cache",
    };
  }

  return {
    strategies: ["implicitPrefix"],
    cacheCounters: "none",
    shortRetention: false,
    longRetention: "none",
    readOnlyWriteMode: "unsupported",
    reason: "provider_cache_capability_unknown",
  };
}

function isKimiCodeCacheRoute(input: { provider: string; baseUrl: string }): boolean {
  if (input.provider === "kimi-coding") {
    return true;
  }
  try {
    const url = new URL(input.baseUrl);
    return url.hostname === "api.kimi.com" && url.pathname.startsWith("/coding");
  } catch {
    return input.baseUrl.includes("api.kimi.com/coding");
  }
}

function isDeepSeekRoute(input: { provider: string; baseUrl: string }): boolean {
  if (input.provider === "deepseek") {
    return true;
  }
  try {
    const url = new URL(input.baseUrl);
    return url.hostname === "api.deepseek.com" || url.hostname.endsWith(".deepseek.com");
  } catch {
    return input.baseUrl.includes("deepseek.com");
  }
}

function modelSupportsOpenAIPromptCacheKey(modelId: string): boolean {
  if (!modelId) {
    return false;
  }
  return (
    modelId.startsWith("gpt-") ||
    modelId.startsWith("o1") ||
    modelId.startsWith("o3") ||
    modelId.startsWith("o4") ||
    modelId.startsWith("chatgpt-")
  );
}

export function resolveOpenAIResponsesCacheRender(input: {
  api?: Api;
  baseUrl: string;
  provider?: string;
  modelId?: string;
  transport?: Transport;
  sessionId?: string;
  policy?: ProviderCachePolicy;
}): OpenAIResponsesCacheRender {
  const policy = normalizeProviderCachePolicy(input.policy);
  const api = input.api ?? "openai-responses";
  const capability = resolveProviderCacheCapability({
    api,
    provider: input.provider,
    modelId: input.modelId,
    baseUrl: input.baseUrl,
    transport: input.transport,
  });
  if (policy.retention === "none") {
    return disabledRender({
      api,
      sessionId: input.sessionId,
      writeMode: policy.writeMode,
      capability,
    }) as OpenAIResponsesCacheRender;
  }
  if (policy.writeMode === "readOnly") {
    return unsupportedReadOnlyRender({
      api,
      sessionId: input.sessionId,
      capability,
    }) as OpenAIResponsesCacheRender;
  }
  if (!capability.strategies.includes("promptCacheKey")) {
    return unsupportedCapabilityRender({
      api,
      sessionId: input.sessionId,
      writeMode: policy.writeMode,
      capability,
    }) as OpenAIResponsesCacheRender;
  }
  if (!input.sessionId) {
    return missingSessionRender({
      api,
      writeMode: policy.writeMode,
      capability,
    }) as OpenAIResponsesCacheRender;
  }

  const renderedRetention =
    policy.retention === "long" && capability.longRetention !== "24h" ? "short" : policy.retention;
  return {
    status: policy.retention === renderedRetention ? "rendered" : "degraded",
    reason:
      policy.retention === renderedRetention
        ? "rendered_openai_prompt_cache"
        : "long_retention_not_supported_for_provider_model",
    renderedRetention,
    bucketKey: buildRenderBucketKey({
      api,
      sessionId: input.sessionId,
      retention: renderedRetention,
      writeMode: policy.writeMode,
    }),
    capability,
    promptCacheKey: input.sessionId,
    promptCacheRetention: renderedRetention === "long" ? "24h" : undefined,
  };
}

export function resolveOpenAICompletionsCacheRender(input: {
  api?: Api;
  baseUrl: string;
  provider?: string;
  modelId?: string;
  transport?: Transport;
  sessionId?: string;
  policy?: ProviderCachePolicy;
}): OpenAICompletionsCacheRender {
  const policy = normalizeProviderCachePolicy(input.policy);
  const api = input.api ?? "openai-completions";
  const capability = resolveProviderCacheCapability({
    api,
    provider: input.provider,
    modelId: input.modelId,
    baseUrl: input.baseUrl,
    transport: input.transport,
  });
  if (policy.retention === "none") {
    return disabledRender({
      api,
      sessionId: input.sessionId,
      writeMode: policy.writeMode,
      capability,
    }) as OpenAICompletionsCacheRender;
  }
  if (policy.writeMode === "readOnly") {
    return unsupportedReadOnlyRender({
      api,
      sessionId: input.sessionId,
      capability,
    }) as OpenAICompletionsCacheRender;
  }
  if (!capability.strategies.includes("implicitPrefix")) {
    return unsupportedCapabilityRender({
      api,
      sessionId: input.sessionId,
      writeMode: policy.writeMode,
      capability,
    }) as OpenAICompletionsCacheRender;
  }

  const renderedRetention =
    policy.retention === "long" && capability.longRetention === "none" ? "short" : policy.retention;
  return {
    status: policy.retention === renderedRetention ? "rendered" : "degraded",
    reason:
      policy.retention === renderedRetention
        ? "rendered_openai_completions_implicit_prefix_cache"
        : "long_retention_not_supported_for_provider_model",
    renderedRetention,
    bucketKey: buildRenderBucketKey({
      api,
      sessionId: input.sessionId,
      retention: renderedRetention,
      writeMode: policy.writeMode,
    }),
    capability,
  };
}

export function resolveAnthropicCacheRender(input: {
  baseUrl: string;
  provider?: string;
  modelId?: string;
  sessionId?: string;
  policy?: ProviderCachePolicy;
}): AnthropicCacheRender {
  const policy = normalizeProviderCachePolicy(input.policy);
  const capability = resolveProviderCacheCapability({
    api: "anthropic-messages",
    provider: input.provider ?? "anthropic",
    modelId: input.modelId,
    baseUrl: input.baseUrl,
  });
  if (policy.retention === "none") {
    return disabledRender({
      api: "anthropic-messages",
      sessionId: input.sessionId,
      writeMode: policy.writeMode,
      capability,
    }) as AnthropicCacheRender;
  }
  if (policy.writeMode === "readOnly") {
    return unsupportedReadOnlyRender({
      api: "anthropic-messages",
      sessionId: input.sessionId,
      capability,
    }) as AnthropicCacheRender;
  }
  if (!capability.strategies.includes("explicitCacheMarker")) {
    return unsupportedCapabilityRender({
      api: "anthropic-messages",
      sessionId: input.sessionId,
      writeMode: policy.writeMode,
      capability,
    }) as AnthropicCacheRender;
  }

  const isDirectAnthropic = input.baseUrl.includes("api.anthropic.com");
  const renderedRetention =
    policy.retention === "long" && !isDirectAnthropic ? "short" : policy.retention;
  return {
    status: policy.retention === renderedRetention ? "rendered" : "degraded",
    reason:
      policy.retention === renderedRetention
        ? "rendered_anthropic_cache_control"
        : "long_retention_requires_direct_anthropic_base_url",
    renderedRetention,
    bucketKey: buildRenderBucketKey({
      api: "anthropic-messages",
      sessionId: input.sessionId,
      retention: renderedRetention,
      writeMode: policy.writeMode,
    }),
    capability,
    cacheControl: {
      type: "ephemeral",
      ...(renderedRetention === "long" ? { ttl: "1h" as const } : {}),
    },
  };
}

export function resolveGoogleGeminiCliCacheRender(input: {
  sessionId?: string;
  policy?: ProviderCachePolicy;
  cachedContentName?: string;
  cachedContentTtlSeconds?: number;
}): GoogleGeminiCliCacheRender {
  const api = "google-gemini-cli" as const;
  const policy = normalizeProviderCachePolicy(input.policy);
  const capability = resolveProviderCacheCapability({ api });
  if (policy.retention === "none") {
    return disabledRender({
      api,
      sessionId: input.sessionId,
      writeMode: policy.writeMode,
      capability,
    }) as GoogleGeminiCliCacheRender;
  }
  if (policy.retention === "short") {
    return {
      status: "rendered",
      reason: "rendered_google_implicit_prefix_cache",
      renderedRetention: "short",
      bucketKey: buildRenderBucketKey({
        api,
        sessionId: input.sessionId,
        retention: "short",
        writeMode: policy.writeMode,
      }),
      capability,
    };
  }
  if (!capability.strategies.includes("explicitCachedContent")) {
    return unsupportedCapabilityRender({
      api,
      sessionId: input.sessionId,
      writeMode: policy.writeMode,
      capability,
    }) as GoogleGeminiCliCacheRender;
  }
  if (!input.cachedContentName) {
    return {
      status: "unsupported",
      reason:
        policy.writeMode === "readOnly"
          ? "cached_content_required_for_read_only_mode"
          : "cached_content_resource_unavailable",
      renderedRetention: "none",
      bucketKey: buildRenderBucketKey({
        api,
        sessionId: input.sessionId,
        retention: "none",
        writeMode: policy.writeMode,
      }),
      capability,
    };
  }
  return {
    status: "rendered",
    reason: "rendered_google_cached_content",
    renderedRetention: "long",
    bucketKey: buildRenderBucketKey({
      api,
      sessionId: input.sessionId,
      retention: "long",
      writeMode: policy.writeMode,
    }),
    capability,
    cachedContentName: input.cachedContentName,
    cachedContentTtlSeconds: input.cachedContentTtlSeconds,
  };
}
