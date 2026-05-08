import { sha256Hex } from "@brewva/brewva-std/hash";
import {
  GOVERNANCE_COMPACTION_INTEGRITY_CHECKED_EVENT_TYPE,
  GOVERNANCE_COMPACTION_INTEGRITY_ERROR_EVENT_TYPE,
  GOVERNANCE_COMPACTION_INTEGRITY_FAILED_EVENT_TYPE,
  SESSION_COMPACT_EVENT_TYPE,
} from "../../events/registry.js";
import type { BrewvaEventRecord } from "../../events/types.js";
import type { RuntimeCallback } from "../../runtime/callback.js";
import {
  sanitizeCompactionSummary,
  validateCompactionSummary,
} from "../../security/compaction-integrity.js";
import type { GovernancePort } from "../governance/api.js";
import type { RuntimeSessionStateStore } from "../sessions/api.js";
import type {
  ProviderCacheObservationState,
  SessionCompactionCacheImpact,
  SessionCompactionCacheImpactSnapshot,
  SessionCompactionCommitInput,
  SessionCompactionGenerationMetadata,
} from "./types.js";

export interface ContextCompactionDeps {
  sessionState: RuntimeSessionStateStore;
  recordInfrastructureRow: RuntimeCallback<
    [
      input: {
        sessionId: string;
        tool: string;
        argsSummary: string;
        outputSummary: string;
        fullOutput?: string;
        verdict?: "pass" | "fail" | "inconclusive";
        metadata?: Record<string, unknown>;
        turn?: number;
        skill?: string | null;
      },
    ],
    string
  >;
  governancePort?: GovernancePort;
  markPressureCompacted: RuntimeCallback<[sessionId: string]>;
  commitWorkbenchBaseline?: RuntimeCallback<[sessionId: string], unknown>;
  getCurrentTurn: RuntimeCallback<[sessionId: string], number>;
  recordEvent: RuntimeCallback<
    [
      input: {
        sessionId: string;
        type: string;
        turn?: number;
        payload?: object;
        timestamp?: number;
        skipTapeCheckpoint?: boolean;
      },
    ],
    BrewvaEventRecord | undefined
  >;
}

function finiteNonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function normalizeCompactionGenerationMetadata(
  input: SessionCompactionGenerationMetadata | undefined,
): SessionCompactionGenerationMetadata | undefined {
  if (!input || typeof input.strategy !== "string" || input.strategy.trim().length === 0) {
    return undefined;
  }
  const model =
    input.model &&
    typeof input.model.provider === "string" &&
    typeof input.model.id === "string" &&
    typeof input.model.api === "string"
      ? {
          provider: input.model.provider,
          id: input.model.id,
          api: input.model.api,
        }
      : undefined;
  const usage = input.usage
    ? {
        input: finiteNonNegativeNumber(input.usage.input),
        output: finiteNonNegativeNumber(input.usage.output),
        cacheRead: finiteNonNegativeNumber(input.usage.cacheRead),
        cacheWrite: finiteNonNegativeNumber(input.usage.cacheWrite),
        totalTokens: finiteNonNegativeNumber(input.usage.totalTokens),
        cost: input.usage.cost
          ? {
              total: finiteNonNegativeNumber(input.usage.cost.total),
            }
          : undefined,
      }
    : undefined;
  return {
    strategy: input.strategy.trim(),
    ...(model ? { model } : {}),
    ...(usage ? { usage } : {}),
    ...(input.fallbackReason && input.fallbackReason.trim().length > 0
      ? { fallbackReason: input.fallbackReason.trim() }
      : {}),
  };
}

function normalizeCacheImpactSnapshot(
  input: SessionCompactionCacheImpactSnapshot | null | undefined,
): SessionCompactionCacheImpactSnapshot | null {
  if (!input) {
    return null;
  }
  return {
    cacheReadTokens: Math.max(0, Math.trunc(input.cacheReadTokens)),
    cacheWriteTokens: Math.max(0, Math.trunc(input.cacheWriteTokens)),
    bucketKey: input.bucketKey,
    stablePrefixHash: input.stablePrefixHash,
    dynamicTailHash: input.dynamicTailHash,
    visibleHistoryReductionHash: input.visibleHistoryReductionHash,
    workbenchContextHash: input.workbenchContextHash,
  };
}

function providerCacheObservationSnapshot(
  observation: ProviderCacheObservationState | undefined,
): SessionCompactionCacheImpactSnapshot | null {
  if (!observation) {
    return null;
  }
  return {
    cacheReadTokens: observation.breakObservation.cacheReadTokens,
    cacheWriteTokens: observation.breakObservation.cacheWriteTokens,
    bucketKey: observation.fingerprint.bucketKey,
    stablePrefixHash: observation.fingerprint.stablePrefixHash,
    dynamicTailHash: observation.fingerprint.dynamicTailHash,
    visibleHistoryReductionHash: observation.fingerprint.visibleHistoryReductionHash,
    workbenchContextHash: observation.fingerprint.workbenchContextHash,
  };
}

