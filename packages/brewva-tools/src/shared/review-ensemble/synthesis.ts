import { uniqueNonEmptyStrings as uniqueStrings } from "@brewva/brewva-std/collections";
import { normalizeStringList, readNonEmptyString as readString } from "@brewva/brewva-std/text";
import { isRecord } from "@brewva/brewva-std/unknown";
import { REVIEW_FINDING_CATEGORIES } from "@brewva/brewva-vocabulary/review";
import type {
  ExplorerReviewSubagentOutcomeData,
  DelegationOutcomeFinding,
  DelegationRunRecord,
  ReviewLaneConfidence,
  ReviewLaneDisposition,
  ReviewLaneName,
  ReviewReportArtifact,
  SubagentOutcome,
} from "../../contracts/index.js";
import { normalizeReviewLaneName } from "../review-vocabulary.js";
import type {
  ReviewEnsembleSynthesis,
  ReviewEnsembleSynthesisInput,
  ReviewLaneConsensus,
  ReviewLaneOutcomeSummary,
  ReviewMergeDecision,
} from "./index.js";

const SEVERITY_RANK: Record<NonNullable<DelegationOutcomeFinding["severity"]>, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

// Fail-closed ordering: a more severe disposition (lower rank) always wins when
// reviewers in the same lane disagree. A lane is never quieter than its loudest
// reviewer.
const DISPOSITION_SEVERITY: Record<ReviewLaneDisposition, number> = {
  blocked: 0,
  inconclusive: 1,
  concern: 2,
  clear: 3,
};

// Fail-closed ordering: the lowest reported confidence wins, so one unsure
// reviewer is never masked by confident peers.
const CONFIDENCE_SEVERITY: Record<ReviewLaneConfidence, number> = {
  low: 0,
  medium: 1,
  high: 2,
};

function worseDisposition(
  left: ReviewLaneDisposition,
  right: ReviewLaneDisposition,
): ReviewLaneDisposition {
  return DISPOSITION_SEVERITY[left] <= DISPOSITION_SEVERITY[right] ? left : right;
}

function lowerConfidence(
  left: ReviewLaneConfidence,
  right: ReviewLaneConfidence,
): ReviewLaneConfidence {
  return CONFIDENCE_SEVERITY[left] <= CONFIDENCE_SEVERITY[right] ? left : right;
}

function worseStatus(
  left: SubagentOutcome["status"],
  right: SubagentOutcome["status"],
): SubagentOutcome["status"] {
  if (left === "error" || right === "error") {
    return "error";
  }
  if (left === "cancelled" || right === "cancelled") {
    return "cancelled";
  }
  return "ok";
}

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
  const category = readString(value.category);
  return {
    summary,
    severity:
      severity === "critical" || severity === "high" || severity === "medium" || severity === "low"
        ? severity
        : undefined,
    category: (REVIEW_FINDING_CATEGORIES as readonly string[]).includes(category ?? "")
      ? (category as DelegationOutcomeFinding["category"])
      : undefined,
    evidenceRefs: readStringArray(value.evidenceRefs),
    // Reviewer-reported atom ids (Task 14's atoms target objective asks the
    // reviewer to name which atom a finding bears on). Absent or malformed
    // input simply yields undefined here — never invented, and the
    // receipt-commit seam (`review-receipts.ts`) already defaults an absent
    // `atomRefs` to `[]` on the finding it records.
    atomRefs: readStringArray(value.atomRefs),
  };
}

/**
 * Coerce an arbitrary stored value (a `SubagentOutcome.data` or a run record's
 * `resultData`) into the canonical review-outcome shape. Exported so a
 * single-reviewer flow (review_request) parses findings through the exact same
 * one review format the lane ensemble uses — one mechanism, two lens sources.
 */
