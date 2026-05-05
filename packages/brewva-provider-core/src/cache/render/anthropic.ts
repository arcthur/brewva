import type { ProviderCachePolicy, ProviderCacheRenderResult } from "../../contracts/index.js";
import { resolveProviderCacheCapability } from "../capability.js";
import {
  buildRenderBucketKey,
  createDisabledCacheRender,
  createUnsupportedCapabilityCacheRender,
  normalizeProviderCachePolicy,
} from "../policy.js";

export interface AnthropicCacheRender extends ProviderCacheRenderResult {
  cacheControl?: {
    type: "ephemeral";
    ttl?: "1h";
  };
}

export function resolveAnthropicCacheRender(input: {
  baseUrl: string;
  provider?: string;
  modelId?: string;
  policy?: ProviderCachePolicy;
  sessionId?: string;
}): AnthropicCacheRender {
  const api = "anthropic-messages";
  const provider = input.provider ?? "anthropic";
  const modelId = input.modelId ?? "";
  const policy = normalizeProviderCachePolicy(input.policy);
  const capability = resolveProviderCacheCapability({
    api,
    provider,
    modelId,
    baseUrl: input.baseUrl,
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
      cacheControl: undefined,
    };
  }

  if (policy.writeMode === "readOnly") {
    return {
      ...createUnsupportedCapabilityCacheRender({
        provider,
        api,
        model: modelId,
        sessionId: input.sessionId,
        capability,
        writeMode: "readOnly",
      }),
      status: "unsupported",
      reason: "cache_write_mode_read_only_not_supported",
      renderedRetention: "none",
      bucketKey: buildRenderBucketKey({
        provider,
        api,
        model: modelId,
        retention: "none",
        writeMode: "readOnly",
        sessionId: input.sessionId,
      }),
      cacheControl: undefined,
    };
  }

  if (!capability.strategies.includes("explicitCacheMarker")) {
    return {
      ...createUnsupportedCapabilityCacheRender({
        provider,
        api,
        model: modelId,
        sessionId: input.sessionId,
        capability,
        writeMode: policy.writeMode,
      }),
      reason: capability.reason,
      bucketKey: buildRenderBucketKey({
        provider,
        api,
        model: modelId,
        retention: "none",
        writeMode: policy.writeMode,
        sessionId: input.sessionId,
      }),
      cacheControl: undefined,
    };
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
  };
}