function normalizeCompactionCacheImpact(
  input: SessionCompactionCacheImpact | undefined,
  before: SessionCompactionCacheImpactSnapshot | null,
): SessionCompactionCacheImpact {
  return {
    before: normalizeCacheImpactSnapshot(input?.before) ?? before,
    after: normalizeCacheImpactSnapshot(input?.after),
    explicitEpochChanges: Math.max(0, Math.trunc(input?.explicitEpochChanges ?? 1)),
    prefixBytesChanged:
      typeof input?.prefixBytesChanged === "number" && Number.isFinite(input.prefixBytesChanged)
        ? Math.max(0, Math.trunc(input.prefixBytesChanged))
        : null,
    degradedReason:
      typeof input?.degradedReason === "string" && input.degradedReason.trim().length > 0
        ? input.degradedReason.trim()
        : null,
  };
}

export function commitSessionCompaction(
  deps: ContextCompactionDeps,
  sessionId: string,
  input: SessionCompactionCommitInput,
): BrewvaEventRecord {
  deps.markPressureCompacted(sessionId);

  const turn = deps.getCurrentTurn(sessionId);
  const rawSummary = input.sanitizedSummary.trim();
  const compactId = input.compactId.trim();

  let summary = rawSummary;
  let integrityViolations: string[] | null = null;
  let governanceSummary = "";
  let governanceViolations: string[] = [];
  const summaryGeneration = normalizeCompactionGenerationMetadata(input.summaryGeneration);
  const cacheImpact = normalizeCompactionCacheImpact(
    input.cacheImpact,
    providerCacheObservationSnapshot(deps.sessionState.getProviderCacheObservation(sessionId)),
  );
  if (rawSummary) {
    const integrity = validateCompactionSummary(rawSummary);
    if (!integrity.clean) {
      integrityViolations = integrity.violations;
      summary = sanitizeCompactionSummary(rawSummary);
      deps.recordEvent({
        sessionId,
        type: "compaction_integrity_violation",
        turn,
        payload: {
          violationCount: integrity.violations.length,
          violations: integrity.violations,
          originalChars: rawSummary.length,
          sanitizedChars: summary.trim().length,
        },
      });
    }
    governanceSummary = summary ?? "";
    governanceViolations = integrityViolations ?? [];
  }

  const event = deps.recordEvent({
    sessionId,
    type: SESSION_COMPACT_EVENT_TYPE,
    turn,
    payload: {
      compactId,
      sanitizedSummary: summary ?? "",
      summaryDigest: sha256Hex(summary ?? ""),
      sourceTurn: input.sourceTurn,
      leafEntryId: input.leafEntryId,
      referenceContextDigest: input.referenceContextDigest,
      fromTokens: input.fromTokens,
      toTokens: input.toTokens,
      origin: input.origin,
      integrityViolations: integrityViolations,
      ...(summaryGeneration ? { summaryGeneration } : {}),
      cacheImpact,
    },
  });
  if (!event) {
    throw new Error("failed to record session_compact receipt");
  }
  deps.commitWorkbenchBaseline?.(sessionId);

  deps.recordInfrastructureRow({
    sessionId,
    turn,
    skill: null,
    tool: "brewva_session_compaction",
    argsSummary: "session_compaction",
    outputSummary: `from=${input.fromTokens ?? "unknown"} to=${input.toTokens ?? "unknown"}`,
    fullOutput: JSON.stringify({
      compactId,
      sanitizedSummary: summary ?? "",
      summaryDigest: sha256Hex(summary ?? ""),
      fromTokens: input.fromTokens,
      toTokens: input.toTokens,
      ...(summaryGeneration ? { summaryGeneration } : {}),
      cacheImpact,
    }),
    verdict: "inconclusive",
    metadata: {
      source: "session_compact",
      compactId,
      sourceTurn: input.sourceTurn,
      leafEntryId: input.leafEntryId,
      referenceContextDigest: input.referenceContextDigest,
      fromTokens: input.fromTokens,
      toTokens: input.toTokens,
      summaryChars: summary?.length ?? null,
      integrityViolations: integrityViolations,
      ...(summaryGeneration ? { summaryGeneration } : {}),
      cacheImpact,
    },
  });

  const governancePort = deps.governancePort;
  if (!governancePort?.checkCompactionIntegrity || !governanceSummary) {
    return event;
  }
  const checkCompactionIntegrity = governancePort.checkCompactionIntegrity.bind(governancePort);

  void Promise.resolve()
    .then(() =>
      checkCompactionIntegrity({
        sessionId,
        summary: governanceSummary,
        violations: governanceViolations,
      }),
    )
    .then((result) => {
      deps.recordEvent({
        sessionId,
        type: result.ok
          ? GOVERNANCE_COMPACTION_INTEGRITY_CHECKED_EVENT_TYPE
          : GOVERNANCE_COMPACTION_INTEGRITY_FAILED_EVENT_TYPE,
        turn,
        payload: {
          ok: result.ok,
          reason: result.ok ? null : result.reason,
          violationCount: governanceViolations.length,
        },
      });
    })
    .catch((error) => {
      deps.recordEvent({
        sessionId,
        type: GOVERNANCE_COMPACTION_INTEGRITY_ERROR_EVENT_TYPE,
        turn,
        payload: {
          error: error instanceof Error ? error.message : String(error),
        },
      });
    });

  return event;
}
