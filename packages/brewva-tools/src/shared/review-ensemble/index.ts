import type { ReviewLaneName } from "../../contracts/index.js";

export const ALWAYS_ON_REVIEW_LANES = [
  "review-correctness",
  "review-boundaries",
  "review-operability",
] as const satisfies readonly ReviewLaneName[];

export { coerceStoredReviewOutcomeData, deriveReviewDisposition } from "./synthesis.js";
