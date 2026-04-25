import type { BoxCreateReason, BoxScope, SnapshotRef } from "../contract.js";

export interface StoredBox {
  id: string;
  scope: BoxScope;
  fingerprint: string;
  createReason: BoxCreateReason;
  createdAt: string;
  lastExecAt?: string;
  snapshots: SnapshotRef[];
  parentBoxId?: string;
  parentSnapshotId?: string;
  supersededByBoxId?: string;
  restoredSnapshotId?: string;
  native?: unknown;
  runningExecCount: number;
}

export interface PersistedBoxPlaneIndex {
  version: 1;
  boxes: Array<Omit<StoredBox, "native" | "runningExecCount">>;
}
