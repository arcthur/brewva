export {
  PATCH_HISTORY_FILE,
  collectPersistedPatchPaths,
  listPersistedPatchSets,
  readPersistedPatchHistory,
  type PersistedPatchChange,
  type PersistedPatchHistory,
  type PersistedPatchSet,
  type PersistedPatchSetStatus,
} from "./domain/patching/api.js";
export {
  collectPathCandidates,
  isIgnoredWorkspacePath,
  normalizeWorkspaceRelativePath,
  resolveWorkspacePath,
  toWorkspaceRelativePath,
} from "./config/workspace-paths.js";

// BEGIN curated boundary exports
export type {
  PatchApplyFailureReason,
  PatchApplyResult,
  PatchConflict,
  PatchFileAction,
  PatchFileChange,
  PatchSet,
  RedoResult,
  RollbackResult,
  WorkerApplyReport,
  WorkerMergeReport,
  WorkerResult,
  WorkerStatus,
} from "./domain/patching/types.js";
// END curated boundary exports
