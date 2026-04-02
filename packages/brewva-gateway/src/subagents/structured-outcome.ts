import {
  DESIGN_EXECUTION_MODE_HINTS,
  coerceDesignExecutionPlan,
  coerceDesignImplementationTargets,
  coerceDesignRiskRegister,
  normalizeReviewLaneName,
} from "@brewva/brewva-runtime";
import type {
  DelegationOutcomeChange,
  DelegationOutcomeFinding,
  PatchSubagentOutcomeData,
  PlanSubagentOutcomeData,
  QaCheck,
  QaSubagentOutcomeData,
  ReviewSubagentOutcomeData,
  SubagentOutcomeData,
  SubagentResultMode,
} from "@brewva/brewva-tools";
import { STRUCTURED_OUTCOME_CLOSE, STRUCTURED_OUTCOME_OPEN } from "./protocol.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const items = value
    .map((entry) => readString(entry))
    .filter((entry): entry is string => Boolean(entry));
  return items.length > 0 ? items : undefined;
}

function readObject(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? { ...value } : undefined;
}

function readFinding(value: unknown): DelegationOutcomeFinding | undefined {
  if (typeof value === "string") {
    const summary = readString(value);
    return summary ? { summary } : undefined;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  const summary = readString(value.summary) ?? readString(value.title);
  if (!summary) {
    return undefined;
  }
  const severity = readString(value.severity);
  return {
    summary,
    severity:
      severity === "critical" || severity === "high" || severity === "medium" || severity === "low"
        ? severity
        : undefined,
    evidenceRefs: readStringArray(value.evidenceRefs),
  };
}

function readQaCheck(value: unknown): QaCheck | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const name = readString(value.name);
  const result = readString(value.result);
  const command = readString(value.command);
  const tool = readString(value.tool);
  const observedOutput = readString(value.observedOutput);
  if (!name || (result !== "pass" && result !== "fail" && result !== "inconclusive")) {
    return undefined;
  }
  if (!observedOutput) {
    return undefined;
  }
  const normalizedResult: QaCheck["result"] = result;
  const base = {
    name,
    result: normalizedResult,
    cwd: readString(value.cwd),
    expected: readString(value.expected),
    observedOutput,
    probeType: readString(value.probeType),
    summary: readString(value.summary),
    artifactRefs: readStringArray(value.artifactRefs),
  };
  if (command) {
    const exitCode =
      typeof value.exitCode === "number" && Number.isFinite(value.exitCode)
        ? value.exitCode
        : undefined;
    if (exitCode === undefined) {
      return undefined;
    }
    return {
      ...base,
      command,
      exitCode,
      ...(tool ? { tool } : {}),
    };
  }
  if (!tool) {
    return undefined;
  }
  return {
    ...base,
    tool,
  };
}

function appendUnique(values: string[] | undefined, message: string): string[] {
  const next = values ? [...values] : [];
  if (!next.includes(message)) {
    next.push(message);
  }
  return next;
}

function isAdversarialQaCheck(check: QaCheck): boolean {
  const probeType = readString(check.probeType)?.toLowerCase();
  if (!probeType) {
    return false;
  }
  return (
    probeType === "adversarial" ||
    probeType === "boundary" ||
    probeType === "edge" ||
    probeType === "negative" ||
    probeType === "concurrency" ||
    probeType === "idempotency" ||
    probeType === "orphan" ||
    probeType === "race" ||
    probeType === "stress" ||
    probeType === "fuzz"
  );
}

