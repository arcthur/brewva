// Curated skills contract subpath. Skills are advisory SkillCards; external
// authority lives in capability manifests and tool policy.
export type {
  LoadableSkillCategory,
  OverlaySkillDocument,
  ParsedSkillDocument,
  ProducerContract,
  ProjectGuidanceEntry,
  ProjectGuidanceStrength,
  SemanticArtifactSchemaId,
  SkillCard,
  SkillCardLike,
  SkillCardOverride,
  SkillCategory,
  SkillDocument,
  SkillIndexOrigin,
  SkillOutputContract,
  SkillOutputEnumContract,
  SkillOutputJsonContract,
  SkillOutputTextContract,
  SkillOverlayCard,
  SkillOverlayCategory,
  SkillRefreshInput,
  SkillRefreshResult,
  SkillRegistryLoadReport,
  SkillRegistryRoot,
  SkillResourceSet,
  SkillRootSource,
  SkillSelectionPolicy,
  SkillSemanticBindings,
  SkillSystemInstallResult,
  SkillsIndexEntry,
  SkillsIndexFile,
} from "./domain/skills/types.js";
export type {
  SkillArtifactIssueTier,
  SkillNormalizedBlockingState,
  SkillNormalizedOutputIssue,
  SkillNormalizedOutputsView,
} from "./domain/skills/normalization.js";
export {
  isPlanningOwnerLane,
  isReviewChangeCategory,
  isReviewLaneName,
  normalizeReviewLaneName,
  PLANNING_OWNER_LANES,
  REVIEW_CHANGE_CATEGORIES,
  REVIEW_LANE_NAMES,
  REVIEW_REPORT_OUTPUT_CONTRACT,
  REVIEW_REPORT_REQUIRED_FIELDS,
} from "./domain/skills/review.js";
export type {
  PlanningOwnerLane,
  ReviewChangeCategory,
  ReviewLaneName,
  ReviewPrecedentConsultDisposition,
  ReviewPrecedentConsultStatus,
  ReviewReportArtifact,
  ReviewReportRequiredField,
} from "./domain/skills/review.js";
export { DESIGN_EXECUTION_MODE_HINTS, PLANNING_EVIDENCE_KEYS } from "./domain/skills/planning.js";
export type {
  DesignExecutionModeHint,
  DesignExecutionStep,
  DesignImplementationTarget,
  DesignRiskItem,
  DesignRiskSeverity,
  PlanningArtifactSet,
  PlanningEvidenceKey,
  PlanningEvidenceState,
} from "./domain/skills/planning.js";
export {
  createEmptySkillResources,
  mergeOverlayCard,
  mergeSkillResources,
  parseSkillDocument,
} from "./domain/skills/contract.js";
export {
  getProducerOutputContracts,
  getProducerSemanticBindings,
  listProducerOutputs,
  parseProducerContractFile,
} from "./domain/skills/producers.js";
export {
  FIELD_TO_PLANE,
  SELECTION_PROFILE_SOURCE_FIELDS,
  buildSkillSelectionProfile,
  hasSelectionProfileSignals,
  type SkillFieldPath,
} from "./domain/skills/profiles.js";
export { discoverSkillRegistryRoots, SkillRegistry } from "./domain/skills/registry.js";
export {
  collectPlanningRiskCategories,
  coercePlanningArtifactSet,
} from "./domain/skills/planning-normalization.js";
export { coerceReviewReportArtifact } from "./domain/skills/review-normalization.js";
export { SKILL_REFRESH_RECORDED_EVENT_TYPE } from "./domain/skills/events.js";
export { SKILLS_EVENT_DESCRIPTORS } from "./domain/skills/event-descriptors.js";
export {
  createSkillsInspectSurface,
  createSkillsOperatorSurface,
  createSkillsSurfaceMethods,
} from "./domain/skills/runtime-surface.js";
export type {
  RuntimeSkillsSurfaceMethods,
  SkillsSurfaceDependencies,
} from "./domain/skills/runtime-surface.js";
export { registerSkillsDomain } from "./domain/skills/registrar.js";
export type { RuntimeSkillsDomainRegistration } from "./domain/skills/registrar.js";
export {
  getSemanticArtifactOutputContract,
  renderSemanticArtifactExample,
} from "./domain/skills/semantic-artifact-catalog.js";
export {
  LEGACY_SEMANTIC_ARTIFACT_SCHEMA_ID_ALIASES,
  SEMANTIC_ARTIFACT_SCHEMA_IDS,
  isSemanticArtifactSchemaId,
  normalizeSemanticArtifactSchemaId,
} from "./domain/skills/semantic-artifacts.js";
export { ensureBundledSystemSkills } from "./domain/skills/system-install.js";
