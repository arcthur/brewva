import type {
  ExplorerConsultBrief,
  DelegationCompletionPredicate,
  DelegationOutcomeFinding,
  ReviewLaneConfidence,
  ReviewLaneDisposition,
  ReviewLaneName,
  ReviewPrecedentConsultStatus,
  ReviewReportArtifact,
  SubagentContextBudget,
  SubagentContextRef,
  SubagentExecutionHints,
  SubagentOutcome,
} from "../../contracts/index.js";
import type { ReviewChangeCategory, ReviewChangedFileClass } from "../review-classification.js";
import { REVIEW_LANE_NAMES } from "../review-vocabulary.js";
export { normalizeReviewLaneName } from "../review-vocabulary.js";

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
  consultBrief: ExplorerConsultBrief;
  constraints?: readonly string[];
  sharedNotes?: readonly string[];
  executionHints?: SubagentExecutionHints;
  contextRefs?: readonly SubagentContextRef[];
  contextBudget?: SubagentContextBudget;
  completionPredicate?: DelegationCompletionPredicate;
}

export type ReviewLaneConsensus = "none" | "single" | "unanimous" | "split";

export interface ReviewLaneOutcomeSummary {
  lane: ReviewLaneName;
  status: SubagentOutcome["status"] | "missing";
  /** Worst disposition across reviewers that produced a structured outcome; "blocked" when none did. */
  disposition: ReviewLaneDisposition;
  /** Total reviewers routed to the lane. */
  reviewerCount: number;
  /** Reviewers that produced a structured review outcome (review coverage). */
  successfulReviewerCount: number;
  /** Reviewers that crashed or returned no structured outcome (execution health, not a review finding). */
  executionFailureCount: number;
  /** Consensus over the reviewers that produced a structured outcome. */
  consensus: ReviewLaneConsensus;
  /** Lowest confidence reported by a structured reviewer; advisory, never a gate. */
  confidence?: ReviewLaneConfidence;
  /** How many successful reviewers actually reported a confidence (so partial reporting is visible). */
  confidenceReportedBy: number;
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

const EVIDENCE_KEYS_IN_ORDER: readonly ReviewEvidenceKey[] = [
  "impact_map",
  "design_spec",
  "execution_plan",
  "verification_evidence",
  "risk_register",
  "implementation_targets",
];

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

function formatLaneList(lanes: readonly ReviewLaneName[]): string {
  return lanes.join(", ");
}

export function isReviewLaneName(value: string): value is ReviewLaneName {
  return (REVIEW_LANE_NAMES as readonly string[]).includes(value);
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
    (LANE_CHANGE_CATEGORY_MAP[lane] ?? []).some((category) => categorySet.has(category)),
  );
}

function pickConditionalLanesFromFileClasses(
  fileClasses: readonly ReviewChangedFileClass[],
): ReviewLaneName[] {
  const fileClassSet = new Set(fileClasses);
  return CONDITIONAL_REVIEW_LANES.filter((lane) =>
    (LANE_FILE_CLASS_MAP[lane] ?? []).some((fileClass) => fileClassSet.has(fileClass)),
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

export { buildReviewLaneDelegationTasks } from "./delegation.js";
export { materializeReviewLaneOutcomes, synthesizeReviewEnsemble } from "./synthesis.js";
