import type { Api, ProviderCacheCapability, Transport } from "../contracts/index.js";

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
      reason: "kimi_code_cache_contract_not_verified",
    };
  }

  if (api === "openai-completions" && isDeepSeekRoute({ provider, baseUrl })) {
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
    const directOpenAI = baseUrl.includes("api.openai.com");
    const providerIsOpenAI = provider === "" || provider === "openai";
    if (directOpenAI && providerIsOpenAI && modelSupportsOpenAIPromptCacheKey(modelId)) {
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
