import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ProviderRequestFingerprint } from "@brewva/brewva-provider-core/contracts";
import type {
  ExpectedProviderCacheBreak,
  ProviderCacheBreakObservation,
  ProviderCacheRenderState,
} from "@brewva/brewva-runtime";
import { redactedStableJsonSha256Hex, redactedStableJsonStringify } from "@brewva/brewva-std/hash";
import { SourceTracker } from "./source-tracker.js";

export const DEFAULT_PROVIDER_CACHE_DETECTOR_THRESHOLDS = {
  minCacheMissTokens: 2_000,
  relativeDropThreshold: 0.05,
  maxTrackedSources: 10,
  shortTtlMs: 5 * 60 * 1000,
  longTtlMs: 60 * 60 * 1000,
};

export interface ProviderCacheUsageInput {
  cacheRead: number;
  cacheWrite: number;
}

export interface ProviderCacheBreakDetectorInput {
  source: string;
  fingerprint: ProviderRequestFingerprint;
  render?: ProviderCacheRenderState;
  usage: ProviderCacheUsageInput;
  expectedBreak?: ExpectedProviderCacheBreak;
  observability?: {
    cacheCountersAvailable?: boolean;
    excluded?: boolean;
    reason?: string;
  };
  observedAt?: number;
}

export interface ProviderCacheBreakDetectorOptions extends Partial<
  typeof DEFAULT_PROVIDER_CACHE_DETECTOR_THRESHOLDS
> {
  diagnosticDumpDirectory?: string;
}

interface PreviousProviderCacheState {
  fingerprint: ProviderRequestFingerprint;
  cacheReadTokens: number;
  observedAt: number;
}

export class ProviderCacheBreakDetector {
  readonly #states: SourceTracker<PreviousProviderCacheState>;
  readonly #minCacheMissTokens: number;
  readonly #relativeDropThreshold: number;
  readonly #shortTtlMs: number;
  readonly #longTtlMs: number;
  readonly #diagnosticDumpDirectory: string | undefined;

