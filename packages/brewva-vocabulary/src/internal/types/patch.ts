import type { JsonValue } from "./foundation.js";

export type PatchFileAction = "add" | "modify" | "delete" | "rename" | (string & {});

export interface PatchFileChange {
  readonly path: string;
  readonly action: PatchFileAction;
  readonly beforeHash?: string;
  readonly afterHash?: string;
  readonly artifactRef?: string;
  readonly newPath?: string;
  readonly oldPath?: string;
}

export interface PatchConflict {
  readonly path: string;
  readonly workerIds: readonly string[];
  readonly patchSetIds: readonly string[];
}

export interface PatchSet {
  readonly id: string;
  readonly createdAt?: number;
  readonly summary?: string;
  readonly status?: string;
  readonly sourcePatchPlanId?: string;
  readonly sourceSnapshotIds?: readonly string[];
  readonly preflight?: {
    readonly ok: boolean;
    readonly staleRecovered?: boolean;
    readonly generatedFileRejected?: boolean;
    readonly reason?: string;
  };
  readonly rollbackArtifactRef?: string;
  changes: PatchFileChange[];
}

export type PatchApplyFailureReason = string;

export interface PatchApplyResult {
  readonly ok: boolean;
  readonly patchSetId?: string;
  readonly appliedPaths?: readonly string[];
  readonly failedPaths?: readonly string[];
  readonly reason?: PatchApplyFailureReason;
}

export type WorkerMergeStatus = "empty" | "ready" | "conflicts";
export type WorkerApplyStatus = "empty" | "applied" | "conflicts" | "apply_failed";

export interface WorkerMergeReport {
  readonly status: WorkerMergeStatus;
  readonly workerIds: readonly string[];
  readonly conflicts?: readonly PatchConflict[];
  readonly mergedPatchSet?: PatchSet;
}

export interface WorkerApplyReport {
  readonly status: WorkerApplyStatus;
  readonly workerIds: readonly string[];
  readonly conflicts?: readonly PatchConflict[];
  readonly mergedPatchSet?: PatchSet;
  readonly appliedPaths: readonly string[];
  readonly failedPaths: readonly string[];
  readonly appliedPatchSetId?: string;
  readonly reason?: string;
}

export interface WorkerResult {
  readonly status?: string;
  readonly patches?: PatchSet;
  readonly [key: string]: unknown;
}
export type WorkerStatus = string;

export type PersistedPatchSetStatus = string;

export interface PersistedPatchChange {
  readonly path?: string;
  readonly newPath?: string;
  readonly oldPath?: string;
  readonly action?: PatchFileAction;
}

export interface PersistedPatchSet {
  readonly id?: string;
  readonly status?: PersistedPatchSetStatus;
  readonly changes: readonly PersistedPatchChange[];
  readonly toolName?: string;
  readonly appliedAt?: number;
  readonly summary?: string;
}

export interface PersistedPatchHistory {
  readonly patches: readonly PersistedPatchSet[];
}

export interface RollbackResult {
  readonly ok: boolean;
  readonly patchSetId?: string;
  readonly reason?: string;
}

export interface RedoResult {
  readonly ok: boolean;
  readonly patchSetId?: string;
  readonly reason?: string;
}

export type PatchHistoryRootInput =
  | string
  | {
      readonly path?: string;
      readonly root?: string;
      readonly workspaceRoot?: string;
      readonly sessionId?: string;
    };

export function patchHistoryPayload(value: unknown): Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, JsonValue>)
    : {};
}
