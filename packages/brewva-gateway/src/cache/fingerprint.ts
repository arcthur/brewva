import { buildProviderCacheBucketKey } from "@brewva/brewva-provider-core/cache";
import type {
  ProviderCacheCapability,
  ProviderCachePolicy,
  ProviderCacheRenderResult,
  ProviderRequestFingerprint,
  ThinkingBudgets,
} from "@brewva/brewva-provider-core/contracts";
import { stableHash, stableStringify } from "./hash.js";
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
    cachePolicyHash: stableHash(stableStringify(input.cachePolicy)),
    toolSchemaSnapshotHash: input.toolSchemaSnapshot.hash,
    toolSchemaOverlayHash: input.toolSchemaSnapshot.overlayHash,
    perToolHashes: { ...input.toolSchemaSnapshot.perToolHashes },
    stablePrefixHash: stableHash(stableStringify(input.stablePrefixParts)),
    dynamicTailHash: stableHash(stableStringify(input.dynamicTailParts)),
    requestHash: stableHash(stableStringify(input.payload)),
    activeSkillSetHash: stableHash(stableStringify(activeSkillSet)),
    skillRoutingEpoch: Math.max(0, Math.trunc(input.skillRoutingEpoch)),
    channelContextHash: stableHash(stableStringify(input.channelContext)),
    renderedCacheHash: stableHash(stableStringify(input.renderedCache ?? null)),
    cacheCapabilityHash: stableHash(
      stableStringify(input.cacheCapability ?? input.renderedCache?.capability ?? null),
    ),
    stickyLatchHash: stableHash(stableStringify(input.stickyLatches ?? null)),
    reasoningHash: stableHash(stableStringify(input.reasoning ?? null)),
    thinkingBudgetHash: stableHash(stableStringify(input.thinkingBudgets ?? null)),
    cacheRelevantHeadersHash: stableHash(stableStringify(input.cacheRelevantHeaders ?? null)),
    extraBodyHash: stableHash(stableStringify(input.extraBody ?? null)),
    visibleHistoryReductionHash: stableHash(stableStringify(input.visibleHistoryReduction ?? null)),
    recallInjectionHash: stableHash(stableStringify(input.recallInjection ?? null)),
    providerFallbackHash: stableHash(stableStringify(input.providerFallback ?? null)),
  };
}
