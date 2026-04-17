export function buildCanonicalReviewReport(summary: string) {
  return {
    summary,
    activated_lanes: ["review-correctness"],
    activation_basis: ["Test fixture supplied canonical review report metadata."],
    missing_evidence: [],
    residual_blind_spots: [],
    precedent_query_summary:
      "Test fixture bypassed precedent lookup and supplied canonical review metadata directly.",
    precedent_consult_status: {
      status: "not_required",
    },
  };
}
