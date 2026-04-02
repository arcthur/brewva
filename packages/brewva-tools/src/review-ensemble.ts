import type {
  DelegationRunRecord,
  ReviewPrecedentConsultStatus,
  ReviewReportArtifact,
} from "@brewva/brewva-runtime";
import { REVIEW_LANE_NAMES, normalizeReviewLaneName } from "@brewva/brewva-runtime";
export { normalizeReviewLaneName } from "@brewva/brewva-runtime";
import type { ReviewChangeCategory, ReviewChangedFileClass } from "./review-classification.js";
import type {
  DelegationCompletionPredicate,
  DelegationOutcomeFinding,
  DelegationTaskPacket,
  ReviewLaneDisposition,
  ReviewLaneName,
  ReviewSubagentOutcomeData,
  SubagentContextBudget,
  SubagentContextRef,
  SubagentExecutionHints,
  SubagentOutcome,
} from "./types.js";

export const ALWAYS_ON_REVIEW_LANES = [
  "review-correctness",
  "review-boundaries",
  "review-operability",
] as const satisfies readonly ReviewLaneName[];

export const CONDITIONAL_REVIEW_LANES = [
  "review-security",
  "review-concurrency",
  "review-compatibility",
  "review-performance",
] as const satisfies readonly ReviewLaneName[];

export const ALL_REVIEW_LANES = [...REVIEW_LANE_NAMES] as const satisfies readonly ReviewLaneName[];

export type ReviewPlanningPosture = "trivial" | "moderate" | "complex" | "high_risk";

export type ReviewEvidenceKey =
  | "impact_map"
  | "design_spec"
  | "execution_plan"
  | "verification_evidence"
  | "risk_register"
  | "implementation_targets";

export type ReviewEvidenceState = "present" | "stale" | "missing";

export type ReviewMergeDecision = "ready" | "needs_changes" | "blocked";

export interface ReviewLaneActivationInput {
  planningPosture?: ReviewPlanningPosture;
  changeCategories?: readonly ReviewChangeCategory[];
  riskCategories?: readonly ReviewChangeCategory[];
  changedFileClasses?: readonly ReviewChangedFileClass[];
  evidenceState?: Partial<Record<ReviewEvidenceKey, ReviewEvidenceState>>;
}

export interface ReviewLaneActivationPlan {
  planningPosture: ReviewPlanningPosture;
  activatedLanes: ReviewLaneName[];
  activationBasis: string[];
  missingEvidence: string[];
}

export interface ReviewLaneDelegationPacketInput {
  objective: string;
  deliverable?: string;
  constraints?: readonly string[];
  sharedNotes?: readonly string[];
  activeSkillName?: string;
  executionHints?: SubagentExecutionHints;
  contextRefs?: readonly SubagentContextRef[];
  contextBudget?: SubagentContextBudget;
  completionPredicate?: DelegationCompletionPredicate;
}

export interface ReviewLaneOutcomeSummary {
  lane: ReviewLaneName;
  status: SubagentOutcome["status"] | "missing";
  disposition: ReviewLaneDisposition;
  summary?: string;
}

export interface ReviewEnsembleSynthesisInput {
  activationPlan: ReviewLaneActivationPlan;
  outcomes: readonly SubagentOutcome[];
  precedentQuerySummary: string;
  precedentConsultStatus: ReviewPrecedentConsultStatus;
}

export interface ReviewEnsembleSynthesis {
  reviewFindings: DelegationOutcomeFinding[];
  reviewReport: ReviewReportArtifact;
  mergeDecision: ReviewMergeDecision;
  laneOutcomes: ReviewLaneOutcomeSummary[];
}

const REVIEW_LANE_DESCRIPTIONS: Record<ReviewLaneName, string> = {
  "review-correctness":
    "Inspect behavioral correctness, invariants, state safety, and regression risk.",
  "review-boundaries":
    "Inspect ownership boundaries, contracts, public surfaces, and architectural drift.",
  "review-operability":
    "Inspect verification posture, rollbackability, operator burden, and deployment risk.",
  "review-security":
    "Inspect auth, trust boundaries, credentials, permissions, and untrusted input handling.",
  "review-concurrency":
    "Inspect ordering, replay, recovery, rollback, scheduling, and multi-session state transitions.",
  "review-compatibility":
    "Inspect CLI, config, exports, public APIs, persisted formats, and protocol compatibility.",
  "review-performance":
    "Inspect hot paths, scans, fan-out, queue growth, and artifact-volume regressions.",
};

