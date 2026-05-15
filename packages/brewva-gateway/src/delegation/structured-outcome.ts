import { normalizeReviewLaneName } from "@brewva/brewva-runtime/skills";
import { normalizeStringList, readNonEmptyString } from "@brewva/brewva-std/text";
import { isRecord, readFiniteNumberValue } from "@brewva/brewva-std/unknown";
import type { BrewvaQuestionOption, BrewvaQuestionPrompt } from "@brewva/brewva-substrate/host-api";
import type {
  ExplorerConsultConfidence,
  ExplorerConsultKind,
  ExplorerDesignOption,
  ExplorerDesignSubagentOutcomeData,
  ExplorerDiagnoseHypothesis,
  ExplorerDiagnoseSubagentOutcomeData,
  ExplorerInvestigateSubagentOutcomeData,
  ExplorerReviewSubagentOutcomeData,
  DelegatedQuestionRequest,
  DelegationOutcomeChange,
  DelegationOutcomeFinding,
  EvidenceSubagentOutcomeData,
  KnowledgeSubagentOutcomeData,
  PatchSubagentOutcomeData,
  VerifierCheck,
  VerifierSubagentOutcomeData,
  SubagentOutcomeData,
  SubagentResultMode,
} from "@brewva/brewva-tools/contracts";
import { STRUCTURED_OUTCOME_CLOSE, STRUCTURED_OUTCOME_OPEN } from "./protocol.js";

function readString(value: unknown): string | undefined {
  return readNonEmptyString(value);
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function readStringArray(value: unknown): string[] | undefined {
  const items = normalizeStringList(value);
  return items.length > 0 ? items : undefined;
}

function readCanonicalStringArray(
  payload: Record<string, unknown>,
  canonicalKey: string,
  legacyKeys: readonly string[] = [],
): string[] | undefined {
  if (Object.prototype.hasOwnProperty.call(payload, canonicalKey)) {
    return readStringArray(payload[canonicalKey]);
  }
  for (const key of legacyKeys) {
    if (Object.prototype.hasOwnProperty.call(payload, key)) {
      return readStringArray(payload[key]);
    }
  }
  return undefined;
}

function readQuestionOption(value: unknown): BrewvaQuestionOption | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const label = readString(value.label);
  if (!label) {
    return undefined;
  }
  const description = readString(value.description);
  return description ? { label, description } : { label };
}

function readQuestionPrompt(value: unknown): BrewvaQuestionPrompt | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const header = readString(value.header);
  const question = readString(value.question);
  if (!header || !question) {
    return undefined;
  }
  const options = Array.isArray(value.options)
    ? value.options
        .map((entry) => readQuestionOption(entry))
        .filter((entry): entry is BrewvaQuestionOption => Boolean(entry))
    : [];
  const custom = readBoolean(value.custom);
  if (options.length === 0 && custom !== true) {
    return undefined;
  }
  return {
    header,
    question,
    options,
    ...(readBoolean(value.multiple) === true ? { multiple: true } : {}),
    ...(custom !== undefined ? { custom } : {}),
  };
}

function readQuestionRequest(value: unknown): DelegatedQuestionRequest | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const questions = Array.isArray(value.questions)
    ? value.questions
        .map((entry) => readQuestionPrompt(entry))
        .filter((entry): entry is BrewvaQuestionPrompt => Boolean(entry))
    : [];
  if (questions.length === 0) {
    return undefined;
  }
  const title = readString(value.title);
  return title ? { title, questions } : { questions };
}

