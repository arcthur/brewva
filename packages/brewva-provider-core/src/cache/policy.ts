import type {
  Api,
  Provider,
  ProviderCachePolicy,
  ProviderCacheRenderResult,
  Transport,
} from "../contracts/index.js";

export const DEFAULT_PROVIDER_CACHE_POLICY: ProviderCachePolicy = {
  retention: "short",
  writeMode: "readWrite",
  scope: "session",
  reason: "default",
};

export interface ProviderCacheBucketInput {
  provider: Provider;
  api: Api;
  model: string;
  sessionId?: string;
  policy?: ProviderCachePolicy;
  transport?: Transport;
}

export function normalizeProviderCachePolicy(policy?: ProviderCachePolicy): ProviderCachePolicy {
  const source = policy ?? DEFAULT_PROVIDER_CACHE_POLICY;
  return {
    retention: source.retention,
    writeMode: source.writeMode,
    scope: source.scope,
    reason: source.reason,
  };
}

export function buildProviderCacheBucketKey(input: ProviderCacheBucketInput): string {
  const policy = normalizeProviderCachePolicy(input.policy);
  const segments = [
    `provider=${input.provider}`,
    `api=${input.api}`,
    `model=${input.model}`,
    `scope=${policy.scope}`,
    `retention=${policy.retention}`,
    `writeMode=${policy.writeMode}`,
  ];
  if (policy.scope === "session") {
    segments.push(`session=${input.sessionId ?? "none"}`);
  }
  return segments.join("|");
}

export function buildRenderBucketKey(input: {
  api: Api;
  retention: ProviderCachePolicy["retention"];
  writeMode: ProviderCachePolicy["writeMode"];
  sessionId?: string;
  provider?: Provider;
  model?: string;
}): string {
  return [
    input.api,
    `session=${input.sessionId ?? "none"}`,
    `retention=${input.retention}`,
    `writeMode=${input.writeMode}`,
  ].join("|");
}

export function createDisabledCacheRender(input: {
  provider: Provider;
  api: Api;
  model: string;
  sessionId?: string;
  writeMode?: ProviderCachePolicy["writeMode"];
  capability?: ProviderCacheRenderResult["capability"];
}): ProviderCacheRenderResult {
  return {
    status: "disabled",
    reason: "disabled",
    renderedRetention: "none",
    bucketKey: buildRenderBucketKey({
      provider: input.provider,
      api: input.api,
      model: input.model,
      retention: "none",
      writeMode: input.writeMode ?? "readWrite",
      sessionId: input.sessionId,
    }),
    capability: input.capability,
  };
}

export function createMissingSessionCacheRender(input: {
  provider: Provider;
  api: Api;
  model: string;
  writeMode?: ProviderCachePolicy["writeMode"];
  capability?: ProviderCacheRenderResult["capability"];
}): ProviderCacheRenderResult {
  return {
    status: "degraded",
    reason: "missing_session",
    renderedRetention: "none",
    bucketKey: buildRenderBucketKey({
      provider: input.provider,
      api: input.api,
      model: input.model,
      retention: "none",
      writeMode: input.writeMode ?? "readWrite",
    }),
    capability: input.capability,
  };
}

export function createUnsupportedReadOnlyCacheRender(input: {
  provider: Provider;
  api: Api;
  model: string;
  retention: ProviderCachePolicy["retention"];
  sessionId?: string;
  capability?: ProviderCacheRenderResult["capability"];
}): ProviderCacheRenderResult {
  return {
    status: "degraded",
    reason: "read_only_unsupported",
    renderedRetention: input.retention,
    bucketKey: buildRenderBucketKey({
      provider: input.provider,
      api: input.api,
      model: input.model,
      retention: input.retention,
      writeMode: "readOnly",
      sessionId: input.sessionId,
    }),
    capability: input.capability,
  };
}

export function createUnsupportedCapabilityCacheRender(input: {
  provider: Provider;
  api: Api;
  model: string;
  sessionId?: string;
  writeMode?: ProviderCachePolicy["writeMode"];
  capability?: ProviderCacheRenderResult["capability"];
}): ProviderCacheRenderResult {
  return {
    status: "unsupported",
    reason: "provider_unsupported",
    renderedRetention: "none",
    bucketKey: buildRenderBucketKey({
      provider: input.provider,
      api: input.api,
      model: input.model,
      retention: "none",
      writeMode: input.writeMode ?? "readWrite",
      sessionId: input.sessionId,
    }),
    capability: input.capability,
  };
}
