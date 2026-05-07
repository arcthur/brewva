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
  activeSkillSet: string[];
  skillRoutingEpoch: number;
  channelContext: unknown;
  renderedCache?: ProviderCacheRenderResult;
  cacheCapability?: ProviderCacheCapability;
  stickyLatches?: ProviderCacheStickyLatchState;
  reasoning?: unknown;
  thinkingBudgets?: ThinkingBudgets;
  cacheRelevantHeaders?: Record<string, string>;
  extraBody?: unknown;
  visibleHistoryReduction?: unknown;
  recallInjection?: unknown;
  providerFallback?: unknown;
  payload: unknown;
}

export function createProviderRequestFingerprint(
  input: ProviderRequestFingerprintInput,
): ProviderRequestFingerprint {
  const activeSkillSet = input.activeSkillSet.toSorted();
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
    stablePrefixHash: redactedStableJsonSha256Hex(input.stablePrefixParts),
    dynamicTailHash: redactedStableJsonSha256Hex(input.dynamicTailParts),
    requestHash: redactedStableJsonSha256Hex(input.payload),
    activeSkillSetHash: redactedStableJsonSha256Hex(activeSkillSet),
    skillRoutingEpoch: Math.max(0, Math.trunc(input.skillRoutingEpoch)),
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
    recallInjectionHash: redactedStableJsonSha256Hex(input.recallInjection ?? null),
    providerFallbackHash: redactedStableJsonSha256Hex(input.providerFallback ?? null),
  };
}