  constructor(options: ProviderCacheBreakDetectorOptions = {}) {
    this.#states = new SourceTracker(
      options.maxTrackedSources ?? DEFAULT_PROVIDER_CACHE_DETECTOR_THRESHOLDS.maxTrackedSources,
    );
    this.#minCacheMissTokens =
      options.minCacheMissTokens ?? DEFAULT_PROVIDER_CACHE_DETECTOR_THRESHOLDS.minCacheMissTokens;
    this.#relativeDropThreshold =
      options.relativeDropThreshold ??
      DEFAULT_PROVIDER_CACHE_DETECTOR_THRESHOLDS.relativeDropThreshold;
    this.#shortTtlMs = options.shortTtlMs ?? DEFAULT_PROVIDER_CACHE_DETECTOR_THRESHOLDS.shortTtlMs;
    this.#longTtlMs = options.longTtlMs ?? DEFAULT_PROVIDER_CACHE_DETECTOR_THRESHOLDS.longTtlMs;
    this.#diagnosticDumpDirectory = options.diagnosticDumpDirectory;
  }

  observe(input: ProviderCacheBreakDetectorInput): ProviderCacheBreakObservation {
    const previous = this.#states.get(input.source);
    const cacheReadTokens = normalizeTokens(input.usage.cacheRead);
    const cacheWriteTokens = normalizeTokens(input.usage.cacheWrite);
    const observedAt = normalizeObservedAt(input.observedAt);
    if (input.observability?.excluded || input.observability?.cacheCountersAvailable === false) {
      this.#states.clear(input.source);
      return this.#buildObservation({
        status: "limited",
        classification: "cacheCold",
        expected: false,
        reason: input.observability.reason ?? "provider_cache_observability_limited",
        previousCacheReadTokens: 0,
        cacheReadTokens,
        cacheWriteTokens,
        cacheMissTokens: 0,
        changedFields: [],
      });
    }

    if (!previous) {
      this.#states.set(input.source, {
        fingerprint: input.fingerprint,
        cacheReadTokens,
        observedAt,
      });
      return this.#buildObservation({
        status: "cold",
        classification: "cacheCold",
        expected: false,
        reason: "cache_state_cold",
        previousCacheReadTokens: 0,
        cacheReadTokens,
        cacheWriteTokens,
        cacheMissTokens: 0,
        changedFields: [],
      });
    }

    const changedFields = diffFingerprint(previous.fingerprint, input.fingerprint);
    const cacheMissTokens = Math.max(0, previous.cacheReadTokens - cacheReadTokens);
    const relativeDropExceeded =
      previous.cacheReadTokens > 0 &&
      cacheReadTokens < previous.cacheReadTokens * (1 - this.#relativeDropThreshold);
    const tokenDropExceeded = cacheMissTokens >= this.#minCacheMissTokens;
    const isBreak = tokenDropExceeded && relativeDropExceeded;

    if (input.expectedBreak) {
      this.#states.set(input.source, {
        fingerprint: input.fingerprint,
        cacheReadTokens,
        observedAt,
      });
      return this.#buildObservation({
        status: "break",
        classification: input.expectedBreak.classification,
        expected: true,
        reason: input.expectedBreak.reason,
        previousCacheReadTokens: previous.cacheReadTokens,
        cacheReadTokens,
        cacheWriteTokens,
        cacheMissTokens,
        changedFields,
      });
    }

    if (!isBreak) {
      this.#states.set(input.source, {
        fingerprint: input.fingerprint,
        cacheReadTokens,
        observedAt,
      });
      return this.#buildObservation({
        status: "warm",
        classification: "prefixPreserving",
        expected: false,
        reason: null,
        previousCacheReadTokens: previous.cacheReadTokens,
        cacheReadTokens,
        cacheWriteTokens,
        cacheMissTokens,
        changedFields,
      });
    }

    this.#states.set(input.source, {
      fingerprint: input.fingerprint,
      cacheReadTokens,
      observedAt,
    });
    const observation = this.#buildObservation({
      status: "break",
      classification: "prefixPreserving",
      expected: false,
      reason: classifyUnexpectedBreakReason({
        changedFields,
        elapsedMs: Math.max(0, observedAt - previous.observedAt),
        shortTtlMs: this.#shortTtlMs,
        longTtlMs: this.#longTtlMs,
        render: input.render,
      }),
      previousCacheReadTokens: previous.cacheReadTokens,
      cacheReadTokens,
      cacheWriteTokens,
      cacheMissTokens,
      changedFields,
    });
    this.#dumpUnexpectedBreak({
      source: input.source,
      observedAt,
      previous,
      fingerprint: input.fingerprint,
      observation,
    });
    return observation;
  }

  clear(source?: string): void {
    this.#states.clear(source);
  }

  #buildObservation(
    input: Omit<ProviderCacheBreakObservation, "thresholdTokens" | "relativeDropThreshold">,
  ): ProviderCacheBreakObservation {
    return {
      ...input,
      thresholdTokens: this.#minCacheMissTokens,
      relativeDropThreshold: this.#relativeDropThreshold,
    };
  }

  #dumpUnexpectedBreak(input: {
    source: string;
    observedAt: number;
    previous: PreviousProviderCacheState;
    fingerprint: ProviderRequestFingerprint;
    observation: ProviderCacheBreakObservation;
  }): void {
    if (!this.#diagnosticDumpDirectory) {
      return;
    }
    try {
      mkdirSync(this.#diagnosticDumpDirectory, { recursive: true });
      const shortId = redactedStableJsonSha256Hex({
        source: input.source,
        observedAt: input.observedAt,
        requestHash: input.fingerprint.requestHash,
      }).slice(0, 12);
      const filePath = join(
        this.#diagnosticDumpDirectory,
        `cache-break-${input.observedAt}-${shortId}.json`,
      );
      writeFileSync(
        filePath,
        `${redactedStableJsonStringify({
          source: input.source,
          observedAt: input.observedAt,
          observation: input.observation,
          previousFingerprint: input.previous.fingerprint,
          nextFingerprint: input.fingerprint,
          previousCacheReadTokens: input.previous.cacheReadTokens,
        })}\n`,
        "utf8",
      );
    } catch {
      // Diagnostics must never affect provider execution.
    }
  }
}

