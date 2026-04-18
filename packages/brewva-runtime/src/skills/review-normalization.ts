import type { ReviewPrecedentConsultStatus, ReviewReportArtifact } from "../contracts/review.js";
import { REVIEW_REPORT_REQUIRED_FIELDS } from "../contracts/review.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function readString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const normalized = value
    .map((entry) => readString(entry))
    .filter((entry): entry is string => Boolean(entry));
  return normalized.length === value.length ? normalized : undefined;
}

function coerceReviewPrecedentConsultStatus(
  value: unknown,
): ReviewPrecedentConsultStatus | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const status = readString(value.status);
  if (status !== "consulted" && status !== "no_match" && status !== "not_required") {
    return undefined;
  }
  const precedent_refs = hasOwn(value, "precedent_refs")
    ? readStringArray(value.precedent_refs)
    : undefined;
  if (hasOwn(value, "precedent_refs") && precedent_refs === undefined) {
    return undefined;
  }
  return {
    status,
    precedent_refs,
  };
}

export function coerceReviewReportArtifact(value: unknown): ReviewReportArtifact | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  for (const field of REVIEW_REPORT_REQUIRED_FIELDS) {
    if (!hasOwn(value, field)) {
      return undefined;
    }
  }

  const summary = readString(value.summary);
  const activated_lanes = readStringArray(value.activated_lanes);
  const activation_basis = readStringArray(value.activation_basis);
  const missing_evidence = readStringArray(value.missing_evidence);
  const residual_blind_spots = readStringArray(value.residual_blind_spots);
  const precedent_query_summary = readString(value.precedent_query_summary);
  const precedent_consult_status = coerceReviewPrecedentConsultStatus(
    value.precedent_consult_status,
  );
  const lane_disagreements = hasOwn(value, "lane_disagreements")
    ? readStringArray(value.lane_disagreements)
    : undefined;

  if (!summary || !activated_lanes || activated_lanes.length === 0) {
    return undefined;
  }
  if (!activation_basis || activation_basis.length === 0) {
    return undefined;
  }
  if (
    !missing_evidence ||
    !residual_blind_spots ||
    !precedent_query_summary ||
    !precedent_consult_status
  ) {
    return undefined;
  }
  if (hasOwn(value, "lane_disagreements") && lane_disagreements === undefined) {
    return undefined;
  }

  return {
    summary,
    activated_lanes,
    activation_basis,
    missing_evidence,
    residual_blind_spots,
    precedent_query_summary,
    precedent_consult_status,
    lane_disagreements,
  };
}
