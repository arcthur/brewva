// Curated projection contract subpath. Keep root imports focused on createBrewvaRuntime and explicit port types.
export { WORKFLOW_ARTIFACT_KINDS } from "./domain/projection/workflow/types.js";
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
} from "./domain/projection/workflow/types.js";
export {
  deriveWorkflowArtifacts,
  deriveWorkflowArtifactsFromEvent,
} from "./domain/projection/workflow/artifact-derivation.js";
export { deriveWorkflowStatus } from "./domain/projection/workflow/status-derivation.js";
export { resolveWorkspaceRevision } from "./domain/projection/workflow/workspace-revision.js";
