import type { PatchSetRedoFailureReason, PatchSetRollbackFailureReason } from "./governance.js";
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

export type WorkerResult =
  | {
      workerId: string;
      status: "ok";
      summary: string;
      patches: PatchSet;
      evidenceIds?: string[];
      errorMessage?: undefined;
    }
  | {
      workerId: string;
      status: "error";
      summary: string;
      patches?: PatchSet;
      evidenceIds?: undefined;
      errorMessage: string;
    }
  | {
      workerId: string;
      status: "skipped";
      summary: string;
      patches?: undefined;
      evidenceIds?: undefined;
      errorMessage?: undefined;
    };

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

export type PatchApplyResult =
  | {
      ok: true;
      patchSetId: string;
      appliedPaths: string[];
      failedPaths: string[];
    }
  | {
      ok: false;
      patchSetId: string;
      appliedPaths: string[];
      failedPaths: string[];
      reason: PatchApplyFailureReason;
    };

export type WorkerApplyReport =
  | {
      status: "empty";
      workerIds: string[];
      conflicts: PatchConflict[];
      appliedPaths: string[];
      failedPaths: string[];
      reason: "empty_patchset";
    }
  | {
      status: "conflicts";
      workerIds: string[];
      conflicts: PatchConflict[];
      mergedPatchSet?: PatchSet;
      appliedPaths: string[];
      failedPaths: string[];
    }
  | {
      status: "applied";
      workerIds: string[];
      conflicts: PatchConflict[];
      mergedPatchSet?: PatchSet;
      appliedPatchSetId: string;
      appliedPaths: string[];
      failedPaths: string[];
    }
  | {
      status: "apply_failed";
      workerIds: string[];
      conflicts: PatchConflict[];
      mergedPatchSet?: PatchSet;
      appliedPatchSetId: string;
      appliedPaths: string[];
      failedPaths: string[];
      reason: PatchApplyFailureReason;
    };

export type RollbackResult = RollbackOutcome<PatchSetRollbackFailureReason> & {
  patchSetId?: string;
  mutationReceiptId?: string;
};

export type RedoResult = RollbackOutcome<PatchSetRedoFailureReason> & {
  patchSetId?: string;
  mutationReceiptId?: string;
};
