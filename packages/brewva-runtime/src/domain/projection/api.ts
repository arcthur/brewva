export type {
  ProjectionExtractionResult,
  ProjectionSourceRef,
  ProjectionStoreState,
  ProjectionUnit,
  ProjectionUnitCandidate,
  ProjectionUnitResolveDirective,
  ProjectionUnitStatus,
  WorkingProjectionEntry,
  WorkingProjectionSnapshot,
} from "./types.js";
export { ProjectionEngine } from "./engine.js";
export type { ProjectionEngineOptions, ProjectionRebuildFromTapeResult } from "./engine.js";
export {
  buildSessionRewindCheckpointId,
  buildSessionRewindProjection,
  buildSessionRewindState,
  cloneSessionRedoRecord,
  cloneSessionRewindCheckpoint,
  cloneSessionRewindPromptSnapshot,
  cloneSessionRewindRecord,
  collectSessionRewindAbandonedCheckpointIds,
  collectSessionRewindActiveCheckpointEventIds,
  isSessionRewindCheckpointActive,
  isSessionRewindCheckpointSelectable,
  listSessionRewindPatchSetIdsAfterCheckpoint,
  listSessionRewindTargets,
  summarizeSessionRewindPatchFileChanges,
} from "./session-rewind.js";
export type {
  SessionRewindPatchEventProjection,
  SessionRewindPatchProjection,
  SessionRewindPatchScopeOptions,
  SessionRewindProjection,
} from "./session-rewind.js";
export {
  createProjectionSourceRef,
  extractProjectionFromEvent,
  extractWorkflowProjectionFromEvents,
  formatWorkflowProjectionStatement,
} from "./extractor.js";
export {
  deriveTurnEffectCommitmentProjection,
  renderTurnConsequenceDigest,
} from "./effects/api.js";
export type {
  DeriveTurnEffectCommitmentProjectionInput,
  EffectAuthorityDecisionSummary,
  EffectCommitmentAttempt,
  EffectCommitmentSummary,
  EffectExecutionSummary,
  EffectRecoverySummary,
  RenderTurnConsequenceDigestOptions,
  TurnEffectCommitmentProjection,
} from "./effects/api.js";
export { WORKFLOW_ARTIFACT_KINDS } from "./workflow/types.js";
export type {
  WorkflowAcceptanceStatus,
  WorkflowArtifact,
  WorkflowArtifactFreshness,
  WorkflowArtifactKind,
  WorkflowArtifactState,
  WorkflowFinishState,
  WorkflowFinishView,
  WorkflowImplementationStatus,
  WorkflowLaneStatus,
  WorkflowPlanningStatus,
  WorkflowPosture,
  WorkflowPresenceStatus,
  WorkflowStatusSnapshot,
} from "./workflow/types.js";
export {
  deriveWorkflowArtifacts,
  deriveWorkflowArtifactsFromEvent,
  latestArtifactByKind,
} from "./workflow/artifact-derivation.js";
export {
  collectCoveredRequiredEvidence,
  collectVerifierCoverageTexts,
  collectVerificationCoverageTexts,
  isRequiredEvidenceCovered,
  normalizeComparableText,
} from "./workflow/coverage-utils.js";
export { deriveWorkflowStatus } from "./workflow/status-derivation.js";
export { resolveWorkspaceRevision } from "./workflow/workspace-revision.js";
