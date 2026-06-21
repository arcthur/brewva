import type { Api, ProviderCacheCapability, Transport } from "../contracts/index.js";
import {
  type DeploymentDescriptor,
  isDeepSeekRoute,
  isDirectAnthropicHost,
  isDirectOpenAIHost,
  isKimiCodeRoute,
  modelAdvertisesOpenAIPromptCacheKey,
} from "../quirks/index.js";

export interface ProviderCacheCapabilityInput {
  api: Api;
  baseUrl?: string;
  provider?: string;
  modelId?: string;
  transport?: Transport;
}

export function resolveProviderCacheCapability(
  input: ProviderCacheCapabilityInput,
): ProviderCacheCapability {
  const descriptor: DeploymentDescriptor = {
    api: input.api.toLowerCase() as Api,
    provider: (input.provider ?? "").toLowerCase(),
    baseUrl: (input.baseUrl ?? "").toLowerCase(),
    modelId: (input.modelId ?? "").toLowerCase(),
    transport: input.transport ?? "auto",
  };
  const { api, provider, transport } = descriptor;
  const providerIsOpenAI = provider === "" || provider === "openai";

  if (isKimiCodeRoute(descriptor)) {
    return {
      strategies: ["unsupported"],
      cacheCounters: "none",
      shortRetention: false,
      longRetention: "none",
      readOnlyWriteMode: "unsupported",
      reason: "kimi_code_cache_contract_not_verified",
    };
  }

  if (api === "openai-completions" && isDeepSeekRoute(descriptor)) {
    return {
      strategies: ["implicitPrefix"],
      cacheCounters: "readOnly",
      shortRetention: true,
      longRetention: "none",
      readOnlyWriteMode: "unsupported",
      reason: "deepseek_context_disk_cache",
    };
  }

  if (api === "openai-completions") {
    if (
      isDirectOpenAIHost(descriptor.baseUrl) &&
      providerIsOpenAI &&
      modelAdvertisesOpenAIPromptCacheKey(descriptor)
    ) {
      return {
        strategies: ["promptCacheKey", "implicitPrefix"],
        cacheCounters: "readOnly",
        shortRetention: true,
        longRetention: "24h",
        readOnlyWriteMode: "unsupported",
        reason: "openai_completions_prompt_cache_key",
      };
    }
  }

  if (api === "anthropic-messages") {
    return {
      strategies: ["explicitCacheMarker"],
      cacheCounters: "readWrite",
      shortRetention: true,
      longRetention: isDirectAnthropicHost(descriptor.baseUrl) ? "1h" : "none",
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
    if (
      isDirectOpenAIHost(descriptor.baseUrl) &&
      providerIsOpenAI &&
      modelAdvertisesOpenAIPromptCacheKey(descriptor)
    ) {
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

  if (api === "google-genai") {
    return {
      strategies: ["implicitPrefix", "explicitCachedContent"],
      cacheCounters: "readOnly",
      shortRetention: true,
      longRetention: "1h",
      readOnlyWriteMode: "supported",
      reason: "google_genai_context_caching",
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
