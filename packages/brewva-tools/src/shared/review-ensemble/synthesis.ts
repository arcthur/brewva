import { uniqueNonEmptyStrings as uniqueStrings } from "@brewva/brewva-std/collections";
import { normalizeStringList, readNonEmptyString as readString } from "@brewva/brewva-std/text";
import { isRecord } from "@brewva/brewva-std/unknown";
import type {
  ExplorerReviewSubagentOutcomeData,
  DelegationOutcomeFinding,
  DelegationRunRecord,
  ReviewLaneDisposition,
  ReviewLaneName,
  ReviewReportArtifact,
  SubagentOutcome,
} from "../../contracts/index.js";
import { normalizeReviewLaneName } from "../review-vocabulary.js";
import type {
  ReviewEnsembleSynthesis,
  ReviewEnsembleSynthesisInput,
  ReviewLaneOutcomeSummary,
  ReviewMergeDecision,
} from "./index.js";

const SEVERITY_RANK: Record<NonNullable<DelegationOutcomeFinding["severity"]>, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

function readStringArray(value: unknown): string[] | undefined {
  const items = normalizeStringList(value);
  return items.length > 0 ? items : undefined;
}

function normalizeSummaryKey(summary: string): string {
  return summary.trim().toLowerCase().replaceAll(/\s+/g, " ");
}

function formatLaneList(lanes: readonly ReviewLaneName[]): string {
  return lanes.join(", ");
}

function readStoredFinding(value: unknown): DelegationOutcomeFinding | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const summary = readString(value.summary);
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

function coerceStoredReviewOutcomeData(
  value: unknown,
): ExplorerReviewSubagentOutcomeData | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const kind = readString(value.kind);
  if (kind !== "consult" || readString(value.consultKind) !== "review") {
    return undefined;
  }
  const lane = normalizeReviewLaneName(value.lane);
  const disposition = readString(value.disposition);
  const primaryClaim = readString(value.primaryClaim);
  const strongestCounterpoint = readString(value.strongestCounterpoint);
  const followUpQuestions = readStringArray(value.followUpQuestions);
  const missingEvidence = readStringArray(value.missingEvidence);
  const confidence = readString(value.confidence);
  const findings = Array.isArray(value.findings)
    ? value.findings
        .map((entry) => readStoredFinding(entry))
        .filter((entry): entry is DelegationOutcomeFinding => Boolean(entry))
    : undefined;
  if (
    !lane &&
    disposition !== "clear" &&
    disposition !== "concern" &&
    disposition !== "blocked" &&
    disposition !== "inconclusive" &&
    !primaryClaim &&
    !strongestCounterpoint &&
    !followUpQuestions &&
    !missingEvidence &&
    !(findings && findings.length > 0)
  ) {
    return undefined;
  }
  return {
    kind: "consult",
    consultKind: "review",
    conclusion:
      primaryClaim ??
      findings?.[0]?.summary ??
      strongestCounterpoint ??
      "Review consult completed without a primary claim.",
    ...(lane ? { lane } : {}),
    ...(disposition === "clear" ||
    disposition === "concern" ||
    disposition === "blocked" ||
    disposition === "inconclusive"
      ? { disposition }
      : {}),
    ...(primaryClaim ? { primaryClaim } : {}),
    ...(findings && findings.length > 0 ? { findings } : {}),
    ...(strongestCounterpoint ? { strongestCounterpoint } : {}),
    ...(followUpQuestions ? { followUpQuestions } : {}),
    ...(missingEvidence ? { missingEvidence } : {}),
    ...(confidence === "low" || confidence === "medium" || confidence === "high"
      ? { confidence }
      : {}),
  };
}

function compareFindingSeverity(
  left: DelegationOutcomeFinding,
  right: DelegationOutcomeFinding,
): number {
  const leftRank = left.severity ? SEVERITY_RANK[left.severity] : Number.MAX_SAFE_INTEGER;
  const rightRank = right.severity ? SEVERITY_RANK[right.severity] : Number.MAX_SAFE_INTEGER;
  if (leftRank !== rightRank) {
    return leftRank - rightRank;
  }
  return left.summary.localeCompare(right.summary);
}

function dedupeFindings(findings: readonly DelegationOutcomeFinding[]): DelegationOutcomeFinding[] {
  const bySummary = new Map<string, DelegationOutcomeFinding>();
  for (const finding of findings) {
    const key = normalizeSummaryKey(finding.summary);
    const existing = bySummary.get(key);
    if (!existing || compareFindingSeverity(finding, existing) < 0) {
      bySummary.set(key, {
        summary: finding.summary,
        severity: finding.severity,
        evidenceRefs: finding.evidenceRefs ? [...finding.evidenceRefs] : undefined,
      });
      continue;
    }
    if (existing.evidenceRefs || finding.evidenceRefs) {
      existing.evidenceRefs = uniqueStrings([
        ...(existing.evidenceRefs ?? []),
        ...(finding.evidenceRefs ?? []),
      ]);
    }
  }
  return [...bySummary.values()].toSorted(compareFindingSeverity);
}

