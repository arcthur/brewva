import { buildProviderCacheBucketKey } from "@brewva/brewva-provider-core/cache";
import type {
  ProviderCacheCapability,
  ProviderCachePolicy,
  ProviderCacheRenderResult,
  ProviderRequestFingerprint,
  ThinkingBudgets,
} from "@brewva/brewva-provider-core/contracts";
import { redactedStableJsonSha256Hex } from "@brewva/brewva-std/hash";
import type { ProviderCacheStickyLatchState } from "./sticky-latches.js";
import type { ToolSchemaSnapshot } from "./tool-schema-snapshot.js";

export interface ProviderRequestFingerprintInput {
  provider: string;
  api: string;
  model: string;
  transport?: "sse" | "websocket" | "auto";
  sessionId?: string;
  cachePolicy: ProviderCachePolicy;
  toolSchemaSnapshot: ToolSchemaSnapshot;
  stablePrefixParts: unknown[];
  dynamicTailParts: unknown[];
  channelContext: unknown;
  renderedCache?: ProviderCacheRenderResult;
  cacheCapability?: ProviderCacheCapability;
  stickyLatches?: ProviderCacheStickyLatchState;
  reasoning?: unknown;
  thinkingBudgets?: ThinkingBudgets;
  cacheRelevantHeaders?: Record<string, string>;
  extraBody?: unknown;
  visibleHistoryReduction?: unknown;
  workbenchContext?: unknown;
  providerFallback?: unknown;
  payload: unknown;
  // Literal transmitted secrets (apiKey/token) to scrub from payload-derived hashes,
  // in case a provider response echoed them back into the request content.
  transmittedSecrets?: readonly string[];
}

export function createProviderRequestFingerprint(
  input: ProviderRequestFingerprintInput,
): ProviderRequestFingerprint {
  // Secret-value redaction intentionally covers only the payload-derived hashes below
  // (request/stablePrefix/dynamicTail) — the only fields that ingest provider wire
  // content where an echoed apiKey could land. Do not route response-derived content
  // into the other hash fields without extending secretRedaction to them.
  const secretRedaction = { redactedValues: input.transmittedSecrets };
  return {
    bucketKey: buildProviderCacheBucketKey({
      provider: input.provider,
      api: input.api,
      model: input.model,
      sessionId: input.sessionId,
      policy: input.cachePolicy,
    }),
    provider: input.provider,
    api: input.api,
    model: input.model,
    transport: input.transport,
    sessionId: input.sessionId,
    cachePolicyHash: redactedStableJsonSha256Hex(input.cachePolicy),
    toolSchemaSnapshotHash: input.toolSchemaSnapshot.hash,
    toolSchemaOverlayHash: input.toolSchemaSnapshot.overlayHash,
    perToolHashes: { ...input.toolSchemaSnapshot.perToolHashes },
    stablePrefixHash: redactedStableJsonSha256Hex(input.stablePrefixParts, secretRedaction),
    dynamicTailHash: redactedStableJsonSha256Hex(input.dynamicTailParts, secretRedaction),
    requestHash: redactedStableJsonSha256Hex(input.payload, secretRedaction),
    channelContextHash: redactedStableJsonSha256Hex(input.channelContext),
    renderedCacheHash: redactedStableJsonSha256Hex(input.renderedCache ?? null),
    cacheCapabilityHash: redactedStableJsonSha256Hex(
      input.cacheCapability ?? input.renderedCache?.capability ?? null,
    ),
    stickyLatchHash: redactedStableJsonSha256Hex(input.stickyLatches ?? null),
    reasoningHash: redactedStableJsonSha256Hex(input.reasoning ?? null),
    thinkingBudgetHash: redactedStableJsonSha256Hex(input.thinkingBudgets ?? null),
    cacheRelevantHeadersHash: redactedStableJsonSha256Hex(input.cacheRelevantHeaders ?? null),
    extraBodyHash: redactedStableJsonSha256Hex(input.extraBody ?? null),
    visibleHistoryReductionHash: redactedStableJsonSha256Hex(input.visibleHistoryReduction ?? null),
    workbenchContextHash: redactedStableJsonSha256Hex(input.workbenchContext ?? null),
    providerFallbackHash: redactedStableJsonSha256Hex(input.providerFallback ?? null),
  };
}
