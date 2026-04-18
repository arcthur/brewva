import type { DesignRiskItem } from "../../../contracts/index.js";
import {
  collectQaCoverageTexts,
  isRequiredEvidenceCovered,
} from "../../../workflow/coverage-utils.js";
import { collectPlanningRequiredEvidence } from "../../planning-normalization.js";
import type { SkillValidationContext } from "../context.js";
import {
  QA_SEMANTIC_OUTPUT_KEYS,
  annotateSemanticIssues,
  evidenceListMentionsKey,
  isRecord,
  normalizeText,
  readStringArray,
  skillDeclaresAllOutputs,
  uniqueStrings,
} from "../utils.js";
import { emptyValidationDelta, type SkillOutputValidator } from "../validator.js";

function isQaCheckRecord(value: unknown): value is Record<string, unknown> {
  return (
    isRecord(value) && normalizeText(value.name) !== null && normalizeText(value.status) !== null
  );
}

function isDesignRiskItem(value: unknown): value is DesignRiskItem {
  return (
    isRecord(value) &&
    normalizeText(value.risk) !== null &&
    normalizeText(value.category) !== null &&
    normalizeText(value.severity) !== null &&
    normalizeText(value.mitigation) !== null &&
    readStringArray(value.required_evidence) !== null &&
    normalizeText(value.owner_lane) !== null
  );
}

function hasExecutableQaEvidence(check: Record<string, unknown>): boolean {
  return normalizeText(check.command) !== null || normalizeText(check.tool) !== null;
}

function hasQaObservedEvidence(check: Record<string, unknown>): boolean {
  return normalizeText(check.observed_output) !== null;
}

function hasQaExitCodeWhenCommanded(check: Record<string, unknown>): boolean {
  if (normalizeText(check.command) === null) {
    return true;
  }
  return typeof check.exit_code === "number" && Number.isFinite(check.exit_code);
}

function isAdversarialQaProbeType(value: unknown): boolean {
  const probeType = normalizeText(value)?.toLowerCase();
  if (!probeType) {
    return false;
  }
  return (
    probeType === "adversarial" ||
    probeType === "boundary" ||
    probeType === "edge" ||
    probeType === "negative" ||
    probeType === "concurrency" ||
    probeType === "idempotency" ||
    probeType === "orphan" ||
    probeType === "race" ||
    probeType === "stress" ||
    probeType === "fuzz"
  );
}