function readReviewOutcomeData(
  outcome: SubagentOutcome,
): ExplorerReviewSubagentOutcomeData | undefined {
  return outcome.ok ? coerceStoredReviewOutcomeData(outcome.data) : undefined;
}

function inferLaneFromOutcome(outcome: SubagentOutcome): ReviewLaneName | undefined {
  return (
    normalizeReviewLaneName(readReviewOutcomeData(outcome)?.lane) ??
    normalizeReviewLaneName(outcome.label) ??
    normalizeReviewLaneName(outcome.delegate) ??
    normalizeReviewLaneName(outcome.agentSpec)
  );
}

function coerceDisposition(
  outcome: SubagentOutcome,
  data: ExplorerReviewSubagentOutcomeData | undefined,
): ReviewLaneDisposition {
  if (!outcome.ok) {
    return "blocked";
  }
  if (!data) {
    return "blocked";
  }
  if (data?.disposition) {
    return data.disposition;
  }
  if ((data?.findings?.length ?? 0) > 0) {
    return "concern";
  }
  if ((data?.missingEvidence?.length ?? 0) > 0) {
    return "inconclusive";
  }
  return "clear";
}

function buildLaneSummary(
  outcome: SubagentOutcome,
  data: ExplorerReviewSubagentOutcomeData | undefined,
): string | undefined {
  if (!outcome.ok) {
    return outcome.error;
  }
  return data?.primaryClaim ?? outcome.summary;
}

function summarizeReviewDecision(input: {
  mergeDecision: ReviewMergeDecision;
  findings: readonly DelegationOutcomeFinding[];
  blockedReasons: readonly string[];
  activatedLanes: readonly ReviewLaneName[];
}): string {
  if (input.mergeDecision === "blocked") {
    const reason = input.blockedReasons[0] ?? "not all activated lanes established merge safety";
    return `Review ensemble is blocked because ${reason}. Activated lanes: ${formatLaneList(input.activatedLanes)}.`;
  }
  if (input.mergeDecision === "needs_changes") {
    return `Review ensemble found material issues in ${input.findings.length} finding(s) across the activated lanes.`;
  }
  return `Review ensemble cleared the activated lanes without material findings or blocking evidence gaps.`;
}

function coercePublicAgent(agent: string): NonNullable<SubagentOutcome["agent"]> {
  if (
    agent === "navigator" ||
    agent === "explorer" ||
    agent === "worker" ||
    agent === "verifier" ||
    agent === "librarian"
  ) {
    return agent;
  }
  return "explorer";
}

export function materializeReviewLaneOutcomes(
  runs: readonly DelegationRunRecord[],
): SubagentOutcome[] {
  return runs
    .filter((run) => run.kind === "consult" && run.consultKind === "review")
    .map((run) => {
      const artifactRefs = run.artifactRefs?.map((ref) => ({
        kind: ref.kind ?? "artifact",
        path: ref.path,
        summary: ref.summary ?? undefined,
      }));
      const metrics = {
        durationMs: Math.max(0, run.updatedAt - run.createdAt),
        ...(typeof run.totalTokens === "number" ? { totalTokens: run.totalTokens } : {}),
        ...(typeof run.costUsd === "number" ? { costUsd: run.costUsd } : {}),
      };
      const agent = coercePublicAgent(run.agent);

      if (run.status === "completed") {
        return {
          ok: true,
          runId: run.runId,
          agent,
          taskName: run.taskName,
          taskPath: run.taskPath,
          nickname: run.nickname ?? run.label ?? run.runId,
          delegate: run.delegate,
          agentSpec: run.agentSpec,
          envelope: run.envelope,
          skillName: run.skillName,
          label: run.label,
          kind: "consult",
          consultKind: "review",
          status: "ok",
          workerSessionId: run.workerSessionId,
          summary: run.summary ?? "Delegated review lane completed.",
          data: coerceStoredReviewOutcomeData(run.resultData),
          metrics,
          evidenceRefs: [],
          artifactRefs,
        } satisfies SubagentOutcome;
      }

      const status = run.status === "cancelled" ? run.status : "error";
      return {
        ok: false,
        runId: run.runId,
        agent,
        taskName: run.taskName,
        taskPath: run.taskPath,
        nickname: run.nickname ?? run.label ?? run.runId,
        delegate: run.delegate,
        agentSpec: run.agentSpec,
        envelope: run.envelope,
        skillName: run.skillName,
        label: run.label,
        consultKind: run.consultKind,
        status,
        workerSessionId: run.workerSessionId,
        error: run.error ?? run.summary ?? `delegation run ended with status ${run.status}`,
        metrics,
        artifactRefs,
      } satisfies SubagentOutcome;
    });
}