export function coerceStoredReviewOutcomeData(
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
    if (!existing) {
      bySummary.set(key, {
        summary: finding.summary,
        severity: finding.severity,
        category: finding.category,
        evidenceRefs: finding.evidenceRefs ? [...finding.evidenceRefs] : undefined,
        atomRefs: finding.atomRefs ? [...finding.atomRefs] : undefined,
      });
      continue;
    }
    // Merge evidence from every reviewer that raised this finding, regardless of
    // which severity wins — a higher-severity duplicate must never drop the
    // evidence a lower-severity duplicate carried.
    const mergedEvidence =
      existing.evidenceRefs || finding.evidenceRefs
        ? uniqueStrings([...(existing.evidenceRefs ?? []), ...(finding.evidenceRefs ?? [])])
        : undefined;
    // Same union rule for atom refs: two reviewers naming the same finding
    // against different atoms must both survive the dedupe, not just the
    // higher-severity report's.
    const mergedAtomRefs =
      existing.atomRefs || finding.atomRefs
        ? uniqueStrings([...(existing.atomRefs ?? []), ...(finding.atomRefs ?? [])])
        : undefined;
    const keepIncoming = compareFindingSeverity(finding, existing) < 0;
    bySummary.set(key, {
      summary: keepIncoming ? finding.summary : existing.summary,
      severity: keepIncoming ? finding.severity : existing.severity,
      category: keepIncoming ? finding.category : existing.category,
      evidenceRefs: mergedEvidence,
      atomRefs: mergedAtomRefs,
    });
  }
  return [...bySummary.values()].toSorted(compareFindingSeverity);
}

function readReviewOutcomeData(
  outcome: SubagentOutcome,
): ExplorerReviewSubagentOutcomeData | undefined {
  return outcome.ok ? coerceStoredReviewOutcomeData(outcome.data) : undefined;
}

// A review outcome only establishes a verdict when it carries an explicit
// disposition, findings, or missing-evidence. An outcome with just a lane (or a
// narrative claim) states nothing reviewable, so it must NOT be inferred as
// "clear" — it is treated as an execution failure (no coverage) by the caller.
function establishesReviewVerdict(data: ExplorerReviewSubagentOutcomeData): boolean {
  return Boolean(
    data.disposition ||
    (data.findings && data.findings.length > 0) ||
    (data.missingEvidence && data.missingEvidence.length > 0),
  );
}

function inferLaneFromOutcome(outcome: SubagentOutcome): ReviewLaneName | undefined {
  return (
    normalizeReviewLaneName(readReviewOutcomeData(outcome)?.lane) ??
    normalizeReviewLaneName(outcome.label) ??
    normalizeReviewLaneName(outcome.delegate) ??
    normalizeReviewLaneName(outcome.agentSpec)
  );
}

/**
 * Derive the review disposition from parsed review-outcome data alone, using
 * the same fail-closed precedence the lane ensemble applies: an explicit
 * disposition wins, else findings imply `concern`, else missing evidence
 * implies `inconclusive`, else `clear`. `undefined` data (the reviewer produced
 * no structured review verdict) is `blocked`. Exported so review_request maps a
 * single reviewer's verdict through the identical rule.
 */
export function deriveReviewDisposition(
  data: ExplorerReviewSubagentOutcomeData | undefined,
): ReviewLaneDisposition {
  if (!data) {
    return "blocked";
  }
  if (data.disposition) {
    return data.disposition;
  }
  if ((data.findings?.length ?? 0) > 0) {
    return "concern";
  }
  if ((data.missingEvidence?.length ?? 0) > 0) {
    return "inconclusive";
  }
  return "clear";
}

