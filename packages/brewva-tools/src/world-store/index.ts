export { buildWorldCheckpointBlock, type WorldCheckpointBlock } from "./checkpoint-block.js";
export {
  projectWorldDiff,
  type WorldDiff,
  type WorldFileChange,
  type WorldFileDiff,
} from "./diff.js";
// Shared by the delegation fork copy (cross-package): the one git-scope lister
// and the one runtime-data-root exclusion set, so the fork and capture agree.
export { listGitScopedPaths, RUNTIME_DATA_ROOT_NAMES } from "./enumerate.js";
export { createWorkspaceWorldStore } from "./store.js";
export {
  WORLD_BLOB_HASH_PREFIX,
  type WorkspaceWorldStore,
  type WorldCaptureFailure,
  type WorldCaptureFailureReason,
  type WorldCaptureInput,
  type WorldCaptureResult,
  type WorldCaptureSuccess,
  type WorldEnumerationSource,
  type WorldFileMode,
  type WorldMaintenanceNote,
  type WorldManifest,
  type WorldManifestEntry,
  type WorldRef,
  type WorldRestoreFailure,
  type WorldRestoreFailureReason,
  type WorldRestoreResult,
  type WorldRestoreSuccess,
  type WorldStoreOptions,
  type WorldSweepResult,
  type WorldSweepSkipReason,
  type WorldVerification,
} from "./types.js";
