import type { ProtocolRecord } from "./foundation.js";
import type { PatchFileChange } from "./patch.js";

export interface SourceResourceDescriptor {
  readonly uri: string;
  readonly path?: string;
  readonly mediaType?: string;
}

export interface SourceLineAnchor {
  readonly line: number;
  readonly text: string;
}

export interface SourceSnapshot {
  readonly id: string;
  readonly uri: string;
  readonly path?: string;
  readonly contentHash: string;
  readonly createdAt: number;
  readonly lineCount: number;
  readonly anchors: readonly SourceLineAnchor[];
  /**
   * 1-based line numbers this snapshot's originating `source_read` actually
   * displayed. An edit intent may only target a seen line: the seen set is the
   * harness-held seen-proof that replaced the per-line token (a model can cite a
   * line only if the read showed it). Persisted so a resumed session keeps its
   * seen-proof without re-reading; in-session reveal-on-reject augments a working
   * copy of this set but is not re-persisted.
   */
  readonly seenLines: readonly number[];
}

export type SourcePatchIntent =
  | {
      readonly kind: "replace_lines";
      readonly uri: string;
      readonly snapshotId: string;
      readonly startLine: number;
      readonly endLine?: number;
      readonly replacement: string;
    }
  | {
      readonly kind: "insert_before_line" | "insert_after_line";
      readonly uri: string;
      readonly snapshotId: string;
      readonly line: number;
      readonly insertion: string;
    }
  | {
      readonly kind: "delete_lines";
      readonly uri: string;
      readonly snapshotId: string;
      readonly startLine: number;
      readonly endLine?: number;
    }
  | {
      readonly kind: "create_file";
      readonly uri: string;
      readonly content: string;
    }
  | {
      readonly kind: "delete_file";
      readonly uri: string;
    }
  | {
      readonly kind: "rename_file";
      readonly uri: string;
      readonly newUri: string;
    };

export interface SourcePatchConflict {
  readonly uri: string;
  readonly reason: string;
  readonly message?: string;
}

export interface SourcePatchPreflight {
  readonly ok: boolean;
  readonly staleRecovered: boolean;
  readonly generatedFileRejected: boolean;
  readonly reason?: string;
}

export interface SourcePatchPlan {
  readonly id: string;
  readonly status: "prepared" | "conflict" | "applied" | "failed";
  readonly createdAt: number;
  readonly summary?: string;
  readonly snapshots: readonly string[];
  readonly intents: readonly SourcePatchIntent[];
  readonly changes: readonly PatchFileChange[];
  readonly conflicts: readonly SourcePatchConflict[];
  readonly preflight: SourcePatchPreflight;
  readonly preview: string;
  readonly metadata?: ProtocolRecord;
}

export interface SourcePatchApplyResult {
  readonly ok: boolean;
  readonly planId: string;
  readonly patchSetId?: string;
  readonly appliedPaths: readonly string[];
  readonly failedPaths: readonly string[];
  readonly reason?: string;
  /**
   * Workspace-relative path of the rollback manifest captured before the
   * mutations were applied. Carried on the durable apply receipt so rollback
   * discovery binds to recorded artifact identity instead of re-deriving
   * paths from directory conventions.
   */
  readonly rollbackArtifactRef?: string;
}

export interface SourcePatchStaleRecoveryRecord {
  readonly planId: string;
  readonly snapshotId: string;
  readonly uri: string;
  readonly recovered: boolean;
  readonly reason?: string;
}
