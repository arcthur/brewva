import type {
  PlanningEvidenceKey,
  PlanningEvidenceState,
  SkillConsumedOutputsView,
  SkillNormalizedOutputsView,
  SemanticArtifactSchemaId,
  SkillDocument,
  SkillOutputContract,
  SkillSemanticBindings,
} from "../../contracts/index.js";

export type VerificationEvidenceState = "present" | "stale" | "missing";

export interface VerificationEvidenceContext {
  state: VerificationEvidenceState;
  coverageTexts: string[];
}

export interface SkillValidationEvidenceProvider {
  getPlanningEvidenceState(): Partial<Record<PlanningEvidenceKey, PlanningEvidenceState>>;
  getVerificationEvidenceContext(): VerificationEvidenceContext;
  getVerificationCoverageTexts(): readonly string[];
}

export interface SkillValidationContext {
  sessionId: string;
  skill: SkillDocument;
  outputs: Record<string, unknown>;
  consumedOutputs: Record<string, unknown>;
  consumedOutputView: SkillConsumedOutputsView;
  normalizedOutputs: SkillNormalizedOutputsView;
  outputContracts: Record<string, SkillOutputContract>;
  semanticBindings: SkillSemanticBindings | undefined;
  semanticSchemaIds: ReadonlySet<SemanticArtifactSchemaId>;
  evidence: SkillValidationEvidenceProvider;
}
