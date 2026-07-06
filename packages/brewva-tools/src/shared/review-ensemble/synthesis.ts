import { normalizeStringList, readNonEmptyString as readString } from "@brewva/brewva-std/text";
import { isRecord } from "@brewva/brewva-std/unknown";
import { REVIEW_FINDING_CATEGORIES } from "@brewva/brewva-vocabulary/review";
import type {
  ExplorerReviewSubagentOutcomeData,
  DelegationOutcomeFinding,
  ReviewLaneDisposition,
} from "../../contracts/index.js";
import { normalizeReviewLaneName } from "../review-vocabulary.js";

function readStringArray(value: unknown): string[] | undefined {
  const items = normalizeStringList(value);
  return items.length > 0 ? items : undefined;
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
 * one review format the reviewer receipt path uses.
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

/**
 * Derive the review disposition from parsed review-outcome data alone, using a
 * fail-closed precedence: an explicit disposition wins, else findings imply
 * `concern`, else missing evidence implies `inconclusive`, else `clear`.
 * `undefined` data (the reviewer produced no structured review verdict) is
 * `blocked`. Exported so review_request maps a single reviewer's verdict through
 * this rule.
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
