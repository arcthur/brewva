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
import type {
  SessionCompactionCacheImpact,
  SessionCompactionCacheImpactSnapshot,
  SessionCompactionCommitInput,
  SessionCompactionGenerationMetadata,
} from "./types.js";

const GOVERNANCE_INTEGRITY_TIMEOUT_MS = 1_000;

export interface ContextCompactionDeps {
  governancePort?: GovernancePort;
  markPressureCompacted: RuntimeCallback<[sessionId: string]>;
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

function normalizeCompactionCacheImpact(
  input: SessionCompactionCacheImpact,
): SessionCompactionCacheImpact {
  return {
    before: normalizeCacheImpactSnapshot(input.before),
    after: normalizeCacheImpactSnapshot(input.after),
    explicitEpochChanges: Math.max(0, Math.trunc(input.explicitEpochChanges)),
    prefixBytesChanged:
      typeof input.prefixBytesChanged === "number" && Number.isFinite(input.prefixBytesChanged)
        ? Math.max(0, Math.trunc(input.prefixBytesChanged))
        : null,
    degradedReason:
      typeof input.degradedReason === "string" && input.degradedReason.trim().length > 0
        ? input.degradedReason.trim()
        : null,
  };
}

async function runGovernanceIntegrityBarrier(input: {
  deps: ContextCompactionDeps;
  sessionId: string;
  turn: number;
  summary: string;
  violations: readonly string[];
}): Promise<void> {
  const governancePort = input.deps.governancePort;
  if (!governancePort?.checkCompactionIntegrity || !input.summary) {
    return;
  }

  const checkCompactionIntegrity = governancePort.checkCompactionIntegrity.bind(governancePort);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      checkCompactionIntegrity({
        sessionId: input.sessionId,
        summary: input.summary,
        violations: [...input.violations],
      }),
      new Promise<"timeout">((resolveTimeout) => {
        timeout = setTimeout(() => resolveTimeout("timeout"), GOVERNANCE_INTEGRITY_TIMEOUT_MS);
      }),
    ]);

    if (result === "timeout") {
      input.deps.recordEvent({
        sessionId: input.sessionId,
        type: GOVERNANCE_COMPACTION_INTEGRITY_ERROR_EVENT_TYPE,
        turn: input.turn,
        payload: {
          error: `compaction integrity check timed out after ${GOVERNANCE_INTEGRITY_TIMEOUT_MS}ms`,
        },
      });
      return;
    }

    input.deps.recordEvent({
      sessionId: input.sessionId,
      type: result.ok
        ? GOVERNANCE_COMPACTION_INTEGRITY_CHECKED_EVENT_TYPE
        : GOVERNANCE_COMPACTION_INTEGRITY_FAILED_EVENT_TYPE,
      turn: input.turn,
      payload: {
        ok: result.ok,
        reason: result.ok ? null : result.reason,
        violationCount: input.violations.length,
      },
    });
  } catch (error) {
    input.deps.recordEvent({
      sessionId: input.sessionId,
      type: GOVERNANCE_COMPACTION_INTEGRITY_ERROR_EVENT_TYPE,
      turn: input.turn,
      payload: {
        error: error instanceof Error ? error.message : String(error),
      },
    });
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

export async function commitSessionCompaction(
  deps: ContextCompactionDeps,
  sessionId: string,
  input: SessionCompactionCommitInput,
): Promise<BrewvaEventRecord> {
  deps.markPressureCompacted(sessionId);

  const turn = deps.getCurrentTurn(sessionId);
  const rawSummary = input.sanitizedSummary.trim();
  const compactId = input.compactId.trim();

  let summary = rawSummary;
  let integrityViolations: string[] | null = null;
  let governanceSummary = "";
  let governanceViolations: string[] = [];
  const summaryGeneration = normalizeCompactionGenerationMetadata(input.summaryGeneration);
  const cacheImpact = normalizeCompactionCacheImpact(input.cacheImpact);
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
      ...(input.firstKeptEntryId !== undefined ? { firstKeptEntryId: input.firstKeptEntryId } : {}),
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
  await runGovernanceIntegrityBarrier({
    deps,
    sessionId,
    turn,
    summary: governanceSummary,
    violations: governanceViolations,
  });

  return event;
}