const EVIDENCE_KEYS_IN_ORDER: readonly ReviewEvidenceKey[] = [
  "impact_map",
  "design_spec",
  "execution_plan",
  "verification_evidence",
  "risk_register",
  "implementation_targets",
];

const SEVERITY_RANK: Record<NonNullable<DelegationOutcomeFinding["severity"]>, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

const LANE_CHANGE_CATEGORY_MAP: Record<ReviewLaneName, readonly ReviewChangeCategory[]> = {
  "review-correctness": [],
  "review-boundaries": [],
  "review-operability": [],
  "review-security": [
    "authn",
    "authz",
    "credential_handling",
    "secret_io",
    "external_input",
    "network_boundary",
    "permission_policy",
  ],
  "review-concurrency": [
    "wal_replay",
    "rollback",
    "scheduler",
    "queueing",
    "async_ordering",
    "cross_session_state",
    "multi_writer_state",
  ],
  "review-compatibility": [
    "cli_surface",
    "config_schema",
    "public_api",
    "export_map",
    "persisted_format",
    "wire_protocol",
    "package_boundary",
  ],
  "review-performance": [
    "hot_path",
    "indexing_scan",
    "fanout_parallelism",
    "queue_growth",
    "artifact_volume",
    "storage_churn",
  ],
};

const LANE_FILE_CLASS_MAP: Record<ReviewLaneName, readonly ReviewChangedFileClass[]> = {
  "review-correctness": [],
  "review-boundaries": [],
  "review-operability": [],
  "review-security": [
    "auth_surface",
    "credential_surface",
    "network_boundary",
    "permission_surface",
  ],
  "review-concurrency": [
    "wal_replay",
    "rollback_surface",
    "scheduler",
    "runtime_coordination",
    "queueing_parallelism",
  ],
  "review-compatibility": [
    "cli_surface",
    "config_surface",
    "public_api",
    "persisted_format",
    "package_boundary",
  ],
  "review-performance": [
    "artifact_scan",
    "queueing_parallelism",
    "runtime_coordination",
    "storage_churn",
  ],
};

const NEUTRAL_FILE_CLASSES = new Set<ReviewChangedFileClass>([
  "docs_only",
  "tests_only",
  "fixtures_only",
]);

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))];
}

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

function normalizeSummaryKey(summary: string): string {
  return summary.trim().toLowerCase().replaceAll(/\s+/g, " ");
}

function formatLaneList(lanes: readonly ReviewLaneName[]): string {
  return lanes.join(", ");
}

export function isReviewLaneName(value: string): value is ReviewLaneName {
  return REVIEW_LANE_NAMES.includes(value as ReviewLaneName);
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

function coerceStoredReviewOutcomeData(value: unknown): ReviewSubagentOutcomeData | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const kind = readString(value.kind);
  if (kind !== "review") {
    return undefined;
  }
  const lane = normalizeReviewLaneName(value.lane);
  const disposition = readString(value.disposition);
  const primaryClaim = readString(value.primaryClaim);
  const strongestCounterpoint = readString(value.strongestCounterpoint);
  const openQuestions = readStringArray(value.openQuestions);
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
    !openQuestions &&
    !missingEvidence &&
    !(findings && findings.length > 0)
  ) {
    return undefined;
  }
  return {
    kind: "review",
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
    ...(openQuestions ? { openQuestions } : {}),
    ...(missingEvidence ? { missingEvidence } : {}),
    ...(confidence === "low" || confidence === "medium" || confidence === "high"
      ? { confidence }
      : {}),
  };
}

function collectEvidenceGaps(
  evidenceState: Partial<Record<ReviewEvidenceKey, ReviewEvidenceState>> | undefined,
): string[] {
  if (!evidenceState) {
    return [];
  }
  const gaps: string[] = [];
  for (const key of EVIDENCE_KEYS_IN_ORDER) {
    const state = evidenceState[key];
    if (state === "missing" || state === "stale") {
      gaps.push(`${key}:${state}`);
    }
  }
  return gaps;
}

function uniqueEnumValues<T extends string>(values: readonly T[]): T[] {
  return [
    ...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0)),
  ] as T[];
}

function pickConditionalLanesFromCategories(
  categories: readonly ReviewChangeCategory[],
): ReviewLaneName[] {
  const categorySet = new Set(categories);
  return CONDITIONAL_REVIEW_LANES.filter((lane) =>
    LANE_CHANGE_CATEGORY_MAP[lane].some((category) => categorySet.has(category)),
  );
}

