import type {
  Api,
  Provider,
  ProviderCachePolicy,
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

export interface OpenAIResponsesCacheRender extends ProviderCacheRenderResult {
  promptCacheKey?: string;
  promptCacheRetention?: "24h";
}

export function resolveOpenAIResponsesCacheRender(input: {
  api?: Extract<Api, "openai-responses" | "openai-codex-responses">;
  provider?: Provider;
  baseUrl: string;
  modelId?: string;
  policy?: ProviderCachePolicy;
  sessionId?: string;
  transport?: "sse" | "websocket" | "auto";
}): OpenAIResponsesCacheRender {
  const api = input.api ?? "openai-responses";
  const provider = input.provider ?? "openai";
  const modelId = input.modelId ?? "";
  const policy = normalizeProviderCachePolicy(input.policy);
  const capability = resolveProviderCacheCapability({
    api,
    baseUrl: input.baseUrl,
    provider,
    modelId,
    transport: input.transport,
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

  if (!capability.strategies.includes("promptCacheKey")) {
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
    policy.retention === "long" && capability.longRetention !== "24h" ? "short" : policy.retention;

  return {
    status: policy.retention === renderedRetention ? "rendered" : "degraded",
    reason:
      policy.retention === renderedRetention
        ? "rendered_openai_prompt_cache"
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
