export const SEMANTIC_ARTIFACT_SCHEMA_IDS = [
  "planning.design_spec.v2",
  "planning.execution_plan.v2",
  "planning.execution_mode_hint.v2",
  "planning.risk_register.v2",
  "planning.implementation_targets.v2",
  "planning.success_criteria.v2",
  "planning.approach_simplicity_check.v2",
  "planning.scope_declaration.v2",
  "implementation.change_set.v2",
  "implementation.files_changed.v2",
  "implementation.verification_evidence.v2",
  "review.review_report.v2",
  "review.review_findings.v2",
  "review.merge_decision.v2",
  "verifier.verifier_report.v2",
  "verifier.verifier_findings.v2",
  "verifier.verifier_verdict.v2",
  "verifier.verifier_checks.v2",
  "verifier.verifier_missing_evidence.v2",
  "verifier.verifier_confidence_gaps.v2",
  "verifier.verifier_environment_limits.v2",
  "ship.ship_report.v2",
  "ship.release_checklist.v2",
  "ship.ship_decision.v2",
] as const;

type SemanticArtifactSchemaId = (typeof SEMANTIC_ARTIFACT_SCHEMA_IDS)[number];

export const LEGACY_SEMANTIC_ARTIFACT_SCHEMA_ID_ALIASES = {
  "qa.qa_report.v2": "verifier.verifier_report.v2",
  "qa.qa_findings.v2": "verifier.verifier_findings.v2",
  "qa.qa_verdict.v2": "verifier.verifier_verdict.v2",
  "qa.qa_checks.v2": "verifier.verifier_checks.v2",
  "qa.qa_missing_evidence.v2": "verifier.verifier_missing_evidence.v2",
  "qa.qa_confidence_gaps.v2": "verifier.verifier_confidence_gaps.v2",
  "qa.qa_environment_limits.v2": "verifier.verifier_environment_limits.v2",
} as const satisfies Record<string, SemanticArtifactSchemaId>;

export function isSemanticArtifactSchemaId(value: string): value is SemanticArtifactSchemaId {
  return (SEMANTIC_ARTIFACT_SCHEMA_IDS as readonly string[]).includes(value);
}

export function normalizeSemanticArtifactSchemaId(
  value: string,
): SemanticArtifactSchemaId | undefined {
  const normalized = value.trim();
  if (isSemanticArtifactSchemaId(normalized)) {
    return normalized;
  }
  return LEGACY_SEMANTIC_ARTIFACT_SCHEMA_ID_ALIASES[
    normalized as keyof typeof LEGACY_SEMANTIC_ARTIFACT_SCHEMA_ID_ALIASES
  ];
}