function pickConditionalLanesFromFileClasses(
  fileClasses: readonly ReviewChangedFileClass[],
): ReviewLaneName[] {
  const fileClassSet = new Set(fileClasses);
  return CONDITIONAL_REVIEW_LANES.filter((lane) =>
    LANE_FILE_CLASS_MAP[lane].some((fileClass) => fileClassSet.has(fileClass)),
  );
}

export function deriveReviewLaneActivationPlan(
  input: ReviewLaneActivationInput,
): ReviewLaneActivationPlan {
  const planningPosture = input.planningPosture ?? "moderate";
  const changeCategories = uniqueEnumValues(input.changeCategories ?? []);
  const riskCategories = uniqueEnumValues(input.riskCategories ?? []);
  const changedFileClasses = uniqueEnumValues(input.changedFileClasses ?? []);
  const missingEvidence = collectEvidenceGaps(input.evidenceState);
  const activated = new Set<ReviewLaneName>(ALWAYS_ON_REVIEW_LANES);
  const activationBasis = [
    "Always-on lanes cover correctness, boundaries, and operability for every review run.",
  ];

  if (planningPosture === "high_risk") {
    for (const lane of CONDITIONAL_REVIEW_LANES) {
      activated.add(lane);
    }
    activationBasis.push("High-risk planning posture widened the review ensemble to all lanes.");
  } else if (missingEvidence.length > 0) {
    for (const lane of CONDITIONAL_REVIEW_LANES) {
      activated.add(lane);
    }
    activationBasis.push(
      `Missing or stale evidence widened the review ensemble: ${missingEvidence.join(", ")}.`,
    );
  } else if (changeCategories.length > 0 || riskCategories.length > 0) {
    const matchedFromChangeCategories =
      changeCategories.length > 0 ? pickConditionalLanesFromCategories(changeCategories) : [];
    if (matchedFromChangeCategories.length > 0) {
      for (const lane of matchedFromChangeCategories) {
        activated.add(lane);
      }
      activationBasis.push(
        `Conditional lanes activated from canonical change categories: ${formatLaneList(matchedFromChangeCategories)}.`,
      );
    } else if (changeCategories.length > 0) {
      activationBasis.push(
        "Canonical change categories did not trigger any conditional review lane.",
      );
    }

    const matchedFromRiskCategories =
      riskCategories.length > 0 ? pickConditionalLanesFromCategories(riskCategories) : [];
    if (matchedFromRiskCategories.length > 0) {
      for (const lane of matchedFromRiskCategories) {
        activated.add(lane);
      }
      activationBasis.push(
        `Conditional lanes activated from design risk categories: ${formatLaneList(matchedFromRiskCategories)}.`,
      );
    } else if (riskCategories.length > 0) {
      activationBasis.push(
        "Design risk categories did not trigger any additional conditional lane.",
      );
    }
  } else if (changedFileClasses.length > 0) {
    if (changedFileClasses.includes("mixed_unknown")) {
      for (const lane of CONDITIONAL_REVIEW_LANES) {
        activated.add(lane);
      }
      activationBasis.push(
        "Changed-file classification included mixed_unknown, so the review ensemble widened to all conditional lanes.",
      );
    } else {
      const matched = pickConditionalLanesFromFileClasses(changedFileClasses);
      const onlyNeutral = changedFileClasses.every((fileClass) =>
        NEUTRAL_FILE_CLASSES.has(fileClass),
      );
      if (matched.length > 0) {
        for (const lane of matched) {
          activated.add(lane);
        }
        activationBasis.push(
          `Conditional lanes activated from canonical changed-file classes: ${formatLaneList(matched)}.`,
        );
      } else if (onlyNeutral) {
        activationBasis.push(
          "Only neutral changed-file classes were present, so conditional review lanes remained off.",
        );
      } else {
        for (const lane of CONDITIONAL_REVIEW_LANES) {
          activated.add(lane);
        }
        activationBasis.push(
          "Changed-file classes were non-neutral but did not classify cleanly, so the review ensemble widened to all conditional lanes.",
        );
      }
    }
  } else if (planningPosture !== "trivial") {
    for (const lane of CONDITIONAL_REVIEW_LANES) {
      activated.add(lane);
    }
    activationBasis.push(
      "Category and changed-file classification were unavailable, so the review ensemble widened to all conditional lanes.",
    );
  } else {
    activationBasis.push(
      "Trivial planning posture kept the review ensemble on always-on lanes because no widening signals were present.",
    );
  }

  return {
    planningPosture,
    activatedLanes: ALL_REVIEW_LANES.filter((lane) => activated.has(lane)),
    activationBasis,
    missingEvidence,
  };
}

