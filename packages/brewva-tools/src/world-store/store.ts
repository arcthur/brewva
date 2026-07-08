import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { sha256Hex, shortSha256Hex } from "@brewva/brewva-std/hash";
import { stableJsonStringify } from "@brewva/brewva-std/json";
import {
  readJsonFileSync,
  rewriteFileAtomic,
  sha256HexOfFileSync,
} from "@brewva/brewva-std/node/fs";
import { isRecord, toErrorMessage } from "@brewva/brewva-std/unknown";
import { enumerateWorkspaceFiles, type EnumeratedFile } from "./enumerate.js";
import {
  WORLD_BLOB_HASH_PREFIX as HASH_PREFIX,
  WORLD_MANIFEST_SCHEMA,
  type WorkspaceWorldStore,
  type WorldCaptureInput,
  type WorldCaptureResult,
  type WorldFileMode,
  type WorldMaintenanceNote,
  type WorldManifest,
  type WorldManifestEntry,
  type WorldRef,
  type WorldRestoreResult,
  type WorldStoreOptions,
  type WorldSweepResult,
  type WorldVerification,
} from "./types.js";

/**
 * Content-addressed world store under the configured `worlds.dir`.
 *
 * Layout:
 * - `objects/<aa>/<hex>`: content blobs, written tmp-then-rename so a blob is
 *   either fully present or absent, and idempotent by construction.
 * - `manifests/<hex>.json`: world manifests; the file name is the world id hex.
 * - `refs/<encodedSessionId>.json`: per-session world-transition refs — the GC
 *   roots. A ref is appended only when the captured world differs from the
 *   session's previous one, retention trims the list, and refs whose newest
 *   entry is older than the expiry fall out of the promise entirely.
 * - `statcache.json`: rebuildable size+mtime→blob cache with a racy-clean
 *   watermark; corruption self-heals by re-hashing, never by failing a capture.
 * - `inflight/<marker>`: capture liveness markers; sweep refuses to run while
 *   any fresh marker exists, so dedup-reuse of old artifacts can never race a
 *   concurrent sweep in another process.
 *
 * Hot-path posture: capture runs at every rewind checkpoint (once per provider
 * round), so a clean capture must do zero writes — the stat cache is saved
 * only when dirty, a ref is appended only on world change, the manifest write
 * is content-dedup'd, and maintenance is both trim-triggered and time-throttled.
 *
 * Failure posture: sweep deletes only what it can prove dead (unreadable refs
 * or live manifests abort it; young files survive via the grace window), while
 * capture never fails because maintenance failed — maintenance outcomes are
 * telemetry on the capture result.
 */

const STATCACHE_VERSION = 2;
const REFS_VERSION = 1;

const DEFAULT_MAX_FILE_COUNT = 150_000;
const DEFAULT_MAX_TOTAL_BYTES = 1024 * 1024 * 1024;
const DEFAULT_GC_GRACE_MS = 15 * 60 * 1000;
const GC_LOCK_STALE_MS = 10 * 60 * 1000;
const GC_MIN_INTERVAL_MS = 10 * 60 * 1000;
const INFLIGHT_STALE_MS = 5 * 60 * 1000;
const REFS_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000;

interface StatCacheEntry {
  readonly size: number;
  readonly mtimeNs: string;
  readonly blob: string;
}

interface StatCacheState {
  readonly entries: Map<string, StatCacheEntry>;
  /** Watermark for the racy-clean guard; 0n distrusts every loaded entry. */
  readonly writtenAtNs: bigint;
}

function toHex(worldIdOrBlob: string): string | undefined {
  if (!worldIdOrBlob.startsWith(HASH_PREFIX)) {
    return undefined;
  }
  const hex = worldIdOrBlob.slice(HASH_PREFIX.length);
  return /^[0-9a-f]{64}$/.test(hex) ? hex : undefined;
}

function nowNs(): bigint {
  return BigInt(Date.now()) * 1_000_000n;
}

function parseManifest(value: unknown): WorldManifest | undefined {
  if (!isRecord(value) || value.schema !== WORLD_MANIFEST_SCHEMA || !Array.isArray(value.files)) {
    return undefined;
  }
  const files: WorldManifestEntry[] = [];
  for (const entry of value.files) {
    if (!isRecord(entry)) return undefined;
    const { path, mode, size, blob } = entry;
    if (
      typeof path !== "string" ||
      (mode !== "normal" && mode !== "executable") ||
      typeof size !== "number" ||
      typeof blob !== "string" ||
      toHex(blob) === undefined
    ) {
      return undefined;
    }
    files.push({ path, mode: mode as WorldFileMode, size, blob });
  }
  return { schema: WORLD_MANIFEST_SCHEMA, files };
}