function readQuestionRequests(value: unknown): DelegatedQuestionRequest[] | undefined {
  const requests = (Array.isArray(value) ? value : isRecord(value) ? [value] : [])
    .map((entry) => readQuestionRequest(entry))
    .filter((entry): entry is DelegatedQuestionRequest => Boolean(entry));
  return requests.length > 0 ? requests : undefined;
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

function readFindings(value: unknown): DelegationOutcomeFinding[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const findings = value
    .map((entry) => readFinding(entry))
    .filter((entry): entry is DelegationOutcomeFinding => Boolean(entry));
  return findings.length > 0 ? findings : undefined;
}

function readVerifierCheck(value: unknown): VerifierCheck | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const name = readString(value.name);
  const status = readString(value.status);
  const command = readString(value.command);
  const tool = readString(value.tool);
  const observedOutput = readString(value.observed_output);
  if (!name || (status !== "pass" && status !== "fail" && status !== "inconclusive")) {
    return undefined;
  }
  if (!observedOutput) {
    return undefined;
  }
  const base = {
    name,
    status,
    cwd: readString(value.cwd),
    expected: readString(value.expected),
    observed_output: observedOutput,
    probe_type: readString(value.probe_type),
    summary: readString(value.summary),
    evidence_refs: readStringArray(value.evidence_refs),
  } satisfies Omit<VerifierCheck, "command" | "exit_code" | "tool">;
  if (command) {
    const exitCode = readFiniteNumberValue(value.exit_code);
    if (exitCode === undefined) {
      return undefined;
    }
    return {
      ...base,
      command,
      exit_code: exitCode,
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

function isAdversarialVerifierCheck(check: VerifierCheck): boolean {
  const probeType = readString(check.probe_type)?.toLowerCase();
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

function normalizeVerifierOutcomeData(
  data: VerifierSubagentOutcomeData,
): VerifierSubagentOutcomeData {
  const failedChecks = data.checks.filter((check) => check.status === "fail");
  const inconclusiveChecks = data.checks.filter((check) => check.status === "inconclusive");
  const hasExecutableEvidence = data.checks.length > 0;
  const hasAdversarialProbe = data.checks.some(isAdversarialVerifierCheck);
  let verdict = data.verdict;
  let missingEvidence = data.missing_evidence;
  let confidenceGaps = data.confidence_gaps;
  const environmentLimits = data.environment_limits;

  if (verdict === "pass" && failedChecks.length > 0) {
    verdict = "fail";
  }

  if (verdict === "pass") {
    if (!hasExecutableEvidence) {
      confidenceGaps = appendUnique(
        confidenceGaps,
        "No executable Verifier check was captured for a pass verdict.",
      );
    }
    if (!hasAdversarialProbe) {
      confidenceGaps = appendUnique(
        confidenceGaps,
        "No adversarial Verifier probe was captured for a pass verdict.",
      );
    }
    if (inconclusiveChecks.length > 0) {
      confidenceGaps = appendUnique(
        confidenceGaps,
        "At least one Verifier check remained inconclusive, so the verdict cannot stay pass.",
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
      "The Verifier verdict was fail, but no failed verifier_check was captured.",
    );
  }

  return {
    kind: "verifier",
    verdict,
    checks: data.checks,
    ...(missingEvidence?.length ? { missing_evidence: missingEvidence } : {}),
    ...(confidenceGaps?.length ? { confidence_gaps: confidenceGaps } : {}),
    ...(environmentLimits?.length ? { environment_limits: environmentLimits } : {}),
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

function readConsultConfidence(value: unknown): ExplorerConsultConfidence | undefined {
  const confidence = readString(value);
  return confidence === "low" || confidence === "medium" || confidence === "high"
    ? confidence
    : undefined;
}

function readConsultKind(value: unknown): ExplorerConsultKind | undefined {
  return value === "investigate" || value === "diagnose" || value === "design" || value === "review"
    ? value
    : undefined;
}

function readBaseConsultPayload(payload: Record<string, unknown>) {
  const conclusion = readString(payload.conclusion);
  if (!conclusion) {
    return undefined;
  }
  return {
    kind: "consult" as const,
    conclusion,
    confidence: readConsultConfidence(payload.confidence),
    evidence: readStringArray(payload.evidence),
    counterevidence: readStringArray(payload.counterevidence),
    risks: readStringArray(payload.risks),
    followUpQuestions: readCanonicalStringArray(payload, "followUpQuestions", [
      "openQuestions",
      "open_questions",
    ]),
    questionRequests: readQuestionRequests(payload.questionRequests),
    recommendedNextSteps: readStringArray(payload.recommendedNextSteps),
  };
}

function readDiagnoseHypothesis(value: unknown): ExplorerDiagnoseHypothesis | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const hypothesis = readString(value.hypothesis);
  if (!hypothesis) {
    return undefined;
  }
  return {
    hypothesis,
    likelihood: readConsultConfidence(value.likelihood),
    evidence: readStringArray(value.evidence),
    gaps: readStringArray(value.gaps),
  };
}

function readDesignOption(value: unknown): ExplorerDesignOption | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const option = readString(value.option);
  const summary = readString(value.summary);
  if (!option || !summary) {
    return undefined;
  }
  return {
    option,
    summary,
    tradeoffs: readStringArray(value.tradeoffs),
  };
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

function parseConsultOutcomeData(
  consultKind: ExplorerConsultKind | undefined,
  payload: Record<string, unknown>,
): SubagentOutcomeData | undefined {
  const payloadConsultKind = readConsultKind(payload.consultKind);
  const resolvedConsultKind = consultKind ?? payloadConsultKind;
  if (!resolvedConsultKind || (payloadConsultKind && payloadConsultKind !== resolvedConsultKind)) {
    return undefined;
  }
  const base = readBaseConsultPayload(payload);
  if (!base) {
    return undefined;
  }

  if (resolvedConsultKind === "investigate") {
    return {
      ...base,
      consultKind: "investigate",
      findings: readFindings(payload.findings),
      ownershipHints: readStringArray(payload.ownershipHints),
      recommendedReads: readStringArray(payload.recommendedReads),
    } satisfies ExplorerInvestigateSubagentOutcomeData;
  }

  if (resolvedConsultKind === "diagnose") {
    const rawHypotheses = Array.isArray(payload.hypotheses) ? payload.hypotheses : [];
    const hypotheses = rawHypotheses
      .map((entry) => readDiagnoseHypothesis(entry))
      .filter((entry): entry is ExplorerDiagnoseHypothesis => Boolean(entry));
    const likelyRootCause = readString(payload.likelyRootCause);
    const nextProbe = readString(payload.nextProbe);
    if (hypotheses.length === 0 || !likelyRootCause || !nextProbe) {
      return undefined;
    }
    return {
      ...base,
      consultKind: "diagnose",
      hypotheses,
      likelyRootCause,
      nextProbe,
    } satisfies ExplorerDiagnoseSubagentOutcomeData;
  }

  if (resolvedConsultKind === "design") {
    const rawOptions = Array.isArray(payload.options) ? payload.options : [];
    const options = rawOptions
      .map((entry) => readDesignOption(entry))
      .filter((entry): entry is ExplorerDesignOption => Boolean(entry));
    const recommendedOption = readString(payload.recommendedOption);
    const boundaryImplications = readStringArray(payload.boundaryImplications);
    const verificationPlan = readStringArray(payload.verificationPlan);
    if (options.length === 0 || !recommendedOption || !boundaryImplications || !verificationPlan) {
      return undefined;
    }
    return {
      ...base,
      consultKind: "design",
      options,
      recommendedOption,
      boundaryImplications,
      verificationPlan,
    } satisfies ExplorerDesignSubagentOutcomeData;
  }

  const disposition = readString(payload.disposition);
  const mergePosture = readString(payload.mergePosture);
  const lane = normalizeReviewLaneName(payload.lane);
  const primaryClaim = readString(payload.primaryClaim);
  const strongestCounterpoint = readString(payload.strongestCounterpoint);
  const missingEvidence = readStringArray(payload.missingEvidence);
  const findings = readFindings(payload.findings);
  const followUpQuestions = base.followUpQuestions;
  const questionRequests = base.questionRequests;
  if (
    !lane &&
    disposition !== "clear" &&
    disposition !== "concern" &&
    disposition !== "blocked" &&
    disposition !== "inconclusive" &&
    !primaryClaim &&
    !strongestCounterpoint &&
    !followUpQuestions &&
    !questionRequests &&
    !missingEvidence &&
    !(findings && findings.length > 0)
  ) {
    return undefined;
  }
  return {
    ...base,
    consultKind: "review",
    ...(lane ? { lane } : {}),
    ...(disposition === "clear" ||
    disposition === "concern" ||
    disposition === "blocked" ||
    disposition === "inconclusive"
      ? { disposition }
      : {}),
    ...(mergePosture === "ready" ||
    mergePosture === "needs_changes" ||
    mergePosture === "blocked" ||
    mergePosture === "inconclusive"
      ? { mergePosture }
      : {}),
    ...(primaryClaim ? { primaryClaim } : {}),
    ...(findings ? { findings } : {}),
    ...(strongestCounterpoint ? { strongestCounterpoint } : {}),
    ...(missingEvidence ? { missingEvidence } : {}),
  } satisfies ExplorerReviewSubagentOutcomeData;
}

function parseEvidenceOutcomeData(
  payload: Record<string, unknown>,
): EvidenceSubagentOutcomeData | undefined {
  const prohibitedConsultFields = [
    "conclusion",
    "recommendedNextSteps",
    "options",
    "hypotheses",
    "risks",
    "recommendedOption",
    "likelyRootCause",
  ];
  if (
    prohibitedConsultFields.some((field) => Object.prototype.hasOwnProperty.call(payload, field))
  ) {
    return undefined;
  }
  const summary = readString(payload.summary);
  const sourceRefs = readStringArray(payload.sourceRefs);
  if (!summary || !sourceRefs || sourceRefs.length === 0) {
    return undefined;
  }
  return {
    kind: "evidence",
    summary,
    sourceRefs,
    recommendedReads: readStringArray(payload.recommendedReads),
    ownershipHints: readStringArray(payload.ownershipHints),
    missingEvidence: readStringArray(payload.missingEvidence),
  };
}

function parseKnowledgeOutcomeData(
  payload: Record<string, unknown>,
): KnowledgeSubagentOutcomeData | undefined {
  const summary = readString(payload.summary);
  const provenance = readStringArray(payload.provenance);
  const proposedDestination = readString(payload.proposedDestination);
  if (!summary || !provenance || provenance.length === 0 || !proposedDestination) {
    return undefined;
  }
  return {
    kind: "knowledge",
    summary,
    provenance,
    proposedDestination,
    freshnessNotes: readStringArray(payload.freshnessNotes),
    conflictNotes: readStringArray(payload.conflictNotes),
    proposal: readString(payload.proposal),
  };
}

function parseOutcomeData(
  resultMode: SubagentResultMode,
  consultKind: ExplorerConsultKind | undefined,
  payload: unknown,
): SubagentOutcomeData | undefined {
  if (!isRecord(payload)) {
    return undefined;
  }
  const kind = readString(payload.kind);
  if (kind && kind !== resultMode) {
    return undefined;
  }

  if (resultMode === "consult") {
    return parseConsultOutcomeData(consultKind, payload);
  }

  if (resultMode === "evidence") {
    return parseEvidenceOutcomeData(payload);
  }

  if (resultMode === "knowledge") {
    return parseKnowledgeOutcomeData(payload);
  }

  if (resultMode === "verifier") {
    const rawChecks = Array.isArray(payload.checks) ? payload.checks : [];
    const checks = rawChecks
      .map((entry) => readVerifierCheck(entry))
      .filter((entry): entry is VerifierCheck => Boolean(entry));
    if (checks.length === 0) {
      return undefined;
    }
    const verdict = readString(payload.verdict);
    const invalidCheckCount = rawChecks.length - checks.length;
    const confidenceGaps = readStringArray(payload.confidence_gaps);
    return normalizeVerifierOutcomeData({
      kind: "verifier",
      checks,
      verdict:
        verdict === "pass" || verdict === "fail" || verdict === "inconclusive"
          ? verdict
          : "inconclusive",
      missing_evidence: readStringArray(payload.missing_evidence),
      confidence_gaps:
        invalidCheckCount > 0
          ? appendUnique(
              confidenceGaps,
              `${invalidCheckCount} verifier_check entr${invalidCheckCount === 1 ? "y was" : "ies were"} discarded because the canonical execution evidence contract was not satisfied.`,
            )
          : confidenceGaps,
      environment_limits: readStringArray(payload.environment_limits),
    } satisfies VerifierSubagentOutcomeData);
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
  if (data.kind === "consult") {
    return data.consultKind === "review"
      ? (data.primaryClaim ?? data.conclusion ?? data.findings?.[0]?.summary)
      : data.conclusion;
  }
  if (data.kind === "verifier") {
    return data.checks[0]?.summary ?? data.checks[0]?.name;
  }
  if (data.kind === "evidence" || data.kind === "knowledge") {
    return data.summary;
  }
  return data.patchSummary ?? data.changes?.[0]?.summary ?? data.changes?.[0]?.path;
}

export function extractStructuredOutcomeData(input: {
  resultMode: SubagentResultMode;
  consultKind?: ExplorerConsultKind;
  assistantText: string;
  skillName?: string;
}): {
  data?: SubagentOutcomeData;
  narrativeText: string;
  parseError?: string;
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
    };
  }
  const data = parseOutcomeData(input.resultMode, input.consultKind, parsed);
  if (!data) {
    return {
      narrativeText: normalized.narrativeText,
      parseError: "invalid_structured_outcome_payload",
    };
  }
  return {
    data,
    narrativeText: normalized.narrativeText,
  };
}
