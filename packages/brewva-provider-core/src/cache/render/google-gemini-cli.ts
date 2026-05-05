import type { ProviderCachePolicy, ProviderCacheRenderResult } from "../../contracts/index.js";
import { resolveProviderCacheCapability } from "../capability.js";
import {
  buildRenderBucketKey,
  createDisabledCacheRender,
  createUnsupportedCapabilityCacheRender,
  normalizeProviderCachePolicy,
} from "../policy.js";

export interface GoogleGeminiCliCacheRender extends ProviderCacheRenderResult {
  cachedContentName?: string;
  cachedContentTtlSeconds?: number;
}

export function resolveGoogleGeminiCliCacheRender(input: {
  cachedContentName?: string;
  cachedContentTtlSeconds?: number;
  modelId?: string;
  policy?: ProviderCachePolicy;
  sessionId?: string;
}): GoogleGeminiCliCacheRender {
  const api = "google-gemini-cli";
  const provider = "google";
  const policy = normalizeProviderCachePolicy(input.policy);
  const capability = resolveProviderCacheCapability({ api });

  if (policy.retention === "none") {
    return {
      ...createDisabledCacheRender({
        provider,
        api,
        model: input.modelId ?? "",
        sessionId: input.sessionId,
        writeMode: policy.writeMode,
        capability,
      }),
      reason: "cache_policy_disabled",
    };
  }

  if (policy.retention === "short") {
    return {
      status: "rendered",
      reason: "rendered_google_implicit_prefix_cache",
      renderedRetention: "short",
      capability,
      bucketKey: buildRenderBucketKey({
        provider,
        api,
        model: input.modelId ?? "",
        retention: "short",
        writeMode: policy.writeMode,
        sessionId: input.sessionId,
      }),
    };
  }

  if (!capability.strategies.includes("explicitCachedContent")) {
    return {
      ...createUnsupportedCapabilityCacheRender({
        provider,
        api,
        model: input.modelId ?? "",
        sessionId: input.sessionId,
        writeMode: policy.writeMode,
        capability,
      }),
      reason: capability.reason,
    };
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
        provider,
        api,
        model: input.modelId ?? "",
        retention: "none",
        writeMode: policy.writeMode,
        sessionId: input.sessionId,
      }),
      capability,
    };
  }

  return {
    status: "rendered",
    reason: "rendered_google_cached_content",
    renderedRetention: "long",
    capability,
    bucketKey: buildRenderBucketKey({
      provider,
      api,
      model: input.modelId ?? "",
      retention: "long",
      writeMode: policy.writeMode,
      sessionId: input.sessionId,
    }),
    cachedContentName: input.cachedContentName,
    cachedContentTtlSeconds: input.cachedContentTtlSeconds,
  };
}
