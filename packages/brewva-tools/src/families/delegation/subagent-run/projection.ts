import type {
  SubagentOutcome,
  SubagentRunResult,
  SubagentStartResult,
} from "../../../contracts/index.js";

const PUBLIC_RESULT_DETAIL_FORBIDDEN_KEYS: ReadonlySet<string> = new Set([
  "agentSpec",
  "envelope",
  "skillName",
  "consultKind",
  "fallbackResultMode",
  "executionShape",
  "workerSessionId",
  "modelRoute",
  "lane",
  "reviewLane",
] as const);

function sanitizePublicResultData(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizePublicResultData(entry));
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !PUBLIC_RESULT_DETAIL_FORBIDDEN_KEYS.has(key))
      .map(([key, entry]) => [key, sanitizePublicResultData(entry)]),
  );
}

function projectSubagentOutcomeForPublicDetails(
  outcome: SubagentOutcome,
  delegate: string,
): Record<string, unknown> {
  if (!outcome.ok) {
    return Object.fromEntries(
      Object.entries({
        ok: outcome.ok,
        runId: outcome.runId,
        delegate,
        label: outcome.label,
        status: outcome.status,
        error: outcome.error,
        metrics: outcome.metrics,
        artifactRefs: outcome.artifactRefs,
      }).filter(([, value]) => value !== undefined),
    );
  }
  return Object.fromEntries(
    Object.entries({
      ok: outcome.ok,
      runId: outcome.runId,
      delegate,
      label: outcome.label,
      kind: outcome.kind,
      status: outcome.status,
      summary: outcome.summary,
      data: sanitizePublicResultData(outcome.data),
      metrics: outcome.metrics,
      evidenceRefs: outcome.evidenceRefs,
      patches: outcome.patches,
      artifactRefs: outcome.artifactRefs,
    }).filter(([, value]) => value !== undefined),
  );
}

function projectRunRecordForPublicDetails(
  run: SubagentStartResult["runs"][number],
  delegate: string,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries({
      contractVersion: run.contractVersion,
      runId: run.runId,
      delegate,
      executionPrimitive: run.executionPrimitive,
      visibility: run.visibility,
      isolationStrategy: run.isolationStrategy,
      adoption: run.adoption,
      lineage: run.lineage,
      parentSessionId: run.parentSessionId,
      status: run.status,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      label: run.label,
      parentSkill: run.parentSkill,
      kind: run.kind,
      summary: run.summary,
      error: run.error,
      artifactRefs: run.artifactRefs,
      delivery: run.delivery,
      totalTokens: run.totalTokens,
      costUsd: run.costUsd,
    }).filter(([, value]) => value !== undefined),
  );
}

export function projectRunResultForPublicDetails(
  result: SubagentRunResult,
  delegate: string,
): Record<string, unknown> {
  return {
    ...result,
    delegate,
    outcomes: result.outcomes.map((outcome) =>
      projectSubagentOutcomeForPublicDetails(outcome, delegate),
    ),
  };
}

export function projectStartResultForPublicDetails(
  result: SubagentStartResult,
  delegate: string,
): Record<string, unknown> {
  return {
    ...result,
    delegate,
    runs: result.runs.map((run) => projectRunRecordForPublicDetails(run, delegate)),
  };
}