function parseRefs(value: unknown): WorldRef[] | undefined {
  if (!isRecord(value) || value.version !== REFS_VERSION || !Array.isArray(value.refs)) {
    return undefined;
  }
  const refs: WorldRef[] = [];
  for (const entry of value.refs) {
    if (!isRecord(entry)) return undefined;
    const { worldId, recordedAt, turn } = entry;
    if (
      typeof worldId !== "string" ||
      toHex(worldId) === undefined ||
      typeof recordedAt !== "number"
    ) {
      return undefined;
    }
    refs.push({ worldId, recordedAt, ...(typeof turn === "number" ? { turn } : {}) });
  }
  return refs;
}

export function createWorkspaceWorldStore(options: WorldStoreOptions): WorkspaceWorldStore {
  const workspaceRoot = resolve(options.workspaceRoot);
  const rootDir = resolve(workspaceRoot, options.dir);
  const objectsDir = join(rootDir, "objects");
  const manifestsDir = join(rootDir, "manifests");
  const refsDir = join(rootDir, "refs");
  const inflightDir = join(rootDir, "inflight");
  const statCachePath = join(rootDir, "statcache.json");
  const gcLockPath = join(rootDir, "gc.lock");
  const gcStampPath = join(rootDir, "gc.stamp");
  const retainPerSession = Math.max(1, options.retainPerSession);
  const gcGraceMs = options.gcGraceMs ?? DEFAULT_GC_GRACE_MS;
  // The store must never capture itself; thread its own workspace-relative
  // location into the enumeration exclusions (a store outside the workspace
  // is unreachable by enumeration and needs no exclusion).
  const storeRelativePath = relative(workspaceRoot, rootDir);
  const enumerationExclusions =
    storeRelativePath && !storeRelativePath.startsWith("..")
      ? [storeRelativePath.split("\\").join("/")]
      : [];

  const blobPath = (hex: string): string => join(objectsDir, hex.slice(0, 2), hex);
  const manifestPath = (hex: string): string => join(manifestsDir, `${hex}.json`);
  const refsPath = (sessionId: string): string =>
    join(refsDir, `${encodeURIComponent(sessionId)}.json`);

  function loadStatCache(): StatCacheState {
    const parsed = readJsonFileSync(statCachePath);
    const entries = new Map<string, StatCacheEntry>();
    if (!isRecord(parsed) || parsed.version !== STATCACHE_VERSION || !isRecord(parsed.entries)) {
      return { entries, writtenAtNs: 0n };
    }
    let writtenAtNs = 0n;
    if (typeof parsed.writtenAtNs === "string" && /^[0-9]+$/.test(parsed.writtenAtNs)) {
      writtenAtNs = BigInt(parsed.writtenAtNs);
    }
    for (const [path, entry] of Object.entries(parsed.entries)) {
      if (!isRecord(entry)) continue;
      const { size, mtimeNs, blob } = entry;
      if (
        typeof size === "number" &&
        typeof mtimeNs === "string" &&
        typeof blob === "string" &&
        toHex(blob) !== undefined
      ) {
        entries.set(path, { size, mtimeNs, blob });
      }
    }
    return { entries, writtenAtNs };
  }

  /**
   * Persist the cache, merging over the newest on-disk state so concurrent
   * sessions in one workspace don't clobber each other's fresh entries (the
   * cache is last-writer-wins per entry, and any loss only costs a re-hash).
   * Removals must be named explicitly — a merge-only save would resurrect
   * pruned or restore-deleted paths from disk, and a resurrected entry whose
   * mtime sits permanently below every future watermark would be trusted
   * forever (the one way the racy-clean guard can be defeated).
   */
  function saveStatCache(
    entries: Map<string, StatCacheEntry>,
    removedPaths: ReadonlySet<string>,
  ): void {
    const onDisk = loadStatCache().entries;
    for (const [path, entry] of entries) {
      onDisk.set(path, entry);
    }
    for (const path of removedPaths) {
      onDisk.delete(path);
    }
    rewriteFileAtomic(
      statCachePath,
      `${JSON.stringify({
        version: STATCACHE_VERSION,
        writtenAtNs: nowNs().toString(),
        entries: Object.fromEntries(onDisk),
      })}\n`,
    );
  }

  /** Hex names of every blob currently in the store (one readdir per shard). */
  function readBlobPresence(): Set<string> {
    const present = new Set<string>();
    let shards: string[];
    try {
      shards = readdirSync(objectsDir);
    } catch {
      return present;
    }
    for (const shard of shards) {
      if (shard.startsWith("tmp-")) continue;
      try {
        for (const entry of readdirSync(join(objectsDir, shard))) {
          present.add(entry);
        }
      } catch {
        // A shard vanishing mid-scan just means those blobs read as absent.
      }
    }
    return present;
  }

  /** The one racy-clean stat-cache hit predicate for capture and restore. */
  function isFreshCacheHit(
    cached: StatCacheEntry | undefined,
    file: { readonly size: number; readonly mtimeNs: string },
    writtenAtNs: bigint,
  ): cached is StatCacheEntry {
    return (
      cached !== undefined &&
      cached.size === file.size &&
      cached.mtimeNs === file.mtimeNs &&
      BigInt(file.mtimeNs) < writtenAtNs
    );
  }

  /** The store's one enumeration scope (shared by capture and restore). */
  function enumerateScope() {
    return enumerateWorkspaceFiles(workspaceRoot, {
      maxFileCount: options.maxFileCount ?? DEFAULT_MAX_FILE_COUNT,
      maxTotalBytes: options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES,
      excludedWorkspaceRelativePaths: enumerationExclusions,
    });
  }

  /**
   * Sweep-exclusion marker: while a fresh marker exists, sweep refuses to run,
   * so store reads made under it can never race artifact deletion.
   */
  function writeInflightMarker(suffix: string): string {
    mkdirSync(inflightDir, { recursive: true });
    const markerPath = join(inflightDir, `${process.pid}-${suffix}`);
    writeFileSync(markerPath, `${Date.now()}\n`, "utf8");
    return markerPath;
  }

  /**
   * Ensure the file's content blob exists; returns its `sha256:<hex>` ref,
   * how many bytes were newly stored, and whether the cache changed.
   *
   * Cache hits additionally require the blob to be present (self-healing) and
   * the entry's mtime to be strictly older than the cache's own write
   * watermark — the racy-clean guard: a same-size rewrite landing in the same
   * timestamp tick as the previous capture's lstat re-hashes instead of
   * trusting a possibly-stale entry.
   *
   * Miss path is hash-first (one streaming read); only a genuinely new blob
   * pays the clone. The stored bytes always match their name because a new
   * blob is renamed from a point-in-time clone hashed after cloning.
   */
  function ensureBlob(
    file: EnumeratedFile,
    cache: StatCacheState,
    presence: Set<string>,
  ): { blob: string; newBytes: number; cacheChanged: boolean } {
    const cached = cache.entries.get(file.path);
    if (isFreshCacheHit(cached, file, cache.writtenAtNs)) {
      const hex = toHex(cached.blob);
      if (hex && presence.has(hex)) {
        return { blob: cached.blob, newBytes: 0, cacheChanged: false };
      }
    }
    const liveHex = sha256HexOfFileSync(file.absolutePath);
    if (presence.has(liveHex)) {
      const blob = `${HASH_PREFIX}${liveHex}`;
      cache.entries.set(file.path, { size: file.size, mtimeNs: file.mtimeNs, blob });
      return { blob, newBytes: 0, cacheChanged: true };
    }
    const tmpPath = join(objectsDir, `tmp-${process.pid}-${shortSha256Hex(file.path)}`);
    copyFileSync(file.absolutePath, tmpPath, constants.COPYFILE_FICLONE);
    try {
      const hex = sha256HexOfFileSync(tmpPath);
      const finalPath = blobPath(hex);
      let newBytes = 0;
      if (presence.has(hex) || existsSync(finalPath)) {
        rmSync(tmpPath, { force: true });
      } else {
        mkdirSync(join(objectsDir, hex.slice(0, 2)), { recursive: true });
        newBytes = statSync(tmpPath).size;
        renameSync(tmpPath, finalPath);
      }
      presence.add(hex);
      const blob = `${HASH_PREFIX}${hex}`;
      cache.entries.set(file.path, { size: file.size, mtimeNs: file.mtimeNs, blob });
      return { blob, newBytes, cacheChanged: true };
    } catch (error) {
      rmSync(tmpPath, { force: true });
      throw error;
    }
  }

  interface RefsState {
    readonly refs: WorldRef[];
    readonly corrupt: boolean;
  }

  function readRefsState(sessionId: string): RefsState {
    const path = refsPath(sessionId);
    if (!existsSync(path)) {
      return { refs: [], corrupt: false };
    }
    const parsed = parseRefs(readJsonFileSync(path));
    return parsed ? { refs: parsed, corrupt: false } : { refs: [], corrupt: true };
  }

  function writeRefs(sessionId: string, refs: readonly WorldRef[]): void {
    rewriteFileAtomic(refsPath(sessionId), `${JSON.stringify({ version: REFS_VERSION, refs })}\n`);
  }

  function capture(input: WorldCaptureInput): WorldCaptureResult {
    const startedAt = Date.now();
    const enumeration = enumerateScope();
    if (!enumeration.ok) {
      return {
        ok: false,
        reason: enumeration.reason,
        ...(enumeration.detail ? { detail: enumeration.detail } : {}),
      };
    }
    let markerPath: string | undefined;
    try {
      mkdirSync(objectsDir, { recursive: true });
      mkdirSync(manifestsDir, { recursive: true });
      mkdirSync(refsDir, { recursive: true });
      // The marker precedes every store read so a concurrent sweep can never
      // delete an old artifact this capture is about to reference.
      markerPath = writeInflightMarker(shortSha256Hex(input.sessionId));

      const presence = readBlobPresence();
      const cache = loadStatCache();
      const entries: WorldManifestEntry[] = [];
      let totalBytes = 0;
      let newBlobCount = 0;
      let newBlobBytes = 0;
      let cacheDirty = false;
      for (const file of enumeration.files) {
        let ensured;
        try {
          ensured = ensureBlob(file, cache, presence);
        } catch (error) {
          if (isRecord(error) && error.code === "ENOENT") {
            // Enumerated then deleted mid-capture: the world reflects the disk.
            continue;
          }
          throw error;
        }
        if (ensured.newBytes > 0) {
          newBlobCount += 1;
          newBlobBytes += ensured.newBytes;
        }
        cacheDirty ||= ensured.cacheChanged;
        totalBytes += file.size;
        entries.push({ path: file.path, mode: file.mode, size: file.size, blob: ensured.blob });
      }
      // Prune cache keys the scope no longer contains so the cache tracks the
      // live file set instead of growing monotonically across renames.
      const livePaths = new Set(entries.map((entry) => entry.path));
      const prunedPaths = new Set<string>();
      for (const path of cache.entries.keys()) {
        if (!livePaths.has(path)) {
          cache.entries.delete(path);
          prunedPaths.add(path);
          cacheDirty = true;
        }
      }

      const manifest: WorldManifest = { schema: WORLD_MANIFEST_SCHEMA, files: entries };
      const manifestJson = stableJsonStringify(manifest);
      const hex = sha256Hex(manifestJson);
      const worldId = `${HASH_PREFIX}${hex}`;
      const deduplicated = existsSync(manifestPath(hex));
      if (deduplicated) {
        try {
          // Refresh the grace window: this world is being referenced again.
          utimesSync(manifestPath(hex), new Date(), new Date());
        } catch {
          // Best-effort; sweep protection still holds via the inflight marker.
        }
      } else {
        rewriteFileAtomic(manifestPath(hex), `${manifestJson}\n`);
      }
      if (cacheDirty) {
        saveStatCache(cache.entries, prunedPaths);
      }

      const refsState = readRefsState(input.sessionId);
      if (refsState.corrupt) {
        // Preserve the unreadable file (it may still name live roots — sweep
        // fails closed on it) instead of clobbering it with a fresh list.
        renameSync(refsPath(input.sessionId), `${refsPath(input.sessionId)}.corrupt-${startedAt}`);
      }
      const lastRef = refsState.refs.at(-1);
      let refsChanged = refsState.corrupt;
      let refs = refsState.refs;
      if (lastRef?.worldId !== worldId) {
        refs = [
          ...refs,
          {
            worldId,
            recordedAt: Date.now(),
            ...(typeof input.turn === "number" ? { turn: input.turn } : {}),
          },
        ];
        refsChanged = true;
      }
      const trimmed = refs.length > retainPerSession;
      if (trimmed) {
        refs = refs.slice(refs.length - retainPerSession);
      }
      if (refsChanged || trimmed) {
        writeRefs(input.sessionId, refs);
      }

      // Every store read this capture depends on is done and its ref is
      // durable: drop the inflight marker so the trim-triggered sweep below
      // (and any concurrent one) is no longer blocked by our own liveness.
      rmSync(markerPath, { force: true });
      markerPath = undefined;

      const maintenance = trimmed ? runThrottledMaintenance() : undefined;

      return {
        ok: true,
        worldId,
        fileCount: entries.length,
        totalBytes,
        newBlobCount,
        newBlobBytes,
        durationMs: Math.max(0, Date.now() - startedAt),
        source: enumeration.source,
        deduplicated,
        ...(maintenance ? { maintenance } : {}),
      };
    } catch (error) {
      return { ok: false, reason: "store_io_error", detail: toErrorMessage(error) };
    } finally {
      if (markerPath) {
        rmSync(markerPath, { force: true });
      }
    }
  }

  /**
   * Materialize a stored world over the workspace. Fully preflighted: missing
   * blobs, a non-file occupant at a manifest path, a non-directory ancestor
   * component, or any target escaping the workspace through a symlinked
   * ancestor abort before any mutation. Deletes run before writes so in-scope
   * directory/file flips resolve cleanly; a delete candidate whose content the
   * store has never seen is SPARED (scope drift — e.g. a post-checkpoint
   * ignore-rule change — must not destroy data the promise never covered);
   * content-equal files cost a stat-cache hit and only reconcile their exec
   * bit. Mode handling matches capture granularity: only the executable bits
   * are reconciled, relative to the file's current mode, so private files
   * never widen and setuid bits survive. Directories left empty by deletions
   * are pruned, mirroring git's checkout behavior.
   */
  function materialize(worldId: string): WorldRestoreResult {
    const startedAt = Date.now();
    const manifest = readManifest(worldId);
    if (!manifest) {
      return { ok: false, reason: "world_missing" };
    }
    const enumeration = enumerateScope();
    if (!enumeration.ok) {
      return {
        ok: false,
        reason: enumeration.reason,
        ...(enumeration.detail ? { detail: enumeration.detail } : {}),
      };
    }
    let markerPath: string | undefined;
    try {
      // Same sweep-exclusion discipline as capture: the marker precedes every
      // blob read so maintenance can never delete what this restore is copying.
      markerPath = writeInflightMarker(`restore-${shortSha256Hex(worldId)}`);

      const presence = readBlobPresence();
      let missingBlobCount = 0;
      let firstMissingPath: string | undefined;
      for (const entry of manifest.files) {
        const hex = toHex(entry.blob);
        if (!hex || !presence.has(hex)) {
          missingBlobCount += 1;
          firstMissingPath ??= entry.path;
        }
      }
      if (missingBlobCount > 0) {
        return {
          ok: false,
          reason: "world_missing_artifacts",
          detail: `${missingBlobCount} blob(s) missing, first: ${firstMissingPath}`,
        };
      }

      const manifestPathSet = new Set(manifest.files.map((entry) => entry.path));
      const governedPaths = new Set(manifestPathSet);
      const deleteCandidates = enumeration.files.filter((file) => !manifestPathSet.has(file.path));
      const conflict = preflightMutationTargets([
        ...manifest.files.map((entry) => entry.path),
        ...deleteCandidates.map((file) => file.path),
      ]);
      if (conflict) {
        return { ok: false, reason: "occupant_conflict", detail: conflict };
      }

      const cache = loadStatCache();
      const currentByPath = new Map(enumeration.files.map((file) => [file.path, file]));

      // Deletes first so in-scope directory/file flips resolve before writes.
      // A candidate whose bytes the store has never seen is spared: it was
      // outside the capture promise (scope drift), so destroying it would
      // delete data no world can restore.
      let deletedFileCount = 0;
      let sparedFileCount = 0;
      const removedCachePaths = new Set<string>();
      const emptiedDirs = new Set<string>();
      for (const file of deleteCandidates) {
        let candidateHex: string | undefined;
        try {
          candidateHex = sha256HexOfFileSync(file.absolutePath);
        } catch {
          continue;
        }
        if (!presence.has(candidateHex)) {
          sparedFileCount += 1;
          continue;
        }
        rmSync(file.absolutePath, { force: true });
        deletedFileCount += 1;
        removedCachePaths.add(file.path);
        governedPaths.add(file.path);
        cache.entries.delete(file.path);
        const parent = dirname(file.path);
        if (parent && parent !== ".") {
          emptiedDirs.add(parent);
        }
      }
      pruneEmptiedDirectories(emptiedDirs);

      let wroteFileCount = 0;
      let unchangedFileCount = 0;
      let bytesWritten = 0;
      let cacheDirty = removedCachePaths.size > 0;
      for (const entry of manifest.files) {
        const hex = toHex(entry.blob);
        if (!hex) {
          continue;
        }
        const target = join(workspaceRoot, entry.path);
        const current = currentByPath.get(entry.path);
        let contentMatches = false;
        if (current && current.size === entry.size) {
          if (
            isFreshCacheHit(cache.entries.get(entry.path), current, cache.writtenAtNs) &&
            cache.entries.get(entry.path)?.blob === entry.blob
          ) {
            contentMatches = true;
          } else {
            try {
              contentMatches = sha256HexOfFileSync(target) === hex;
            } catch {
              contentMatches = false;
            }
          }
        }
        const currentMode = current
          ? Number(lstatSync(target, { bigint: true }).mode) & 0o7777
          : undefined;
        if (contentMatches && current && currentMode !== undefined) {
          if (current.mode !== entry.mode) {
            chmodSync(target, reconcileExecBits(currentMode, entry.mode));
          }
          unchangedFileCount += 1;
          continue;
        }
        mkdirSync(dirname(target), { recursive: true });
        rmSync(target, { force: true });
        copyFileSync(blobPath(hex), target, constants.COPYFILE_FICLONE);
        // Non-exec bits: an existing file keeps its own; a restored-from-blob
        // file starts from the blob copy's mode. Only the exec bits follow the
        // manifest contract.
        const baseMode = currentMode ?? Number(lstatSync(target, { bigint: true }).mode) & 0o7777;
        chmodSync(target, reconcileExecBits(baseMode, entry.mode));
        wroteFileCount += 1;
        bytesWritten += entry.size;
        const written = lstatSync(target, { bigint: true });
        cache.entries.set(entry.path, {
          size: Number(written.size),
          mtimeNs: written.mtimeNs.toString(),
          blob: entry.blob,
        });
        cacheDirty = true;
      }
      if (cacheDirty) {
        saveStatCache(cache.entries, removedCachePaths);
      }
      return {
        ok: true,
        worldId,
        wroteFileCount,
        deletedFileCount,
        sparedFileCount,
        unchangedFileCount,
        bytesWritten,
        durationMs: Math.max(0, Date.now() - startedAt),
        governedPaths,
      };
    } catch (error) {
      return { ok: false, reason: "restore_io_error", detail: toErrorMessage(error) };
    } finally {
      if (markerPath) {
        rmSync(markerPath, { force: true });
      }
    }
  }

  /** Apply the manifest's exec-bit contract onto a file's current mode. */
  function reconcileExecBits(currentMode: number, mode: WorldFileMode): number {
    return mode === "executable" ? currentMode | 0o111 : currentMode & ~0o111;
  }

  /**
   * Fail-closed mutation preflight: every target's deepest existing ancestor
   * must be a real directory whose realpath stays inside the workspace, and a
   * manifest path may only be occupied by a regular file. Catches non-file
   * occupants, file-where-directory-expected ancestors (ENOTDIR class), and
   * symlinked-ancestor escapes before a single byte moves. Returns the first
   * offending workspace-relative path, or undefined when clean.
   */
  function preflightMutationTargets(relativePaths: readonly string[]): string | undefined {
    let realRoot: string;
    try {
      realRoot = realpathSync(workspaceRoot);
    } catch {
      return workspaceRoot;
    }
    for (const relativePath of relativePaths) {
      const target = join(workspaceRoot, relativePath);
      let probe = target;
      let probeIsTarget = true;
      while (true) {
        let stats;
        try {
          stats = lstatSync(probe);
        } catch {
          const parent = dirname(probe);
          if (parent === probe) {
            return relativePath;
          }
          probe = parent;
          probeIsTarget = false;
          continue;
        }
        if (probeIsTarget) {
          if (!stats.isFile()) {
            return relativePath;
          }
        } else if (!stats.isDirectory()) {
          // A file or symlink where a directory component must go (ENOTDIR
          // class, or a symlinked ancestor that could redirect the write).
          return relativePath;
        }
        break;
      }
      try {
        const realProbe = realpathSync(probe);
        if (realProbe !== realRoot && !realProbe.startsWith(`${realRoot}/`)) {
          return relativePath;
        }
      } catch {
        return relativePath;
      }
    }
    return undefined;
  }

  /**
   * Best-effort removal of directories the delete pass emptied, walking up
   * toward the workspace root. Non-empty directories end the walk; failures
   * are ignored — directory shape is convenience, not the restore contract.
   */
  function pruneEmptiedDirectories(relativeDirs: ReadonlySet<string>): void {
    const deepestFirst = [...relativeDirs].toSorted(
      (left, right) => right.split("/").length - left.split("/").length,
    );
    for (const relativeDir of deepestFirst) {
      let current = relativeDir;
      while (current && current !== ".") {
        try {
          rmdirSync(join(workspaceRoot, current));
        } catch {
          break;
        }
        const parent = dirname(current);
        if (parent === current) break;
        current = parent;
      }
    }
  }

  /**
   * Trim-triggered, time-throttled, failure-isolated maintenance. Whatever
   * happens here is telemetry on the capture result — a capture whose world
   * is already durably stored must never report failure because sweeping did.
   */
  function runThrottledMaintenance(): WorldMaintenanceNote {
    try {
      let stampAgeMs = Number.POSITIVE_INFINITY;
      try {
        stampAgeMs = Date.now() - statSync(gcStampPath).mtimeMs;
      } catch {
        // No stamp yet: sweep now.
      }
      if (stampAgeMs < GC_MIN_INTERVAL_MS) {
        return "throttled";
      }
      const outcome = sweep();
      if (outcome.ok) {
        writeFileSync(gcStampPath, `${Date.now()}\n`, "utf8");
        return "swept";
      }
      return `skipped:${outcome.skippedReason}`;
    } catch (error) {
      return `failed:${toErrorMessage(error)}`;
    }
  }

  /** Raw bytes of a stored blob (`sha256:<hex>` ref), or undefined. */
  function readBlob(blobRef: string): Buffer | undefined {
    const hex = toHex(blobRef);
    if (!hex) {
      return undefined;
    }
    try {
      return readFileSync(blobPath(hex));
    } catch {
      return undefined;
    }
  }

  function readManifest(worldId: string): WorldManifest | undefined {
    const hex = toHex(worldId);
    if (!hex) {
      return undefined;
    }
    const path = manifestPath(hex);
    if (!existsSync(path)) {
      return undefined;
    }
    return parseManifest(readJsonFileSync(path));
  }

  function hasWorld(worldId: string): boolean {
    const hex = toHex(worldId);
    return hex !== undefined && existsSync(manifestPath(hex));
  }

  function verifyWorld(worldId: string): WorldVerification {
    const manifest = readManifest(worldId);
    if (!manifest) {
      return { worldId, present: false, fileCount: 0, missingBlobCount: 0 };
    }
    const presence = readBlobPresence();
    const checked = new Set<string>();
    let missingBlobCount = 0;
    for (const entry of manifest.files) {
      const hex = toHex(entry.blob);
      if (!hex || checked.has(hex)) {
        continue;
      }
      checked.add(hex);
      if (!presence.has(hex)) {
        missingBlobCount += 1;
      }
    }
    return {
      worldId,
      present: missingBlobCount === 0,
      fileCount: manifest.files.length,
      missingBlobCount,
    };
  }

  function tryCreateGcLock(): boolean {
    try {
      const fd = openSync(gcLockPath, "wx");
      writeSync(fd, `${process.pid}:${Date.now()}\n`);
      closeSync(fd);
      return true;
    } catch {
      return false;
    }
  }

  /** Verify-before-steal stale break, mirroring the session-index write lease. */
  function acquireGcLock(): boolean {
    if (tryCreateGcLock()) {
      return true;
    }
    let content: string;
    try {
      content = readFileSync(gcLockPath, "utf8");
    } catch {
      return tryCreateGcLock();
    }
    const heldAt = Number(content.split(":")[1]);
    if (Number.isFinite(heldAt) && Date.now() - heldAt <= GC_LOCK_STALE_MS) {
      return false;
    }
    try {
      if (readFileSync(gcLockPath, "utf8") !== content) {
        return false;
      }
      rmSync(gcLockPath, { force: true });
    } catch {
      return false;
    }
    return tryCreateGcLock();
  }

  /**
   * Mark-and-sweep over the whole store. Roots are every session's refs file;
   * anything unreadable in `refs/` aborts the sweep (fail closed: never delete
   * what cannot be proven dead). Refs whose newest entry passed the expiry are
   * dropped as a whole — that is the bounded end of a dead session's promise.
   * Files younger than the grace window survive unconditionally, and any fresh
   * capture marker aborts the sweep entirely.
   */
  function sweep(): WorldSweepResult {
    if (!existsSync(rootDir)) {
      return { ok: true, removedManifests: 0, removedBlobs: 0, removedRefFiles: 0 };
    }
    if (!acquireGcLock()) {
      return { ok: false, skippedReason: "locked" };
    }
    try {
      if (existsSync(inflightDir)) {
        for (const marker of readdirSync(inflightDir)) {
          const markerPath = join(inflightDir, marker);
          let ageMs = 0;
          try {
            ageMs = Date.now() - statSync(markerPath).mtimeMs;
          } catch {
            continue;
          }
          if (ageMs < INFLIGHT_STALE_MS) {
            return { ok: false, skippedReason: "capture_inflight" };
          }
          rmSync(markerPath, { force: true });
        }
      }

      const liveWorldHexes = new Set<string>();
      const expiredRefFiles: string[] = [];
      if (existsSync(refsDir)) {
        for (const entry of readdirSync(refsDir)) {
          const path = join(refsDir, entry);
          if (!entry.endsWith(".json")) {
            // Quarantined or foreign files are unknown roots: fail closed.
            return { ok: false, skippedReason: "refs_unreadable" };
          }
          const refs = parseRefs(readJsonFileSync(path));
          if (!refs) {
            return { ok: false, skippedReason: "refs_unreadable" };
          }
          const newestAt = refs.reduce((max, ref) => Math.max(max, ref.recordedAt), 0);
          if (Date.now() - newestAt > REFS_EXPIRY_MS) {
            expiredRefFiles.push(path);
            continue;
          }
          for (const ref of refs) {
            const hex = toHex(ref.worldId);
            if (hex) liveWorldHexes.add(hex);
          }
        }
      }

      const liveBlobHexes = new Set<string>();
      const deadManifestPaths: string[] = [];
      if (existsSync(manifestsDir)) {
        for (const entry of readdirSync(manifestsDir)) {
          if (!entry.endsWith(".json")) continue;
          const hex = entry.slice(0, -".json".length);
          const path = join(manifestsDir, entry);
          if (!liveWorldHexes.has(hex)) {
            deadManifestPaths.push(path);
            continue;
          }
          const manifest = parseManifest(readJsonFileSync(path));
          if (!manifest) {
            return { ok: false, skippedReason: "manifest_unreadable" };
          }
          for (const file of manifest.files) {
            const blobHex = toHex(file.blob);
            if (blobHex) liveBlobHexes.add(blobHex);
          }
        }
      }

      const cutoff = Date.now() - gcGraceMs;
      const youngEnoughToKeep = (path: string): boolean => {
        try {
          return statSync(path).mtimeMs > cutoff;
        } catch {
          return true;
        }
      };

      let removedRefFiles = 0;
      for (const path of expiredRefFiles) {
        rmSync(path, { force: true });
        removedRefFiles += 1;
      }

      let removedManifests = 0;
      for (const path of deadManifestPaths) {
        if (youngEnoughToKeep(path)) continue;
        rmSync(path, { force: true });
        removedManifests += 1;
      }

      let removedBlobs = 0;
      if (existsSync(objectsDir)) {
        for (const shard of readdirSync(objectsDir)) {
          const shardPath = join(objectsDir, shard);
          // Orphaned point-in-time tmp copies live at the objects root; a crash
          // between clone and rename leaves them inert, so age them out here.
          if (shard.startsWith("tmp-")) {
            if (!youngEnoughToKeep(shardPath)) rmSync(shardPath, { force: true });
            continue;
          }
          let entries: string[];
          try {
            entries = readdirSync(shardPath);
          } catch {
            continue;
          }
          for (const entry of entries) {
            const path = join(shardPath, entry);
            if (liveBlobHexes.has(entry) || youngEnoughToKeep(path)) {
              continue;
            }
            rmSync(path, { force: true });
            removedBlobs += 1;
          }
        }
      }
      return { ok: true, removedManifests, removedBlobs, removedRefFiles };
    } finally {
      rmSync(gcLockPath, { force: true });
    }
  }

  /**
   * Hold a restore-scope guard for a world an engine is about to verify,
   * pre-capture, and materialize as one composite: an inflight marker blocks
   * every sweep (including the pre-capture's own trim-triggered maintenance —
   * the one same-process path that could otherwise deterministically collect
   * a just-verified target world whose ref fell out of retention), and a
   * manifest mtime refresh re-enters the target into the grace window.
   */
  function holdRestoreGuard(worldId: string): () => void {
    const hex = toHex(worldId);
    if (hex) {
      try {
        utimesSync(manifestPath(hex), new Date(), new Date());
      } catch {
        // Missing manifest: the guard still blocks sweeps; materialize will
        // report the world honestly.
      }
    }
    const markerPath = writeInflightMarker(`guard-${shortSha256Hex(worldId)}`);
    return () => {
      rmSync(markerPath, { force: true });
    };
  }

  return {
    rootDir,
    capture,
    materialize,
    holdRestoreGuard,
    readBlob,
    readManifest,
    hasWorld,
    verifyWorld,
    listRefs: (sessionId) => readRefsState(sessionId).refs,
    sweep,
  };
}
