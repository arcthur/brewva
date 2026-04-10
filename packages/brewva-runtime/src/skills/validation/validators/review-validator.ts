import type { PlanningEvidenceKey, PlanningEvidenceState } from "../../../contracts/index.js";
import { PLANNING_EVIDENCE_KEYS, coerceReviewReportArtifact } from "../../../contracts/index.js";
import type { SkillValidationContext, VerificationEvidenceState } from "../context.js";
import {
  REVIEW_SEMANTIC_EVIDENCE_KEYS,
  REVIEW_SEMANTIC_OUTPUT_KEYS,
  annotateSemanticIssues,
  evidenceListMentionsKey,
  normalizeText,
  skillDeclaresAllOutputs,
  skillRequestsAnyInputs,
} from "../utils.js";
import { emptyValidationDelta, type SkillOutputValidator } from "../validator.js";

function validateReviewSemanticOutputs(
  outputs: Record<string, unknown>,
  planningEvidenceState: Partial<Record<PlanningEvidenceKey, PlanningEvidenceState>>,
  verificationEvidenceState: VerificationEvidenceState,
  requiresVerificationEvidence: boolean,
): Array<{ name: string; reason: string }> {
  const blockingPlanningEvidence = PLANNING_EVIDENCE_KEYS.filter((key) => {
    const state = planningEvidenceState[key];
    return state === "missing" || state === "stale";
  });
  const issues: Array<{ name: string; reason: string }> = [];
  const reviewReport = coerceReviewReportArtifact(outputs.review_report);
  const reviewReportMissingEvidence = reviewReport?.missing_evidence ?? [];
  const mergeDecision = normalizeText(outputs.merge_decision)?.toLowerCase();
  for (const key of blockingPlanningEvidence) {
    const state = planningEvidenceState[key];
    if (!evidenceListMentionsKey(reviewReportMissingEvidence, key)) {
      issues.push({
        name: "review_report",
        reason: `review_report.missing_evidence must disclose ${state ?? "missing"} planning evidence for ${key}`,
      });
    }
  }

  if (
    requiresVerificationEvidence &&
    verificationEvidenceState === "stale" &&
    !evidenceListMentionsKey(reviewReportMissingEvidence, "verification_evidence")
  ) {
    issues.push({
      name: "review_report",
      reason: "review_report.missing_evidence must disclose stale verification_evidence",
    });
  }
  if (
    mergeDecision === "ready" &&
    (reviewReportMissingEvidence.length > 0 ||
      blockingPlanningEvidence.length > 0 ||
      (requiresVerificationEvidence && verificationEvidenceState === "stale"))
  ) {
    issues.push({
      name: "merge_decision",
      reason:
        "merge_decision cannot be ready when planning or verification evidence is missing, stale, or disclosed as missing_evidence",
    });
  }
  return issues;
}

export class ReviewOutputValidator implements SkillOutputValidator {
  readonly name = "review";

  appliesTo(context: SkillValidationContext): boolean {
    return (
      [...context.semanticSchemaIds].some((schemaId) => schemaId.startsWith("review.")) ||
      context.skill.name === "review" ||
      (skillDeclaresAllOutputs(context.skill, REVIEW_SEMANTIC_OUTPUT_KEYS) &&
        skillRequestsAnyInputs(context.skill, REVIEW_SEMANTIC_EVIDENCE_KEYS))
    );
  }

  validate(context: SkillValidationContext) {
    const invalid = annotateSemanticIssues(
      validateReviewSemanticOutputs(
        context.outputs,
        context.evidence.getPlanningEvidenceState(),
        context.evidence.getVerificationEvidenceContext().state,
        context.skill.name === "review" ||
          skillRequestsAnyInputs(context.skill, ["verification_evidence"]),
      ),
      context.semanticBindings,
    );
    if (invalid.length === 0) {
      return emptyValidationDelta();
    }
    return {
      missing: [],
      invalid,
    };
  }
}