export function synthesizeReviewEnsemble(
  input: ReviewEnsembleSynthesisInput,
): ReviewEnsembleSynthesis {
  const findings: DelegationOutcomeFinding[] = [];
  const residualBlindSpots: string[] = [];
  const missingEvidence = [...input.activationPlan.missingEvidence];
  const laneDisagreements: string[] = [];
  const blockedReasons: string[] = [];
  const laneOutcomes: ReviewLaneOutcomeSummary[] = [];
  const outcomesByLane = new Map<ReviewLaneName, SubagentOutcome[]>();

  for (const outcome of input.outcomes) {
    const lane = inferLaneFromOutcome(outcome);
    if (!lane) {
      continue;
    }
    const bucket = outcomesByLane.get(lane) ?? [];
    bucket.push(outcome);
    outcomesByLane.set(lane, bucket);
  }

  for (const lane of input.activationPlan.activatedLanes) {
    const laneResults = outcomesByLane.get(lane) ?? [];
    if (laneResults.length === 0) {
      laneOutcomes.push({
        lane,
        status: "missing",
        disposition: "blocked",
      });
      const reason = `activated lane ${lane} produced no delegated outcome`;
      residualBlindSpots.push(`Lane ${lane} produced no delegated outcome.`);
      blockedReasons.push(reason);
      continue;
    }
    if (laneResults.length > 1) {
      laneDisagreements.push(
        `Lane ${lane} produced multiple delegated outcomes; using the first result.`,
      );
    }

    const outcome = laneResults[0]!;
    const data = readReviewOutcomeData(outcome);
    const disposition = coerceDisposition(outcome, data);
    const summary = buildLaneSummary(outcome, data);
    laneOutcomes.push({
      lane,
      status: outcome.status,
      disposition,
      ...(summary ? { summary } : {}),
    });

    if (!outcome.ok) {
      const blindSpot = `Lane ${lane} failed with status ${outcome.status}: ${outcome.error}`;
      residualBlindSpots.push(blindSpot);
      blockedReasons.push(`lane ${lane} failed with status ${outcome.status}`);
      continue;
    }
    if (!data) {
      residualBlindSpots.push(`Lane ${lane} completed without a valid structured review outcome.`);
      blockedReasons.push(`lane ${lane} completed without a valid structured review outcome`);
      continue;
    }

    for (const finding of data?.findings ?? []) {
      findings.push(finding);
    }
    for (const item of data?.missingEvidence ?? []) {
      missingEvidence.push(`${lane}: ${item}`);
    }
    for (const item of data?.followUpQuestions ?? []) {
      residualBlindSpots.push(`${lane}: ${item}`);
    }
    if (data?.strongestCounterpoint) {
      laneDisagreements.push(`${lane}: ${data.strongestCounterpoint}`);
    }

    if (disposition === "blocked") {
      blockedReasons.push(`lane ${lane} reported a blocked disposition`);
    } else if (disposition === "inconclusive") {
      blockedReasons.push(`lane ${lane} remained inconclusive due to unresolved evidence gaps`);
    }
  }

  const reviewFindings = dedupeFindings(findings);
  const normalizedMissingEvidence = uniqueStrings(missingEvidence);
  const normalizedBlindSpots = uniqueStrings(residualBlindSpots);
  const normalizedLaneDisagreements = uniqueStrings(laneDisagreements);

  const mergeDecision: ReviewMergeDecision =
    blockedReasons.length > 0 || normalizedMissingEvidence.length > 0
      ? "blocked"
      : reviewFindings.length > 0 || laneOutcomes.some((lane) => lane.disposition === "concern")
        ? "needs_changes"
        : "ready";

  const reviewReport: ReviewReportArtifact = {
    summary: summarizeReviewDecision({
      mergeDecision,
      findings: reviewFindings,
      blockedReasons,
      activatedLanes: input.activationPlan.activatedLanes,
    }),
    activated_lanes: [...input.activationPlan.activatedLanes],
    activation_basis: [...input.activationPlan.activationBasis],
    missing_evidence: normalizedMissingEvidence,
    residual_blind_spots: normalizedBlindSpots,
    precedent_query_summary: input.precedentQuerySummary,
    precedent_consult_status: input.precedentConsultStatus,
    ...(normalizedLaneDisagreements.length > 0
      ? { lane_disagreements: normalizedLaneDisagreements }
      : {}),
  };

  return {
    reviewFindings,
    reviewReport,
    mergeDecision,
    laneOutcomes,
  };
}