function coerceDisposition(
  outcome: SubagentOutcome,
  data: ExplorerReviewSubagentOutcomeData | undefined,
): ReviewLaneDisposition {
  if (!outcome.ok) {
    return "blocked";
  }
  return deriveReviewDisposition(data);
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

interface ReviewLaneAggregation {
  readonly summary: ReviewLaneOutcomeSummary;
  readonly findings: readonly DelegationOutcomeFinding[];
  readonly missingEvidence: readonly string[];
  readonly blindSpots: readonly string[];
  readonly disagreements: readonly string[];
  readonly blockedReasons: readonly string[];
}

// Aggregate every reviewer delegated to one lane instead of trusting a single
// result. Two concerns are kept separate:
//   - Review verdict: findings are unioned (any reviewer's finding survives),
//     the lane disposition is the worst across reviewers that produced a
//     structured outcome, and dissent is preserved verbatim. Fail-closed on a
//     real blocked/inconclusive verdict and on zero review coverage.
//   - Execution health: a reviewer that crashed or returned no structured
//     outcome is counted and surfaced as a blind spot, but does NOT block the
//     lane when another reviewer in the same (redundant) lane succeeded — so
//     adding redundancy never lowers availability through transient failures.
// `laneResults` must be non-empty; the empty-lane case is handled by the caller.
function aggregateReviewLane(
  lane: ReviewLaneName,
  laneResults: readonly SubagentOutcome[],
): ReviewLaneAggregation {
  const findings: DelegationOutcomeFinding[] = [];
  const missingEvidence: string[] = [];
  const blindSpots: string[] = [];
  const disagreements: string[] = [];
  const blockedReasons: string[] = [];
  const dispositions: ReviewLaneDisposition[] = [];

  let laneStatus: SubagentOutcome["status"] = "ok";
  let executionFailureCount = 0;
  let laneConfidence: ReviewLaneConfidence | undefined;
  let confidenceReportedBy = 0;
  let representativeSummary: string | undefined;
  let representativeRank = Number.MAX_SAFE_INTEGER;

  for (const outcome of laneResults) {
    laneStatus = worseStatus(laneStatus, outcome.status);
    const reviewer = outcome.nickname;
    const data = readReviewOutcomeData(outcome);

    if (!outcome.ok) {
      executionFailureCount += 1;
      blindSpots.push(
        `Lane ${lane} reviewer ${reviewer} failed with status ${outcome.status}: ${outcome.error}`,
      );
      continue;
    }
    if (!data || !establishesReviewVerdict(data)) {
      executionFailureCount += 1;
      blindSpots.push(
        `Lane ${lane} reviewer ${reviewer} returned no structured review verdict (no disposition, findings, or missing-evidence).`,
      );
      continue;
    }

    const disposition = coerceDisposition(outcome, data);
    dispositions.push(disposition);
    for (const finding of data.findings ?? []) {
      findings.push(finding);
    }
    for (const item of data.missingEvidence ?? []) {
      missingEvidence.push(`${lane}: ${item}`);
    }
    for (const item of data.followUpQuestions ?? []) {
      blindSpots.push(`${lane}: ${item}`);
    }
    if (data.strongestCounterpoint) {
      disagreements.push(`${lane}: ${data.strongestCounterpoint}`);
    }
    if (data.confidence) {
      laneConfidence = laneConfidence
        ? lowerConfidence(laneConfidence, data.confidence)
        : data.confidence;
      confidenceReportedBy += 1;
    }

    const rank = DISPOSITION_SEVERITY[disposition];
    const summary = buildLaneSummary(outcome, data);
    if (summary && rank < representativeRank) {
      representativeRank = rank;
      representativeSummary = summary;
    }
  }

  const successfulReviewerCount = dispositions.length;
  const laneDisposition =
    successfulReviewerCount === 0 ? "blocked" : dispositions.reduce(worseDisposition);
  const distinctDispositions = new Set(dispositions);
  const consensus: ReviewLaneConsensus =
    successfulReviewerCount === 0
      ? "none"
      : successfulReviewerCount === 1
        ? "single"
        : distinctDispositions.size === 1
          ? "unanimous"
          : "split";

  if (consensus === "split") {
    disagreements.push(
      `${lane}: reviewers split across dispositions [${dispositions.join(", ")}]; resolved fail-closed to ${laneDisposition}.`,
    );
  }

  if (successfulReviewerCount === 0) {
    blockedReasons.push(
      `lane ${lane} has no successful reviewer (all ${executionFailureCount} delegated reviewers failed or returned no structured outcome)`,
    );
  } else if (laneDisposition === "blocked") {
    blockedReasons.push(`lane ${lane} reported a blocked disposition`);
  } else if (laneDisposition === "inconclusive") {
    blockedReasons.push(`lane ${lane} remained inconclusive due to unresolved evidence gaps`);
  }

  const summary: ReviewLaneOutcomeSummary = {
    lane,
    status: laneStatus,
    disposition: laneDisposition,
    reviewerCount: laneResults.length,
    successfulReviewerCount,
    executionFailureCount,
    consensus,
    confidenceReportedBy,
    ...(laneConfidence ? { confidence: laneConfidence } : {}),
    ...(representativeSummary ? { summary: representativeSummary } : {}),
  };

  return {
    summary,
    findings,
    missingEvidence,
    blindSpots,
    disagreements,
    blockedReasons,
  };
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
        reviewerCount: 0,
        successfulReviewerCount: 0,
        executionFailureCount: 0,
        consensus: "none",
        confidenceReportedBy: 0,
      });
      residualBlindSpots.push(`Lane ${lane} produced no delegated outcome.`);
      blockedReasons.push(`activated lane ${lane} produced no delegated outcome`);
      continue;
    }

    const aggregation = aggregateReviewLane(lane, laneResults);
    laneOutcomes.push(aggregation.summary);
    findings.push(...aggregation.findings);
    missingEvidence.push(...aggregation.missingEvidence);
    residualBlindSpots.push(...aggregation.blindSpots);
    laneDisagreements.push(...aggregation.disagreements);
    blockedReasons.push(...aggregation.blockedReasons);
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
