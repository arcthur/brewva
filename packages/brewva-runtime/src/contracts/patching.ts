import type { PatchSetRollbackFailureReason } from "./governance.js";
import type { RollbackOutcome } from "./shared.js";

export type PatchFileAction = "add" | "modify" | "delete";

export interface PatchFileChange {
  path: string;
  action: PatchFileAction;
  beforeHash?: string;
  afterHash?: string;
  diffText?: string;
  artifactRef?: string;
}

export interface PatchSet {
  id: string;
  createdAt: number;
  summary?: string;
  changes: PatchFileChange[];
}

export type WorkerStatus = "ok" | "error" | "skipped";

export interface WorkerResult {
  workerId: string;
  status: WorkerStatus;
  summary: string;
  patches?: PatchSet;
  evidenceIds?: string[];
  errorMessage?: string;
}

export interface PatchConflict {
  path: string;
  workerIds: string[];
  patchSetIds: string[];
}

export interface WorkerMergeReport {
  status: "empty" | "conflicts" | "merged";
  workerIds: string[];
  conflicts: PatchConflict[];
  mergedPatchSet?: PatchSet;
}

export type PatchApplyFailureReason =
  | "empty_patchset"
  | "invalid_path"
  | "missing_artifact"
  | "before_hash_mismatch"
  | "after_hash_mismatch"
  | "write_failed";

export interface PatchApplyResult {
  ok: boolean;
  patchSetId?: string;
  appliedPaths: string[];
  failedPaths: string[];
  reason?: PatchApplyFailureReason;
}

export interface WorkerApplyReport {
  status: "empty" | "conflicts" | "applied" | "apply_failed";
  workerIds: string[];
  conflicts: PatchConflict[];
  mergedPatchSet?: PatchSet;
  appliedPatchSetId?: string;
  appliedPaths: string[];
  failedPaths: string[];
  reason?: PatchApplyFailureReason;
}

export interface RollbackResult extends RollbackOutcome<PatchSetRollbackFailureReason> {
  patchSetId?: string;
}
