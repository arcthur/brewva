import type { ReviewLaneName } from "../contracts/index.js";

export const REVIEW_LANE_NAMES = [
  "review-correctness",
  "review-boundaries",
  "review-operability",
  "review-security",
  "review-concurrency",
  "review-compatibility",
  "review-performance",
] as const satisfies readonly ReviewLaneName[];

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
