import type { Api, Provider, Transport } from "./api.js";

export type ProviderCacheRetention = "none" | "short" | "long";
export type ProviderCacheWriteMode = "readWrite" | "readOnly";
export type ProviderCacheScope = "session";

export type ProviderCacheStrategy =
  | "explicitCacheMarker"
  | "explicitCachedContent"
  | "promptCacheKey"
  | "implicitPrefix"
  | "unsupported";

export type ProviderCacheCounterSupport = "readWrite" | "readOnly" | "none";
export type ProviderCacheLongRetention = "none" | "1h" | "24h";
export type ProviderCacheReadOnlyWriteMode = "supported" | "unsupported";

export type ProviderSessionContinuationFamily = "openai-responses";
export type ProviderSessionContinuationMode =
  | "websocketConnection"
  | "previousResponseId"
  | "turnStateHeader";

export interface ProviderSessionContinuationCapability {
  family: ProviderSessionContinuationFamily;
  modes: ProviderSessionContinuationMode[];
  authority: "efficiency";
  reason: string;
}

export interface ProviderCacheCapability {
  strategies: ProviderCacheStrategy[];
  cacheCounters: ProviderCacheCounterSupport;
  shortRetention: boolean;
  longRetention: ProviderCacheLongRetention;
  readOnlyWriteMode: ProviderCacheReadOnlyWriteMode;
  continuation?: ProviderSessionContinuationCapability;
  reason: string;
}

export type ProviderCachePolicyReason =
  | "default"
  | "config"
  | "provider_fallback"
  | "pressure"
  | "disabled"
  | (string & {});

export interface ProviderCachePolicy {
  retention: ProviderCacheRetention;
  writeMode: ProviderCacheWriteMode;
  scope: ProviderCacheScope;
  reason: ProviderCachePolicyReason;
}

export type ProviderCacheRenderStatus = "rendered" | "disabled" | "unsupported" | "degraded";

export interface ProviderCacheRenderResult {
  status: ProviderCacheRenderStatus;
  reason: string;
  renderedRetention: ProviderCacheRetention;
  bucketKey: string;
  capability?: ProviderCacheCapability;
  cachedContentName?: string;
  cachedContentTtlSeconds?: number;
}

/** Opaque SHA-256 hex digest. Consumers should compare for equality only. */
export type ProviderCacheFingerprintDigest = string;

export interface ProviderRequestFingerprint {
  bucketKey: string;
  provider: Provider;
  api: Api;
  model: string;
  transport?: Transport;
  sessionId?: string;
  cachePolicyHash: ProviderCacheFingerprintDigest;
  toolSchemaSnapshotHash: ProviderCacheFingerprintDigest;
  toolSchemaOverlayHash: ProviderCacheFingerprintDigest;
  perToolHashes: Record<string, ProviderCacheFingerprintDigest>;
  stablePrefixHash: ProviderCacheFingerprintDigest;
  dynamicTailHash: ProviderCacheFingerprintDigest;
  requestHash: ProviderCacheFingerprintDigest;
  channelContextHash: ProviderCacheFingerprintDigest;
  renderedCacheHash: ProviderCacheFingerprintDigest;
  cacheCapabilityHash: ProviderCacheFingerprintDigest;
  stickyLatchHash: ProviderCacheFingerprintDigest;
  reasoningHash: ProviderCacheFingerprintDigest;
  thinkingBudgetHash: ProviderCacheFingerprintDigest;
  cacheRelevantHeadersHash: ProviderCacheFingerprintDigest;
  extraBodyHash: ProviderCacheFingerprintDigest;
  visibleHistoryReductionHash: ProviderCacheFingerprintDigest;
  workbenchContextHash: ProviderCacheFingerprintDigest;
  providerFallbackHash: ProviderCacheFingerprintDigest;
}
