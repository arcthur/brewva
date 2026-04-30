import type {
  DelegationAdoptionDecision,
  DelegationAdoptionRecord,
  DelegationExecutionPrimitive,
  DelegationOutcomeKind,
  QaSubagentOutcomeData,
} from "./delegation.js";

export type DelegationAdoptionContractId =
  | "delegation.consult.review"
  | "delegation.fork.consult"
  | "delegation.qa"
  | "delegation.patch";

export interface DelegationAdoptionInput {
  outcomeKind: DelegationOutcomeKind;
  executionPrimitive?: DelegationExecutionPrimitive;
  resultData?: Record<string, unknown>;
  patchChangeCount?: number;
  skillValidationOk?: boolean;
}

function adoptionRecord(input: {
  contractId: DelegationAdoptionContractId;
  decision: DelegationAdoptionDecision;
  reason: string;
  requiredEvidence?: string[];
}): DelegationAdoptionRecord {
  return {
    contractId: input.contractId,
    decision: input.decision,
    reason: input.reason,
    requiredEvidence: input.requiredEvidence,
  };
}

function readQaOutcome(value: unknown): QaSubagentOutcomeData | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (record.kind !== "qa") {
    return undefined;
  }
  if (record.verdict !== "pass" && record.verdict !== "fail" && record.verdict !== "inconclusive") {
    return undefined;
  }
  return {
    kind: "qa",
    verdict: record.verdict,
    checks: Array.isArray(record.checks) ? (record.checks as QaSubagentOutcomeData["checks"]) : [],
  };
}

function readReviewMergePosture(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  return typeof record.mergePosture === "string"
    ? record.mergePosture
    : typeof record.merge_decision === "string"
      ? record.merge_decision
      : undefined;
}

export function evaluateDelegationAdoption(
  input: DelegationAdoptionInput,
): DelegationAdoptionRecord {
  if (input.executionPrimitive === "fork" && input.outcomeKind === "consult") {
    return adoptionRecord({
      contractId: "delegation.fork.consult",
      decision: "require_human",
      reason: "fork_consult_requires_parent_judgment",
      requiredEvidence: ["fork_evidence"],
    });
  }

  if (input.outcomeKind === "qa") {
    const qa = readQaOutcome(input.resultData);
    if (qa?.verdict === "pass" && qa.checks.length > 0) {
      return adoptionRecord({
        contractId: "delegation.qa",
        decision: "allow",
        reason: "qa_passed_with_checks",
        requiredEvidence: ["qa_checks"],
      });
    }
    if (qa?.verdict === "fail") {
      return adoptionRecord({
        contractId: "delegation.qa",
        decision: "block",
        reason: "qa_failed",
        requiredEvidence: ["qa_checks"],
      });
    }
    return adoptionRecord({
      contractId: "delegation.qa",
      decision: "require_human",
      reason: "qa_inconclusive_or_missing_checks",
      requiredEvidence: ["qa_checks"],
    });
  }

  if (input.outcomeKind === "patch") {
    if (input.patchChangeCount === undefined) {
      return adoptionRecord({
        contractId: "delegation.patch",
        decision: "require_human",
        reason: "patch_changes_not_reported",
        requiredEvidence: ["patch_changes", "validation_pass"],
      });
    }
    if (input.patchChangeCount <= 0) {
      return adoptionRecord({
        contractId: "delegation.patch",
        decision: "block",
        reason: "patch_missing_changes",
        requiredEvidence: ["patch_changes", "validation_pass"],
      });
    }
    if (input.skillValidationOk === true) {
      return adoptionRecord({
        contractId: "delegation.patch",
        decision: "allow",
        reason: "patch_has_changes_and_validation_passed",
        requiredEvidence: ["patch_changes", "validation_pass"],
      });
    }
    if (input.skillValidationOk === false) {
      return adoptionRecord({
        contractId: "delegation.patch",
        decision: "block",
        reason: "patch_validation_failed",
        requiredEvidence: ["patch_changes", "validation_pass"],
      });
    }
    return adoptionRecord({
      contractId: "delegation.patch",
      decision: "require_human",
      reason: "patch_validation_missing",
      requiredEvidence: ["patch_changes", "validation_pass"],
    });
  }

  const mergePosture = readReviewMergePosture(input.resultData);
  if (mergePosture === "ready") {
    return adoptionRecord({
      contractId: "delegation.consult.review",
      decision: "allow",
      reason: "review_ready",
      requiredEvidence: ["review_findings"],
    });
  }
  if (mergePosture === "needs_changes" || mergePosture === "blocked") {
    return adoptionRecord({
      contractId: "delegation.consult.review",
      decision: "block",
      reason: `review_${mergePosture}`,
      requiredEvidence: ["review_findings"],
    });
  }
  return adoptionRecord({
    contractId: "delegation.consult.review",
    decision: "require_human",
    reason: "consult_adoption_requires_parent_judgment",
    requiredEvidence: ["consult_evidence"],
  });
}
