import type {
  DelegationAdoptionDecision,
  DelegationAdoptionRecord,
  DelegationExecutionPrimitive,
  DelegationOutcomeKind,
  VerifierSubagentOutcomeData,
} from "./types.js";

export type DelegationAdoptionContractId =
  | "delegation.evidence"
  | "delegation.consult.review"
  | "delegation.fork.consult"
  | "delegation.verifier"
  | "delegation.patch"
  | "delegation.knowledge";

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

function readVerifierOutcome(value: unknown): VerifierSubagentOutcomeData | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (record.kind !== undefined && record.kind !== "verifier" && record.kind !== "qa") {
    return undefined;
  }
  const verdict = record.verdict ?? record.verifier_verdict ?? record.qa_verdict;
  if (verdict !== "pass" && verdict !== "fail" && verdict !== "inconclusive") {
    return undefined;
  }
  const checks = record.checks ?? record.verifier_checks ?? record.qa_checks;
  return {
    kind: "verifier",
    verdict,
    checks: Array.isArray(checks) ? (checks as VerifierSubagentOutcomeData["checks"]) : [],
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

  if (input.outcomeKind === "evidence") {
    return adoptionRecord({
      contractId: "delegation.evidence",
      decision: "require_human",
      reason: "evidence_requires_parent_judgment",
      requiredEvidence: ["source_refs"],
    });
  }

  if (input.outcomeKind === "knowledge") {
    return adoptionRecord({
      contractId: "delegation.knowledge",
      decision: "require_human",
      reason: "knowledge_requires_parent_promotion",
      requiredEvidence: ["provenance", "promotion_receipt"],
    });
  }

  if (input.outcomeKind === "verifier") {
    const verifier = readVerifierOutcome(input.resultData);
    if (verifier?.verdict === "pass" && verifier.checks.length > 0) {
      return adoptionRecord({
        contractId: "delegation.verifier",
        decision: "allow",
        reason: "verifier_passed_with_checks",
        requiredEvidence: ["verifier_checks"],
      });
    }
    if (verifier?.verdict === "fail") {
      return adoptionRecord({
        contractId: "delegation.verifier",
        decision: "block",
        reason: "verifier_failed",
        requiredEvidence: ["verifier_checks"],
      });
    }
    return adoptionRecord({
      contractId: "delegation.verifier",
      decision: "require_human",
      reason: "verifier_inconclusive_or_missing_checks",
      requiredEvidence: ["verifier_checks"],
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
