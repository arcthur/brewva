/**
 * Workspace world snapshots: content-addressed, whole-scope captures of the
 * workspace file state, coupled to rewind checkpoints.
 *
 * A world is a manifest (sorted file entries pointing at content blobs by
 * `sha256:<hex>`) whose own hash is the world id, so identical workspace
 * states collapse to one world and a clean capture costs a stat scan plus
 * zero writes. Worlds are durable-transient artifacts in the durability
 * taxonomy: capture-time evidence referenced from the tape's checkpoint
 * payloads, retention-bounded per session, never rebuildable.
 *
 * The checkpoint payload contract (`brewva.world.v1` block schema and its
 * read view) lives in `@brewva/brewva-vocabulary/session`, beside the
 * checkpoint event type it rides; this module owns the store mechanics.
 */

export const WORLD_MANIFEST_SCHEMA = "brewva.world.manifest.v1" as const;

/** Blob/world ref prefix; single home for the `sha256:<hex>` spelling. */
export const WORLD_BLOB_HASH_PREFIX = "sha256:" as const;

export type WorldFileMode = "normal" | "executable";

export interface WorldManifestEntry {
  /** Workspace-relative path, `/`-separated. */
  readonly path: string;
  readonly mode: WorldFileMode;
  readonly size: number;
  /** `sha256:<hex>` of the file content. */
  readonly blob: string;
}

export interface WorldManifest {
  readonly schema: typeof WORLD_MANIFEST_SCHEMA;
  readonly files: readonly WorldManifestEntry[];
}

/** How the capture scope was enumerated. */
export type WorldEnumerationSource = "git" | "walk";

/** Outcome of the opportunistic store maintenance a capture may run. */
export type WorldMaintenanceNote = "swept" | "throttled" | `skipped:${string}` | `failed:${string}`;

export interface WorldCaptureSuccess {
  readonly ok: true;
  /** `sha256:<hex>` over the canonical manifest JSON. */
  readonly worldId: string;
  readonly fileCount: number;
  readonly totalBytes: number;
  readonly newBlobCount: number;
  readonly newBlobBytes: number;
  readonly durationMs: number;
  readonly source: WorldEnumerationSource;
  /** True when this exact world already existed in the store. */
  readonly deduplicated: boolean;
  /** Present when this capture attempted store maintenance. */
  readonly maintenance?: WorldMaintenanceNote;
}

export type WorldCaptureFailureReason =
  | "workspace_missing"
  | "enumeration_failed"
  | "workspace_too_large"
  | "store_io_error";

export interface WorldCaptureFailure {
  readonly ok: false;
  readonly reason: WorldCaptureFailureReason;
  readonly detail?: string;
}

export type WorldCaptureResult = WorldCaptureSuccess | WorldCaptureFailure;

export interface WorldRef {
  readonly worldId: string;
  readonly recordedAt: number;
  readonly turn?: number;
}

export interface WorldVerification {
  readonly worldId: string;
  /** True when the manifest and every referenced blob match their SHA-256 refs. */
  readonly present: boolean;
  readonly fileCount: number;
  readonly missingBlobCount: number;
  /** Present only when a named blob exists but its contents no longer match its ref. */
  readonly corruptBlobCount?: number;
  /** Present when the manifest no longer hashes to the world id that named it. */
  readonly manifestHashMismatch?: boolean;
}

export interface WorldSweepSuccess {
  readonly ok: true;
  readonly removedManifests: number;
  readonly removedBlobs: number;
  readonly removedRefFiles: number;
}

export type WorldSweepSkipReason =
  | "locked"
  | "capture_inflight"
  | "refs_unreadable"
  | "manifest_unreadable";

export interface WorldSweepFailure {
  readonly ok: false;
  readonly skippedReason: WorldSweepSkipReason;
}

export type WorldSweepResult = WorldSweepSuccess | WorldSweepFailure;

export interface WorldStoreOptions {
  readonly workspaceRoot: string;
  /**
   * Store directory relative to the workspace root. Required: the config
   * layer is the single default home (`worlds.dir`), so a second constructor
   * site cannot silently diverge from the configured store location.
   */
  readonly dir: string;
  /** Required for the same single-default-home reason (`worlds.retainPerSession`). */
  readonly retainPerSession: number;
  /** Enumeration caps (both backends); test knobs with production defaults. */
  readonly maxFileCount?: number;
  readonly maxTotalBytes?: number;
  /** Age a store file must reach before sweep may delete it (default 15 min). */
  readonly gcGraceMs?: number;
}

export interface WorldCaptureInput {
  readonly sessionId: string;
  readonly turn?: number;
}

export interface WorldRestoreSuccess {
  readonly ok: true;
  readonly worldId: string;
  readonly wroteFileCount: number;
  readonly deletedFileCount: number;
  /**
   * In-scope files absent from the manifest whose content the store has never
   * seen — scope drift (e.g. a post-checkpoint ignore-rule change) surfaced
   * files the capture promise never covered, so the restore spared them.
   */
  readonly sparedFileCount: number;
  readonly unchangedFileCount: number;
  readonly bytesWritten: number;
  readonly durationMs: number;
  /**
   * Workspace-relative paths this restore governed (manifest paths plus
   * deleted paths). In-memory coordination data for the caller's receipt
   * coverage decisions — callers must not serialize it onto the tape.
   */
  readonly governedPaths: ReadonlySet<string>;
}

export type WorldRestoreFailureReason =
  | "world_missing"
  | "world_missing_artifacts"
  | "workspace_missing"
  | "enumeration_failed"
  | "workspace_too_large"
  | "occupant_conflict"
  | "restore_io_error";

export interface WorldRestoreFailure {
  readonly ok: false;
  readonly reason: WorldRestoreFailureReason;
  readonly detail?: string;
}

export type WorldRestoreResult = WorldRestoreSuccess | WorldRestoreFailure;

export interface WorkspaceWorldStore {
  readonly rootDir: string;
  capture(input: WorldCaptureInput): WorldCaptureResult;
  /**
   * Materialize a stored world over the workspace: manifest files become the
   * capture scope's exact content (writes + exec bits), and in-scope files the
   * manifest lacks are deleted. Fully preflighted fail-closed — missing
   * artifacts or a non-file occupant at a manifest path abort before any
   * mutation; a mid-flight I/O failure leaves a visible partial state and the
   * restore is re-runnable toward the same world.
   */
  materialize(worldId: string): WorldRestoreResult;
  /**
   * Block sweeps (including capture-triggered maintenance) and refresh the
   * target world's grace while an engine runs a verify→capture→materialize
   * composite; call the returned release exactly once.
   */
  holdRestoreGuard(worldId: string): () => void;
  /** Raw bytes of a stored blob (`sha256:<hex>` ref), or undefined. */
  readBlob(blobRef: string): Buffer | undefined;
  readManifest(worldId: string): WorldManifest | undefined;
  /** Cheap manifest-presence check (shallow); `verifyWorld` is the deep check. */
  hasWorld(worldId: string): boolean;
  verifyWorld(worldId: string): WorldVerification;
  /**
   * Deep-verify multiple worlds from one fresh object-store inventory, reusing
   * blob hash results for content shared by more than one world.
   */
  verifyWorlds(worldIds: readonly string[]): readonly WorldVerification[];
  listRefs(sessionId: string): readonly WorldRef[];
  sweep(): WorldSweepResult;
}
