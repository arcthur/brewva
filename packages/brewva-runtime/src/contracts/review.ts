import type { SkillOutputContract } from "./skill.js";

export const REVIEW_LANE_NAMES = [
  "review-correctness",
  "review-boundaries",
  "review-operability",
  "review-security",
  "review-concurrency",
  "review-compatibility",
  "review-performance",
] as const;

export type ReviewLaneName = (typeof REVIEW_LANE_NAMES)[number];

export const REVIEW_CHANGE_CATEGORIES = [
  "authn",
  "authz",
  "credential_handling",
  "secret_io",
  "external_input",
  "network_boundary",
  "permission_policy",
  "wal_replay",
  "rollback",
  "scheduler",
  "queueing",
  "async_ordering",
  "cross_session_state",
  "multi_writer_state",
  "cli_surface",
  "config_schema",
  "public_api",
  "export_map",
  "persisted_format",
  "wire_protocol",
  "package_boundary",
  "hot_path",
  "indexing_scan",
  "fanout_parallelism",
  "queue_growth",
  "artifact_volume",
  "storage_churn",
] as const;

export type ReviewChangeCategory = (typeof REVIEW_CHANGE_CATEGORIES)[number];

export const PLANNING_OWNER_LANES = [
  ...REVIEW_LANE_NAMES,
  "qa",
  "implementation",
  "operator",
] as const;

export type PlanningOwnerLane = (typeof PLANNING_OWNER_LANES)[number];

export const REVIEW_REPORT_REQUIRED_FIELDS = [
  "summary",
  "activated_lanes",
  "activation_basis",
  "missing_evidence",
  "residual_blind_spots",
  "precedent_query_summary",
  "precedent_consult_status",
] as const;

export type ReviewReportRequiredField = (typeof REVIEW_REPORT_REQUIRED_FIELDS)[number];

export type ReviewPrecedentConsultDisposition = "consulted" | "no_match" | "not_required";

export interface ReviewPrecedentConsultStatus {
  status: ReviewPrecedentConsultDisposition;
  precedent_refs?: string[];
}

export interface ReviewReportArtifact {
  summary: string;
  activated_lanes: string[];
  activation_basis: string[];
  missing_evidence: string[];
  residual_blind_spots: string[];
  precedent_query_summary: string;
  precedent_consult_status: ReviewPrecedentConsultStatus;
  lane_disagreements?: string[];
}

export const REVIEW_REPORT_OUTPUT_CONTRACT: SkillOutputContract = {
  kind: "json",
  minKeys: REVIEW_REPORT_REQUIRED_FIELDS.length,
  requiredFields: [...REVIEW_REPORT_REQUIRED_FIELDS],
  fieldContracts: {
    summary: {
      kind: "text",
      minWords: 3,
      minLength: 18,
    },
    activated_lanes: {
      kind: "json",
      minItems: 1,
    },
    activation_basis: {
      kind: "json",
      minItems: 1,
    },
    missing_evidence: {
      kind: "json",
      minItems: 0,
    },
    residual_blind_spots: {
      kind: "json",
      minItems: 0,
    },
    precedent_query_summary: {
      kind: "text",
      minWords: 3,
      minLength: 18,
    },
    precedent_consult_status: {
      kind: "json",
      minKeys: 1,
      requiredFields: ["status"],
      fieldContracts: {
        status: {
          kind: "enum",
          values: ["consulted", "no_match", "not_required"],
        },
        precedent_refs: {
          kind: "json",
          minItems: 1,
        },
      },
    },
    lane_disagreements: {
      kind: "json",
      minItems: 1,
    },
  },
};

function readString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

export function isReviewLaneName(value: string): value is ReviewLaneName {
  return REVIEW_LANE_NAMES.includes(value as ReviewLaneName);
}

export function normalizeReviewLaneName(value: unknown): ReviewLaneName | undefined {
  const normalized = readString(value);
  return normalized && isReviewLaneName(normalized) ? normalized : undefined;
}

export function isReviewChangeCategory(value: string): value is ReviewChangeCategory {
  return REVIEW_CHANGE_CATEGORIES.includes(value as ReviewChangeCategory);
}

export function isPlanningOwnerLane(value: string): value is PlanningOwnerLane {
  return PLANNING_OWNER_LANES.includes(value as PlanningOwnerLane);
}