function validateQaSemanticOutputs(
  context: SkillValidationContext,
  verificationCoverageTexts: readonly string[],
): Array<{ name: string; reason: string }> {
  const verdict = normalizeText(context.normalizedOutputs.canonical.qa_verdict)?.toLowerCase();
  if (verdict !== "pass" && verdict !== "fail" && verdict !== "inconclusive") {
    return [];
  }

  if (!Array.isArray(context.normalizedOutputs.canonical.qa_checks)) {
    return [];
  }
  const checks = context.normalizedOutputs.canonical.qa_checks.filter(isQaCheckRecord);
  if (checks.length === 0) {
    return [];
  }

  const failedChecks = checks.filter(
    (check) => normalizeText(check.status)?.toLowerCase() === "fail",
  );
  const inconclusiveChecks = checks.filter(
    (check) => normalizeText(check.status)?.toLowerCase() === "inconclusive",
  );
  const hasExecutableEvidence = checks.some(hasExecutableQaEvidence);
  const hasAdversarialProbe = checks.some((check) => isAdversarialQaProbeType(check.probe_type));
  const invalidChecks = checks.flatMap((check, index) => {
    const issues: Array<{ name: string; reason: string }> = [];
    if (!hasExecutableQaEvidence(check)) {
      issues.push({
        name: `qa_checks[${index}]`,
        reason: "qa_check requires a command or tool descriptor",
      });
    }
    if (!hasQaObservedEvidence(check)) {
      issues.push({
        name: `qa_checks[${index}]`,
        reason: "qa_check requires observed_output",
      });
    }
    if (!hasQaExitCodeWhenCommanded(check)) {
      issues.push({
        name: `qa_checks[${index}]`,
        reason: "qa_check with a command requires exit_code",
      });
    }
    return issues;
  });
  const missingEvidence = readStringArray(context.normalizedOutputs.canonical.qa_missing_evidence);
  const confidenceGaps = readStringArray(context.normalizedOutputs.canonical.qa_confidence_gaps);
  const environmentLimits = readStringArray(
    context.normalizedOutputs.canonical.qa_environment_limits,
  );
  const riskRegister = Array.isArray(context.consumedOutputView.outputs.risk_register)
    ? context.consumedOutputView.outputs.risk_register.filter(isDesignRiskItem)
    : undefined;
  const requiredEvidence = collectPlanningRequiredEvidence(riskRegister);
  const coverageTexts = uniqueStrings([
    ...collectQaCoverageTexts(context.normalizedOutputs.canonical),
    ...verificationCoverageTexts,
  ]);
  const uncoveredRequiredEvidence = requiredEvidence.filter(
    (evidenceName) => !isRequiredEvidenceCovered(evidenceName, coverageTexts),
  );
  const evidenceBackedFailedChecks = failedChecks.filter(
    (check) =>
      hasExecutableQaEvidence(check) &&
      hasQaObservedEvidence(check) &&
      hasQaExitCodeWhenCommanded(check),
  );

  if (invalidChecks.length > 0) {
    return invalidChecks;
  }

  if (verdict === "pass") {
    const blockers: string[] = [];
    if (!hasExecutableEvidence) {
      blockers.push("pass verdict requires at least one executable QA check");
    }
    if (!hasAdversarialProbe) {
      blockers.push("pass verdict requires at least one adversarial QA probe");
    }
    if (failedChecks.length > 0) {
      blockers.push("pass verdict cannot coexist with failed qa_checks");
    }
    if (inconclusiveChecks.length > 0) {
      blockers.push("pass verdict cannot coexist with inconclusive qa_checks");
    }
    if ((missingEvidence?.length ?? 0) > 0) {
      blockers.push("pass verdict cannot carry qa_missing_evidence");
    }
    if ((confidenceGaps?.length ?? 0) > 0) {
      blockers.push("pass verdict cannot carry qa_confidence_gaps");
    }
    if ((environmentLimits?.length ?? 0) > 0) {
      blockers.push("pass verdict cannot carry qa_environment_limits");
    }
    if (uncoveredRequiredEvidence.length > 0) {
      blockers.push(
        `pass verdict must cover plan required_evidence: ${uncoveredRequiredEvidence.join(", ")}`,
      );
    }
    return blockers.map((reason) => ({ name: "qa_verdict", reason }));
  }

  if (verdict === "fail" && failedChecks.length === 0) {
    return [
      {
        name: "qa_verdict",
        reason: "fail verdict requires at least one failed qa_check",
      },
    ];
  }

  if (verdict === "fail" && evidenceBackedFailedChecks.length === 0) {
    return [
      {
        name: "qa_verdict",
        reason: "fail verdict requires at least one evidence-backed failed qa_check",
      },
    ];
  }

  if (verdict === "inconclusive" && uncoveredRequiredEvidence.length > 0) {
    const qaMissingEvidence = missingEvidence ?? [];
    const undisclosedRequirements = uncoveredRequiredEvidence.filter(
      (evidenceName) => !evidenceListMentionsKey(qaMissingEvidence, evidenceName),
    );
    if (undisclosedRequirements.length > 0) {
      return undisclosedRequirements.map((evidenceName) => ({
        name: "qa_missing_evidence",
        reason: `qa_missing_evidence must disclose uncovered plan required_evidence: ${evidenceName}`,
      }));
    }
  }

  return [];
}

export class QaOutputValidator implements SkillOutputValidator {
  readonly name = "qa";

  appliesTo(context: SkillValidationContext): boolean {
    return (
      [...context.semanticSchemaIds].some((schemaId) => schemaId.startsWith("qa.")) ||
      context.skill.name === "qa" ||
      skillDeclaresAllOutputs(context.skill, QA_SEMANTIC_OUTPUT_KEYS)
    );
  }

  validate(context: SkillValidationContext) {
    const invalid = annotateSemanticIssues(
      validateQaSemanticOutputs(context, context.evidence.getVerificationCoverageTexts()),
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