function normalizeQaOutcomeData(data: QaSubagentOutcomeData): QaSubagentOutcomeData {
  const failedChecks = data.checks.filter((check) => check.result === "fail");
  const inconclusiveChecks = data.checks.filter((check) => check.result === "inconclusive");
  const hasExecutableEvidence = data.checks.length > 0;
  const hasAdversarialProbe = data.checks.some(isAdversarialQaCheck);
  let verdict = data.verdict;
  let missingEvidence = data.missingEvidence;
  let confidenceGaps = data.confidenceGaps;
  const environmentLimits = data.environmentLimits;

  if (verdict === "pass" && failedChecks.length > 0) {
    verdict = "fail";
  }

  if (verdict === "pass") {
    if (!hasExecutableEvidence) {
      confidenceGaps = appendUnique(
        confidenceGaps,
        "No executable QA check was captured for a pass verdict.",
      );
    }
    if (!hasAdversarialProbe) {
      confidenceGaps = appendUnique(
        confidenceGaps,
        "No adversarial QA probe was captured for a pass verdict.",
      );
    }
    if (inconclusiveChecks.length > 0) {
      confidenceGaps = appendUnique(
        confidenceGaps,
        "At least one QA check remained inconclusive, so the verdict cannot stay pass.",
      );
    }
    if (
      (missingEvidence?.length ?? 0) > 0 ||
      (confidenceGaps?.length ?? 0) > 0 ||
      (environmentLimits?.length ?? 0) > 0
    ) {
      verdict = "inconclusive";
    }
  }

  if (verdict === "fail" && failedChecks.length === 0) {
    verdict = "inconclusive";
    confidenceGaps = appendUnique(
      confidenceGaps,
      "The QA verdict was fail, but no failed qa_check was captured.",
    );
  }

  return {
    kind: "qa",
    verdict,
    checks: data.checks,
    ...(missingEvidence && missingEvidence.length > 0 ? { missingEvidence } : {}),
    ...(confidenceGaps && confidenceGaps.length > 0 ? { confidenceGaps } : {}),
    ...(environmentLimits && environmentLimits.length > 0 ? { environmentLimits } : {}),
  };
}

function buildQaSkillOutputs(
  data: QaSubagentOutcomeData,
  narrativeText: string,
  existing: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const report =
    readString(existing?.qa_report) ??
    readString(narrativeText) ??
    summarizeStructuredOutcomeData(data) ??
    `QA finished with verdict ${data.verdict}.`;
  return {
    ...existing,
    qa_report: report,
    qa_findings:
      Array.isArray(existing?.qa_findings) && existing.qa_findings.length > 0
        ? existing.qa_findings
        : data.checks
            .filter((check) => check.result !== "pass")
            .map((check) => check.summary ?? check.name),
    qa_verdict: data.verdict,
    qa_checks: data.checks,
    qa_missing_evidence: data.missingEvidence ?? [],
    qa_confidence_gaps: data.confidenceGaps ?? [],
    qa_environment_limits: data.environmentLimits ?? [],
  };
}

function readChange(value: unknown): DelegationOutcomeChange | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const path = readString(value.path);
  const action = readString(value.action);
  if (!path) {
    return undefined;
  }
  return {
    path,
    action: action === "add" || action === "modify" || action === "delete" ? action : undefined,
    summary: readString(value.summary),
    evidenceRefs: readStringArray(value.evidenceRefs),
  };
}

function buildPlanSkillOutputs(
  data: PlanSubagentOutcomeData,
  existing: Record<string, unknown> | undefined,
): Record<string, unknown> {
  return {
    ...existing,
    design_spec: data.designSpec,
    execution_plan: data.executionPlan,
    execution_mode_hint: data.executionModeHint,
    risk_register: data.riskRegister,
    implementation_targets: data.implementationTargets,
  };
}

function readFindings(value: unknown): DelegationOutcomeFinding[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const findings = value
    .map((entry) => readFinding(entry))
    .filter((entry): entry is DelegationOutcomeFinding => Boolean(entry));
  return findings.length > 0 ? findings : undefined;
}

function readReviewDisposition(
  value: unknown,
): ReviewSubagentOutcomeData["disposition"] | undefined {
  const disposition = readString(value);
  return disposition === "clear" ||
    disposition === "concern" ||
    disposition === "blocked" ||
    disposition === "inconclusive"
    ? disposition
    : undefined;
}

function readReviewConfidence(value: unknown): ReviewSubagentOutcomeData["confidence"] | undefined {
  const confidence = readString(value);
  return confidence === "low" || confidence === "medium" || confidence === "high"
    ? confidence
    : undefined;
}

