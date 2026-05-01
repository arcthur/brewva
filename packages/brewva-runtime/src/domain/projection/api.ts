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
  createProjectionSurfaceMethods,
  projectionRuntimeSurface,
  projectionSurfaceContribution,
} from "./runtime-surface.js";
export type { RuntimeProjectionSurfaceMethods } from "./runtime-surface.js";
export { registerProjectionDomain } from "./registrar.js";
export type { RuntimeProjectionDomainRegistration } from "./registrar.js";
