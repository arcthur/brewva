export type BoxScopeKind = "session" | "task" | "ephemeral";
export type BoxNetworkCapability = { mode: "off" } | { mode: "allowlist"; allow: string[] };

export interface BoxVolumeCapability {
  hostPath: string;
  guestPath: string;
  readonly?: boolean;
}

export interface BoxPortCapability {
  guest: number;
  host?: number;
  protocol?: "tcp" | "udp";
}

export interface BoxCapabilitySet {
  network: BoxNetworkCapability;
  gpu: boolean;
  extraVolumes: BoxVolumeCapability[];
  secrets: string[];
  ports: BoxPortCapability[];
}

export interface BoxScope {
  kind: BoxScopeKind;
  id: string;
  image: string;
  workspaceRoot: string;
  capabilities: BoxCapabilitySet;
}

export type BoxCreateReason =
  | "created"
  | "capability_changed"
  | "workspace_root_changed"
  | "recovered";

export type BoxAcquisitionReason = BoxCreateReason | "reused";

export interface BoxExecSpec {
  argv: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutSec?: number;
  tty?: boolean;
  detach?: boolean;
}

export interface BoxExec {
  id: string;
  boxId: string;
  detached: boolean;
  wait(): Promise<BoxExecResult>;
  kill(signal?: string): Promise<void>;
}

export interface BoxExecResult {
  id: string;
  boxId: string;
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface BoxExecutionObservation {
  id: string;
  boxId: string;
  status: "running" | "completed" | "failed";
  stdout: string;
  stderr: string;
  stdoutOffset: number;
  stderrOffset: number;
  stdoutBytes: number;
  stderrBytes: number;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
  exitCode?: number;
}

export interface BoxExecutionObserveOptions {
  stdoutOffset?: number;
  stderrOffset?: number;
  maxBytes?: number;
}

export interface SnapshotRef {
  id: string;
  name: string;
  boxId: string;
  createdAt: string;
}

export type ReleaseReason = "detach" | "session_closed" | "task_completed" | "ephemeral_done";

export interface BoxHandle {
  readonly id: string;
  readonly scope: BoxScope;
  readonly fingerprint: string;
  readonly acquisitionReason: BoxAcquisitionReason;
  exec(spec: BoxExecSpec): Promise<BoxExec>;
  snapshot(name: string): Promise<SnapshotRef>;
  restore(snapshot: SnapshotRef | string): Promise<void>;
  fork(name: string): Promise<BoxHandle>;
  release(reason: ReleaseReason): Promise<void>;
}

export interface BoxInventoryEntry {
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
}

export interface BoxInventory {
  boxes: BoxInventoryEntry[];
}

export interface MaintenanceReport {
  stopped: string[];
  removed: string[];
  retained: string[];
}

export interface BoxPlane {
  acquire(scope: BoxScope): Promise<BoxHandle>;
  reattach(boxId: string, executionId: string): Promise<BoxExec | undefined>;
  observeExecution(
    boxId: string,
    executionId: string,
    options?: BoxExecutionObserveOptions,
  ): Promise<BoxExecutionObservation | undefined>;
  releaseScope(scope: { kind: BoxScopeKind; id: string }, reason: ReleaseReason): Promise<void>;
  inspect(): Promise<BoxInventory>;
  maintain(): Promise<MaintenanceReport>;
}

export interface BoxPlaneOptions {
  home: string;
  image: string;
  cpus: number;
  memoryMib: number;
  diskGb: number;
  workspaceGuestPath: string;
  network: BoxNetworkCapability;
  detach: boolean;
  autoSnapshotOnRelease?: boolean;
  perSessionLifetime?: "session" | "forever";
  gc?: {
    maxStoppedBoxes: number;
    maxAgeDays: number;
  };
}