function normalizeJsonBlock(text: string): { rawJson?: string; narrativeText: string } {
  const start = text.indexOf(STRUCTURED_OUTCOME_OPEN);
  if (start < 0) {
    return { narrativeText: text.trim() };
  }
  const end = text.indexOf(STRUCTURED_OUTCOME_CLOSE, start + STRUCTURED_OUTCOME_OPEN.length);
  if (end < 0) {
    return { narrativeText: text.trim() };
  }
  const rawJson = text.slice(start + STRUCTURED_OUTCOME_OPEN.length, end).trim();
  const narrativeText =
    `${text.slice(0, start)} ${text.slice(end + STRUCTURED_OUTCOME_CLOSE.length)}`
      .replaceAll(/\n{3,}/g, "\n\n")
      .trim();
  return { rawJson, narrativeText };
}

function parseOutcomeData(
  resultMode: SubagentResultMode,
  payload: unknown,
): SubagentOutcomeData | undefined {
  if (!isRecord(payload)) {
    return undefined;
  }
  const kind = readString(payload.kind);
  if (kind && kind !== resultMode) {
    return undefined;
  }

  if (resultMode === "exploration") {
    return {
      kind: "exploration",
      findings: readFindings(payload.findings),
      openQuestions: readStringArray(payload.openQuestions),
      nextSteps: readStringArray(payload.nextSteps),
    };
  }

  if (resultMode === "plan") {
    const designSpec = readString(payload.designSpec);
    const executionModeHint = readString(payload.executionModeHint);
    const executionPlan = coerceDesignExecutionPlan(payload.executionPlan);
    const riskRegister = coerceDesignRiskRegister(payload.riskRegister);
    const implementationTargets = coerceDesignImplementationTargets(payload.implementationTargets);
    if (
      !designSpec ||
      !executionModeHint ||
      !DESIGN_EXECUTION_MODE_HINTS.includes(
        executionModeHint as (typeof DESIGN_EXECUTION_MODE_HINTS)[number],
      ) ||
      !executionPlan ||
      executionPlan.length === 0 ||
      !riskRegister ||
      riskRegister.length === 0 ||
      !implementationTargets ||
      implementationTargets.length === 0
    ) {
      return undefined;
    }
    const canonicalExecutionModeHint =
      executionModeHint as PlanSubagentOutcomeData["executionModeHint"];
    return {
      kind: "plan",
      designSpec,
      executionPlan,
      executionModeHint: canonicalExecutionModeHint,
      riskRegister,
      implementationTargets,
    } satisfies PlanSubagentOutcomeData;
  }

  if (resultMode === "review") {
    const findings = readFindings(payload.findings);
    const primaryClaim = readString(payload.primaryClaim);
    const strongestCounterpoint = readString(payload.strongestCounterpoint);
    const openQuestions = readStringArray(payload.openQuestions);
    const missingEvidence = readStringArray(payload.missingEvidence);
    const disposition = readReviewDisposition(payload.disposition);
    const confidence = readReviewConfidence(payload.confidence);
    const lane = normalizeReviewLaneName(payload.lane);
    if (
      !findings &&
      !primaryClaim &&
      !strongestCounterpoint &&
      !openQuestions &&
      !missingEvidence &&
      !disposition
    ) {
      return undefined;
    }
    return {
      kind: "review",
      ...(lane ? { lane } : {}),
      ...(disposition ? { disposition } : {}),
      ...(primaryClaim ? { primaryClaim } : {}),
      ...(findings ? { findings } : {}),
      ...(strongestCounterpoint ? { strongestCounterpoint } : {}),
      ...(openQuestions ? { openQuestions } : {}),
      ...(missingEvidence ? { missingEvidence } : {}),
      ...(confidence ? { confidence } : {}),
    } satisfies ReviewSubagentOutcomeData;
  }

  if (resultMode === "qa") {
    const rawChecks = Array.isArray(payload.checks) ? payload.checks : [];
    const checks = rawChecks
      .map((entry) => readQaCheck(entry))
      .filter((entry): entry is QaCheck => Boolean(entry));
    if (checks.length === 0) {
      return undefined;
    }
    const verdict = readString(payload.verdict);
    const invalidCheckCount = rawChecks.length - checks.length;
    const confidenceGaps = readStringArray(payload.confidenceGaps);
    return normalizeQaOutcomeData({
      kind: "qa",
      checks,
      verdict:
        verdict === "pass" || verdict === "fail" || verdict === "inconclusive"
          ? verdict
          : "inconclusive",
      missingEvidence: readStringArray(payload.missingEvidence),
      confidenceGaps:
        invalidCheckCount > 0
          ? appendUnique(
              confidenceGaps,
              `${invalidCheckCount} qa_check entr${invalidCheckCount === 1 ? "y was" : "ies were"} discarded because the canonical execution evidence contract was not satisfied.`,
            )
          : confidenceGaps,
      environmentLimits: readStringArray(payload.environmentLimits),
    } satisfies QaSubagentOutcomeData);
  }

  return {
    kind: "patch",
    changes: Array.isArray(payload.changes)
      ? payload.changes
          .map((entry) => readChange(entry))
          .filter((entry): entry is DelegationOutcomeChange => Boolean(entry))
      : undefined,
    patchSummary: readString(payload.patchSummary),
  } satisfies PatchSubagentOutcomeData;
}