function normalizeTokens(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.trunc(value));
}

function diffFingerprint(
  previous: ProviderRequestFingerprint,
  next: ProviderRequestFingerprint,
): string[] {
  const changed: string[] = [];
  const keys: Array<keyof ProviderRequestFingerprint> = [
    "bucketKey",
    "cachePolicyHash",
    "toolSchemaSnapshotHash",
    "toolSchemaOverlayHash",
    "stablePrefixHash",
    "dynamicTailHash",
    "requestHash",
    "activeSkillSetHash",
    "skillRoutingEpoch",
    "channelContextHash",
    "renderedCacheHash",
    "cacheCapabilityHash",
    "stickyLatchHash",
    "reasoningHash",
    "thinkingBudgetHash",
    "cacheRelevantHeadersHash",
    "extraBodyHash",
    "visibleHistoryReductionHash",
    "recallInjectionHash",
    "providerFallbackHash",
  ];
  for (const key of keys) {
    if (previous[key] !== next[key]) {
      changed.push(key);
    }
  }
  for (const tool of new Set([
    ...Object.keys(previous.perToolHashes),
    ...Object.keys(next.perToolHashes),
  ])) {
    if (previous.perToolHashes[tool] !== next.perToolHashes[tool]) {
      changed.push(`tool:${tool}`);
    }
  }
  return changed;
}

function normalizeObservedAt(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : Date.now();
}

function classifyUnexpectedBreakReason(input: {
  changedFields: readonly string[];
  elapsedMs: number;
  shortTtlMs: number;
  longTtlMs: number;
  render?: ProviderCacheRenderState;
}): string {
  if (input.changedFields.length === 0) {
    const renderedTtlMs = resolveRenderedCacheTtlMs(input);
    if (renderedTtlMs !== undefined && input.elapsedMs >= renderedTtlMs) {
      return `possible_cache_ttl_expiry_${formatTtlLabel(renderedTtlMs)}`;
    }
    if (input.elapsedMs >= input.longTtlMs) {
      return `possible_cache_ttl_expiry_${formatTtlLabel(input.longTtlMs)}`;
    }
    if (input.elapsedMs >= input.shortTtlMs) {
      return `possible_cache_ttl_expiry_${formatTtlLabel(input.shortTtlMs)}`;
    }
  }
  return "cache_read_drop_exceeded_threshold";
}

function resolveRenderedCacheTtlMs(input: {
  render?: ProviderCacheRenderState;
  shortTtlMs: number;
  longTtlMs: number;
}): number | undefined {
  const explicitTtlSeconds = input.render?.cachedContentTtlSeconds;
  if (
    typeof explicitTtlSeconds === "number" &&
    Number.isFinite(explicitTtlSeconds) &&
    explicitTtlSeconds > 0
  ) {
    return Math.trunc(explicitTtlSeconds) * 1000;
  }
  if (input.render?.renderedRetention === "long") {
    const label = input.render.capability?.longRetention;
    if (label && label !== "none") {
      return parseRetentionHours(label) * 60 * 60 * 1000;
    }
    return input.longTtlMs;
  }
  if (input.render?.renderedRetention === "short") {
    return input.shortTtlMs;
  }
  return undefined;
}

function parseRetentionHours(value: string): number {
  const match = /^(\d+)h$/.exec(value);
  const hours = match?.[1];
  if (!hours) {
    return 1;
  }
  return Math.max(1, Number.parseInt(hours, 10));
}

function formatTtlLabel(ttlMs: number): string {
  if (ttlMs % (60 * 60 * 1000) === 0) {
    return `${ttlMs / (60 * 60 * 1000)}h`;
  }
  if (ttlMs % (60 * 1000) === 0) {
    return `${ttlMs / (60 * 1000)}m`;
  }
  return `${Math.max(1, Math.round(ttlMs / 1000))}s`;
}
