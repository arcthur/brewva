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
} from "./types.js";
export {
  FILE_SNAPSHOT_CAPTURED_EVENT_TYPE,
  PATCH_RECORDED_EVENT_TYPE,
  REDO_EVENT_TYPE,
  REVERSIBLE_MUTATION_PREPARED_EVENT_TYPE,
  REVERSIBLE_MUTATION_RECORDED_EVENT_TYPE,
  REVERSIBLE_MUTATION_REDONE_EVENT_TYPE,
  REVERSIBLE_MUTATION_ROLLED_BACK_EVENT_TYPE,
  ROLLBACK_EVENT_TYPE,
} from "./events.js";
export { registerPatchingDomain } from "./registrar.js";
export type { RuntimePatchingDomainRegistration } from "./registrar.js";
export type { FileChangeService } from "./file-change.js";
export { FileChangeTracker } from "./file-change-tracker.js";
export {
  DEFAULT_PATCH_HISTORY_SNAPSHOTS_DIR,
  PATCH_HISTORY_FILE,
  collectPersistedPatchPaths,
  listPersistedPatchSets,
  readPersistedPatchHistory,
  resolveSessionPatchHistoryDirectory,
  resolveSessionPatchHistoryPath,
  sanitizePatchHistorySessionId,
} from "./patch-history.js";
export type {
  PersistedPatchChange,
  PersistedPatchHistory,
  PersistedPatchSet,
  PersistedPatchSetStatus,
} from "./patch-history.js";