export function summarizeStructuredOutcomeData(data: SubagentOutcomeData): string | undefined {
  if (data.kind === "exploration") {
    return data.findings?.[0]?.summary ?? data.openQuestions?.[0] ?? data.nextSteps?.[0];
  }
  if (data.kind === "plan") {
    return data.designSpec ?? data.executionPlan[0]?.step ?? data.implementationTargets[0]?.target;
  }
  if (data.kind === "review") {
    return data.primaryClaim ?? data.findings?.[0]?.summary ?? data.strongestCounterpoint;
  }
  if (data.kind === "qa") {
    return data.checks[0]?.summary ?? data.checks[0]?.name;
  }
  return data.patchSummary ?? data.changes?.[0]?.summary ?? data.changes?.[0]?.path;
}

export function extractStructuredOutcomeData(input: {
  resultMode: SubagentResultMode;
  assistantText: string;
  skillName?: string;
}): {
  data?: SubagentOutcomeData;
  narrativeText: string;
  parseError?: string;
  skillOutputs?: Record<string, unknown>;
} {
  const normalized = normalizeJsonBlock(input.assistantText);
  if (!normalized.rawJson) {
    return {
      narrativeText: normalized.narrativeText,
      parseError: "missing_structured_outcome_block",
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(normalized.rawJson);
  } catch (error) {
    return {
      narrativeText: normalized.narrativeText,
      parseError: error instanceof Error ? error.message : String(error),
    };
  }
  const parsedSkillName = isRecord(parsed) ? readString(parsed.skillName) : undefined;
  if (input.skillName && parsedSkillName && parsedSkillName !== input.skillName) {
    return {
      narrativeText: normalized.narrativeText,
      parseError: `unexpected_skill_name:${parsedSkillName}`,
      skillOutputs: isRecord(parsed) ? readObject(parsed.skillOutputs) : undefined,
    };
  }
  const data = parseOutcomeData(input.resultMode, parsed);
  const rawSkillOutputs = isRecord(parsed) ? readObject(parsed.skillOutputs) : undefined;
  if (!data) {
    return {
      narrativeText: normalized.narrativeText,
      parseError: "invalid_structured_outcome_payload",
      skillOutputs: rawSkillOutputs,
    };
  }
  const skillOutputs =
    input.skillName === "design" && data.kind === "plan"
      ? buildPlanSkillOutputs(data, rawSkillOutputs)
      : input.skillName === "qa" && data.kind === "qa"
        ? buildQaSkillOutputs(data, normalized.narrativeText, rawSkillOutputs)
        : rawSkillOutputs;
  return {
    data,
    narrativeText: normalized.narrativeText,
    skillOutputs,
  };
}