function mergeExecutionHints(
  hints: SubagentExecutionHints | undefined,
): SubagentExecutionHints | undefined {
  if (!hints) {
    return {
      preferredSkills: ["review"],
    };
  }
  const preferredTools = hints.preferredTools ? uniqueStrings(hints.preferredTools) : undefined;
  const fallbackTools = hints.fallbackTools ? uniqueStrings(hints.fallbackTools) : undefined;
  const preferredSkills = uniqueStrings([...(hints.preferredSkills ?? []), "review"]);
  return {
    ...(preferredTools ? { preferredTools } : {}),
    ...(fallbackTools ? { fallbackTools } : {}),
    preferredSkills,
  };
}

export function buildReviewLaneDelegationTasks(input: {
  activationPlan: ReviewLaneActivationPlan;
  packet: ReviewLaneDelegationPacketInput;
}): DelegationTaskPacket[] {
  const deliverable =
    input.packet.deliverable ??
    "Emit a structured lane review with disposition, evidence-backed findings, missing evidence, and open questions.";
  const executionHints = mergeExecutionHints(input.packet.executionHints);

  return input.activationPlan.activatedLanes.map((lane) => ({
    label: lane,
    objective: `${input.packet.objective}\n\nLane focus: ${REVIEW_LANE_DESCRIPTIONS[lane]}`,
    deliverable,
    constraints: input.packet.constraints ? [...input.packet.constraints] : undefined,
    sharedNotes: uniqueStrings([
      ...(input.packet.sharedNotes ?? []),
      `Lane identity: ${lane}`,
      "Set the structured review outcome lane field to the active review lane.",
      "If the lane clears, emit disposition=clear instead of inventing findings.",
      "If evidence is missing, record it in missingEvidence rather than guessing.",
      ...input.activationPlan.activationBasis.map((reason) => `Activation basis: ${reason}`),
    ]),
    activeSkillName: input.packet.activeSkillName ?? "review",
    executionHints,
    contextRefs: input.packet.contextRefs ? [...input.packet.contextRefs] : undefined,
    contextBudget: input.packet.contextBudget,
    completionPredicate: input.packet.completionPredicate,
  }));
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

function readReviewOutcomeData(outcome: SubagentOutcome): ReviewSubagentOutcomeData | undefined {
  return outcome.ok && outcome.data?.kind === "review" ? outcome.data : undefined;
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
  data: ReviewSubagentOutcomeData | undefined,
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
  data: ReviewSubagentOutcomeData | undefined,
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

export function materializeReviewLaneOutcomes(
  runs: readonly DelegationRunRecord[],
): SubagentOutcome[] {
  return runs
    .filter((run) => run.kind === "review")
    .map((run) => {
      const artifactRefs = run.artifactRefs?.map((ref) => ({
        kind: ref.kind,
        path: ref.path,
        summary: ref.summary,
      }));
      const metrics = {
        durationMs: Math.max(0, run.updatedAt - run.createdAt),
        ...(typeof run.totalTokens === "number" ? { totalTokens: run.totalTokens } : {}),
        ...(typeof run.costUsd === "number" ? { costUsd: run.costUsd } : {}),
      };

      if (run.status === "completed") {
        return {
          ok: true,
          runId: run.runId,
          delegate: run.delegate,
          agentSpec: run.agentSpec,
          envelope: run.envelope,
          skillName: run.skillName,
          label: run.label,
          kind: "review",
          status: "ok",
          workerSessionId: run.workerSessionId,
          summary: run.summary ?? "Delegated review lane completed.",
          data: coerceStoredReviewOutcomeData(run.resultData),
          metrics,
          evidenceRefs: [],
          artifactRefs,
        } satisfies SubagentOutcome;
      }

      const status = run.status === "cancelled" || run.status === "timeout" ? run.status : "error";
      return {
        ok: false,
        runId: run.runId,
        delegate: run.delegate,
        agentSpec: run.agentSpec,
        envelope: run.envelope,
        skillName: run.skillName,
        label: run.label,
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
    for (const item of data?.openQuestions ?? []) {
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
