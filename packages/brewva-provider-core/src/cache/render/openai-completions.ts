import type {
  Api,
  Provider,
  ProviderCacheCapability,
  ProviderCachePolicy,
  ProviderCacheStrategy,
  ProviderCacheRenderResult,
} from "../../contracts/index.js";
import { resolveProviderCacheCapability } from "../capability.js";
import {
  buildRenderBucketKey,
  createDisabledCacheRender,
  createMissingSessionCacheRender,
  createUnsupportedCapabilityCacheRender,
  createUnsupportedReadOnlyCacheRender,
  normalizeProviderCachePolicy,
} from "../policy.js";

export type OpenAICompletionsCacheControl = { type: "ephemeral"; ttl?: "1h" };

export interface OpenAICompletionsCacheRender extends ProviderCacheRenderResult {
  promptCacheKey?: string;
  promptCacheRetention?: "24h";
  cacheControl?: OpenAICompletionsCacheControl;
}

export function resolveOpenAICompletionsCacheRender(input: {
  api?: Extract<Api, "openai-completions">;
  baseUrl: string;
  provider?: Provider;
  modelId?: string;
  transport?: "sse" | "websocket" | "auto";
  policy?: ProviderCachePolicy;
  sessionId?: string;
  cacheControlFormat?: "anthropic" | "none";
  supportsPromptCacheKey?: boolean;
  supportsLongCacheRetention?: boolean;
}): OpenAICompletionsCacheRender {
  const api = input.api ?? "openai-completions";
  const provider = input.provider ?? "openai";
  const modelId = input.modelId ?? "";
  const policy = normalizeProviderCachePolicy(input.policy);
  const detectedCapability = resolveProviderCacheCapability({
    api,
    baseUrl: input.baseUrl,
    provider,
    modelId,
    transport: input.transport,
  });
  const capability = resolveOpenAICompletionsEffectiveCacheCapability(detectedCapability, {
    supportsPromptCacheKey: input.supportsPromptCacheKey,
    supportsLongCacheRetention: input.supportsLongCacheRetention,
  });

  if (policy.retention === "none") {
    return {
      ...createDisabledCacheRender({
        provider,
        api,
        model: modelId,
        sessionId: input.sessionId,
        writeMode: policy.writeMode,
        capability,
      }),
      reason: "cache_policy_disabled",
    };
  }

  if (policy.writeMode === "readOnly") {
    return {
      ...createUnsupportedReadOnlyCacheRender({
        provider,
        api,
        model: modelId,
        retention: "none",
        sessionId: input.sessionId,
        capability,
      }),
      status: "unsupported",
      reason: "cache_write_mode_read_only_not_supported",
      renderedRetention: "none",
    };
  }

  if (input.cacheControlFormat === "anthropic") {
    if (!capability.strategies.includes("implicitPrefix")) {
      return {
        ...createUnsupportedCapabilityCacheRender({
          provider,
          api,
          model: modelId,
          sessionId: input.sessionId,
          writeMode: policy.writeMode,
          capability,
        }),
        reason: capability.reason,
      };
    }

    const renderedRetention =
      policy.retention === "long" && input.supportsLongCacheRetention === false
        ? "short"
        : policy.retention;

    return {
      status: policy.retention === renderedRetention ? "rendered" : "degraded",
      reason:
        policy.retention === renderedRetention
          ? "rendered_openai_completions_anthropic_cache_control"
          : "long_retention_not_supported_for_provider_model",
      renderedRetention,
      capability,
      bucketKey: buildRenderBucketKey({
        provider,
        api,
        model: modelId,
        retention: renderedRetention,
        writeMode: policy.writeMode,
        sessionId: input.sessionId,
      }),
      cacheControl: {
        type: "ephemeral",
        ...(renderedRetention === "long" ? { ttl: "1h" as const } : {}),
      },
      promptCacheKey: undefined,
      promptCacheRetention: undefined,
    };
  }

  if (capability.strategies.includes("promptCacheKey")) {
    if (!input.sessionId) {
      return {
        ...createMissingSessionCacheRender({
          provider,
          api,
          model: modelId,
          writeMode: policy.writeMode,
          capability,
        }),
        status: "unsupported",
        reason: "session_id_required_for_session_cache",
      };
    }

    const renderedRetention =
      policy.retention === "long" && capability.longRetention !== "24h"
        ? "short"
        : policy.retention;

    return {
      status: policy.retention === renderedRetention ? "rendered" : "degraded",
      reason:
        policy.retention === renderedRetention
          ? "rendered_openai_completions_prompt_cache"
          : "long_retention_not_supported_for_provider_model",
      renderedRetention,
      capability,
      bucketKey: buildRenderBucketKey({
        provider,
        api,
        model: modelId,
        retention: renderedRetention,
        writeMode: policy.writeMode,
        sessionId: input.sessionId,
      }),
      promptCacheKey: input.sessionId,
      promptCacheRetention: renderedRetention === "long" ? "24h" : undefined,
    };
  }

  if (!capability.strategies.includes("implicitPrefix")) {
    return {
      ...createUnsupportedCapabilityCacheRender({
        provider,
        api,
        model: modelId,
        sessionId: input.sessionId,
        writeMode: policy.writeMode,
        capability,
      }),
      reason: capability.reason,
    };
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
    capability,
    bucketKey: buildRenderBucketKey({
      provider,
      api,
      model: modelId,
      retention: renderedRetention,
      writeMode: policy.writeMode,
      sessionId: input.sessionId,
    }),
  };
}

function resolveOpenAICompletionsEffectiveCacheCapability(
  capability: ProviderCacheCapability,
  compat: {
    supportsPromptCacheKey?: boolean;
    supportsLongCacheRetention?: boolean;
  },
): ProviderCacheCapability {
  let effective = capability;

  if (compat.supportsPromptCacheKey === true && !effective.strategies.includes("promptCacheKey")) {
    const strategies = prependCacheStrategy("promptCacheKey", effective.strategies);
    effective = {
      ...effective,
      strategies,
      cacheCounters: effective.cacheCounters === "none" ? "readOnly" : effective.cacheCounters,
      shortRetention: true,
      longRetention: compat.supportsLongCacheRetention === true ? "24h" : "none",
      reason: "openai_completions_prompt_cache_key_compat",
    };
  }

  if (compat.supportsPromptCacheKey === false && effective.strategies.includes("promptCacheKey")) {
    const strategies = effective.strategies.filter((strategy) => strategy !== "promptCacheKey");
    effective = {
      ...effective,
      strategies: strategies.length > 0 ? strategies : ["implicitPrefix"],
      longRetention: "none",
      reason: "prompt_cache_key_disabled_by_compat",
    };
  }

  if (compat.supportsLongCacheRetention === false && effective.longRetention === "24h") {
    effective = {
      ...effective,
      longRetention: "none",
    };
  }

  if (
    compat.supportsLongCacheRetention === true &&
    effective.strategies.includes("promptCacheKey")
  ) {
    effective = {
      ...effective,
      longRetention: "24h",
    };
  }

  return effective;
}

function prependCacheStrategy(
  strategy: ProviderCacheStrategy,
  strategies: ProviderCacheStrategy[],
): ProviderCacheStrategy[] {
  return [
    strategy,
    ...strategies.filter((candidate) => candidate !== strategy && candidate !== "unsupported"),
  ];
}
