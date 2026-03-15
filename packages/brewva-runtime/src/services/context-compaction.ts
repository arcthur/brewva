import {
  GOVERNANCE_COMPACTION_INTEGRITY_CHECKED_EVENT_TYPE,
  GOVERNANCE_COMPACTION_INTEGRITY_ERROR_EVENT_TYPE,
  GOVERNANCE_COMPACTION_INTEGRITY_FAILED_EVENT_TYPE,
} from "../events/event-types.js";
import type { GovernancePort } from "../governance/port.js";
import {
  sanitizeCompactionSummary,
  validateCompactionSummary,
} from "../security/compaction-integrity.js";
import type { BrewvaEventRecord, SkillDocument } from "../types.js";
import type { RuntimeCallback } from "./callback.js";
import type { RuntimeSessionStateStore } from "./session-state.js";

export interface ContextCompactionInput {
  fromTokens?: number | null;
  toTokens?: number | null;
  summary?: string;
  entryId?: string;
}

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
        payload?: Record<string, unknown>;
        timestamp?: number;
        skipTapeCheckpoint?: boolean;
      },
    ],
    BrewvaEventRecord | undefined
  >;
}

export function markContextCompacted(
  deps: ContextCompactionDeps,
  sessionId: string,
  input: ContextCompactionInput,
): void {
  deps.markPressureCompacted(sessionId);
  deps.markInjectionCompacted(sessionId);
  deps.sessionState.clearInjectionFingerprintsForSession(sessionId);
  deps.sessionState.clearReservedInjectionTokensForSession(sessionId);

  const turn = deps.getCurrentTurn(sessionId);
  const rawSummary = input.summary?.trim();
  const entryId = input.entryId?.trim();

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

  deps.recordEvent({
    sessionId,
    type: "context_compacted",
    turn,
    payload: {
      fromTokens: input.fromTokens ?? null,
      toTokens: input.toTokens ?? null,
      entryId: entryId ?? null,
      summaryChars: summary?.length ?? null,
      integrityViolations: integrityViolations,
    },
  });

  deps.recordInfrastructureRow({
    sessionId,
    turn,
    skill: deps.getActiveSkill(sessionId)?.name ?? null,
    tool: "brewva_context_compaction",
    argsSummary: "context_compaction",
    outputSummary: `from=${input.fromTokens ?? "unknown"} to=${input.toTokens ?? "unknown"}`,
    fullOutput: JSON.stringify({
      fromTokens: input.fromTokens ?? null,
      toTokens: input.toTokens ?? null,
    }),
    verdict: "inconclusive",
    metadata: {
      source: "context_budget",
      fromTokens: input.fromTokens ?? null,
      toTokens: input.toTokens ?? null,
      entryId: entryId ?? null,
      summaryChars: summary?.length ?? null,
      integrityViolations: integrityViolations,
    },
  });

  const governancePort = deps.governancePort;
  if (!governancePort?.checkCompactionIntegrity || !governanceSummary) return;
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
          reason: result.reason ?? null,
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
}
