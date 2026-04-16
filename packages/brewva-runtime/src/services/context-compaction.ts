import type {
  BrewvaEventRecord,
  SessionCompactionCommitInput,
  SkillDocument,
} from "../contracts/index.js";
import {
  GOVERNANCE_COMPACTION_INTEGRITY_CHECKED_EVENT_TYPE,
  GOVERNANCE_COMPACTION_INTEGRITY_ERROR_EVENT_TYPE,
  GOVERNANCE_COMPACTION_INTEGRITY_FAILED_EVENT_TYPE,
  SESSION_COMPACT_EVENT_TYPE,
} from "../events/event-types.js";
import type { GovernancePort } from "../governance/port.js";
import {
  sanitizeCompactionSummary,
  validateCompactionSummary,
} from "../security/compaction-integrity.js";
import { sha256 } from "../utils/hash.js";
import type { RuntimeCallback } from "./callback.js";
import type { RuntimeSessionStateStore } from "./session-state.js";

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
  markInjectionCompacted: RuntimeCallback<[sessionId: string]>;
  getCurrentTurn: RuntimeCallback<[sessionId: string], number>;
  getActiveSkill: RuntimeCallback<[sessionId: string], SkillDocument | undefined>;
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

export function commitSessionCompaction(
  deps: ContextCompactionDeps,
  sessionId: string,
  input: SessionCompactionCommitInput,
): BrewvaEventRecord {
  deps.markPressureCompacted(sessionId);
  deps.markInjectionCompacted(sessionId);
  deps.sessionState.clearInjectionFingerprintsForSession(sessionId);
  deps.sessionState.clearReservedInjectionTokensForSession(sessionId);

  const turn = deps.getCurrentTurn(sessionId);
  const rawSummary = input.sanitizedSummary.trim();
  const compactId = input.compactId.trim();

  let summary = rawSummary;
  let integrityViolations: string[] | null = null;
  let governanceSummary = "";
  let governanceViolations: string[] = [];
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
      summaryDigest: sha256(summary ?? ""),
      sourceTurn: input.sourceTurn,
      leafEntryId: input.leafEntryId,
      referenceContextDigest: input.referenceContextDigest,
      fromTokens: input.fromTokens,
      toTokens: input.toTokens,
      origin: input.origin,
      integrityViolations: integrityViolations,
    },
  });
  if (!event) {
    throw new Error("failed to record session_compact receipt");
  }

  deps.recordInfrastructureRow({
    sessionId,
    turn,
    skill: deps.getActiveSkill(sessionId)?.name ?? null,
    tool: "brewva_session_compaction",
    argsSummary: "session_compaction",
    outputSummary: `from=${input.fromTokens ?? "unknown"} to=${input.toTokens ?? "unknown"}`,
    fullOutput: JSON.stringify({
      compactId,
      sanitizedSummary: summary ?? "",
      summaryDigest: sha256(summary ?? ""),
      fromTokens: input.fromTokens,
      toTokens: input.toTokens,
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
