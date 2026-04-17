import { coerceReviewReportArtifact } from "../../../contracts/index.js";
import type { SkillValidationContext } from "../context.js";
import {
  SHIP_SEMANTIC_OUTPUT_KEYS,
  annotateSemanticIssues,
  isRecord,
  normalizeText,
  readStringArray,
  skillDeclaresAllOutputs,
} from "../utils.js";
import { emptyValidationDelta, type SkillOutputValidator } from "../validator.js";

function isReleaseChecklistItem(value: unknown): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    normalizeText(value.item) !== null &&
    normalizeText(value.status) !== null &&
    normalizeText(value.evidence) !== null
  );
}

function collectShipGateSignals(context: SkillValidationContext) {
  const reviewReport = coerceReviewReportArtifact(context.consumedOutputView.outputs.review_report);
  const mergeDecision = normalizeText(
    context.consumedOutputView.outputs.merge_decision,
  )?.toLowerCase();
  const qaVerdict = normalizeText(context.consumedOutputView.outputs.qa_verdict)?.toLowerCase();
  const qaMissingEvidence =
    readStringArray(context.consumedOutputView.outputs.qa_missing_evidence) ?? [];
  const qaConfidenceGaps =
    readStringArray(context.consumedOutputView.outputs.qa_confidence_gaps) ?? [];
  const qaEnvironmentLimits =
    readStringArray(context.consumedOutputView.outputs.qa_environment_limits) ?? [];
  const releaseChecklist = Array.isArray(context.normalizedOutputs.canonical.release_checklist)
    ? context.normalizedOutputs.canonical.release_checklist.filter(isReleaseChecklistItem)
    : [];
  const pendingChecklist = releaseChecklist.filter(
    (item) => normalizeText(item.status)?.toLowerCase() === "pending",
  );
  const blockedChecklist = releaseChecklist.filter(
    (item) => normalizeText(item.status)?.toLowerCase() === "blocked",
  );

  return {
    reviewMissingEvidence: reviewReport?.missing_evidence ?? [],
    mergeDecision,
    qaVerdict,
    qaMissingEvidence,
    qaConfidenceGaps,
    qaEnvironmentLimits,
    pendingChecklist,
    blockedChecklist,
  };
}

function validateShipSemanticOutputs(
  context: SkillValidationContext,
): Array<{ name: string; reason: string }> {
  const shipDecision = normalizeText(
    context.normalizedOutputs.canonical.ship_decision,
  )?.toLowerCase();
  if (
    shipDecision !== "ready" &&
    shipDecision !== "needs_follow_up" &&
    shipDecision !== "blocked"
  ) {
    return [];
  }

  const signals = collectShipGateSignals(context);
  const openGateReasons = [
    ...(signals.mergeDecision === "ready"
      ? []
      : [
          `ship requires upstream merge_decision=ready before release can proceed (found ${signals.mergeDecision ?? "missing"})`,
        ]),
    ...(signals.qaVerdict === "pass"
      ? []
      : [
          `ship requires upstream qa_verdict=pass before release can proceed (found ${signals.qaVerdict ?? "missing"})`,
        ]),
    ...signals.reviewMissingEvidence.map(
      (entry) => `review_report still declares missing_evidence: ${entry}`,
    ),
    ...signals.qaMissingEvidence.map((entry) => `qa_missing_evidence still open: ${entry}`),
    ...signals.qaConfidenceGaps.map((entry) => `qa_confidence_gaps still open: ${entry}`),
    ...signals.qaEnvironmentLimits.map((entry) => `qa_environment_limits still open: ${entry}`),
    ...signals.pendingChecklist.map(
      (item) => `release_checklist remains pending: ${normalizeText(item.item) ?? "unnamed item"}`,
    ),
    ...signals.blockedChecklist.map(
      (item) => `release_checklist remains blocked: ${normalizeText(item.item) ?? "unnamed item"}`,
    ),
  ];

  if (shipDecision === "ready") {
    return openGateReasons.map((reason) => ({
      name: reason.startsWith("release_checklist") ? "release_checklist" : "ship_decision",
      reason,
    }));
  }

  if (shipDecision === "needs_follow_up" && openGateReasons.length === 0) {
    return [
      {
        name: "ship_decision",
        reason:
          "ship_decision cannot be needs_follow_up when review, QA, and release_checklist are already fully ready",
      },
    ];
  }

  if (
    shipDecision === "blocked" &&
    signals.blockedChecklist.length === 0 &&
    openGateReasons.length === 0
  ) {
    return [
      {
        name: "ship_decision",
        reason:
          "ship_decision cannot be blocked without a blocked release_checklist item or an unresolved upstream release gate",
      },
    ];
  }

  return [];
}

export class ShipOutputValidator implements SkillOutputValidator {
  readonly name = "ship";

  appliesTo(context: SkillValidationContext): boolean {
    return (
      [...context.semanticSchemaIds].some((schemaId) => schemaId.startsWith("ship.")) ||
      context.skill.name === "ship" ||
      skillDeclaresAllOutputs(context.skill, SHIP_SEMANTIC_OUTPUT_KEYS)
    );
  }

  validate(context: SkillValidationContext) {
    const invalid = annotateSemanticIssues(
      validateShipSemanticOutputs(context),
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
