import { existsSync, mkdirSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import type { FffFileFinder, FffModule } from "./fff-types.js";

/**
 * Node-safe lazy access to the fff native index plus a per-workspace finder
 * cache.
 *
 * `@ff-labs/fff-bun` binds a native library through `bun:ffi`. A top-level
 * value import would make this module's import graph unloadable under Node
 * (verification scripts run there), so the value import is deferred behind a
 * `typeof Bun` guard and a try/catch — mirroring the `bun:sqlite` discipline in
 * brewva-session-index. When the module or native binary is unavailable, every
 * accessor degrades to "not available" and callers fall back to ripgrep.
 */

type Finder = FffFileFinder;

export interface AcquiredFinder {
  readonly finder: Finder;
  /**
   * Resolves `true` once the initial file scan has completed (the correctness
   * gate: only then does fff see every file ripgrep would). Resolves `false`
   * on timeout or error so the caller can fall back to ripgrep for completeness.
   */
  readonly scanReady: Promise<boolean>;
}

const SCAN_READY_TIMEOUT_MS = 30_000;
const FRECENCY_DB_SUBPATH = [".brewva", "fff", "frecency"] as const;

let modulePromise: Promise<FffModule | null> | undefined;
const finders = new Map<string, Promise<AcquiredFinder | null>>();

function loadModule(): Promise<FffModule | null> {
  modulePromise ??= (async (): Promise<FffModule | null> => {
    if (typeof (globalThis as { Bun?: unknown }).Bun === "undefined") {
      return null;
    }
    try {
      // The `as string` erases the specifier's literal type so tsc never
      // follows into the dependency's raw `.ts` source (its extensionless
      // relative imports fail strict NodeNext). The literal text stays inside
      // `import(...)` so knip still sees the dependency as used, and bun
      // resolves it normally at runtime.
      return (await import("@ff-labs/fff-bun" as string)) as unknown as FffModule;
    } catch {
      return null;
    }
  })();
  return modulePromise;
}

export async function isFffAvailable(): Promise<boolean> {
  const mod = await loadModule();
  return mod?.FileFinder.isAvailable() ?? false;
}

/**
 * Persisted frecency DB path under the workspace's `.brewva/fff/`, so the
 * ranking signal accrues across sessions. Returns `undefined` (skip persistence)
 * unless `.brewva` already exists — this keeps the DB/watcher overhead out of
 * arbitrary roots such as test temp dirs, and best-effort skips on mkdir failure
 * (e.g. a read-only root).
 */
function resolveFrecencyDbPath(basePath: string): string | undefined {
  if (!existsSync(join(basePath, ".brewva"))) {
    return undefined;
  }
  const dbPath = join(basePath, ...FRECENCY_DB_SUBPATH);
  try {
    mkdirSync(dirname(dbPath), { recursive: true });
    return dbPath;
  } catch {
    return undefined;
  }
}

function createAcquired(basePath: string): Promise<AcquiredFinder | null> {
  return (async (): Promise<AcquiredFinder | null> => {
    try {
      const mod = await loadModule();
      if (!mod || !mod.FileFinder.isAvailable()) {
        return null;
      }
      const frecencyDbPath = resolveFrecencyDbPath(basePath);
      const created = mod.FileFinder.create({
        basePath,
        aiMode: true,
        ...(frecencyDbPath ? { frecencyDbPath } : {}),
      });
      if (!created.ok) {
        return null;
      }
      const finder = created.value;
      const scanReady = finder
        .waitForScan(SCAN_READY_TIMEOUT_MS)
        .then((result) => result.ok && result.value)
        .catch(() => false);
      return { finder, scanReady };
    } catch {
      return null;
    }
  })();
}

/**
 * Return the long-lived finder for `basePath`, creating (and starting the
 * background scan of) one on first request. Concurrent callers share the same
 * in-flight creation promise, so a workspace is never double-indexed. Resolves
 * `null` when fff is unavailable.
 */
export function acquireFinder(basePath: string): Promise<AcquiredFinder | null> {
  let entry = finders.get(basePath);
  if (!entry) {
    entry = createAcquired(basePath);
    finders.set(basePath, entry);
  }
  return entry;
}

/** Eagerly start indexing `basePath` without awaiting (session-init warmup). */
export function warmFinder(basePath: string): void {
  void acquireFinder(basePath);
}

/**
 * Record that the agent read `absolutePath` so fff's frecency ranking learns
 * which files this session actually touches. Fire-and-forget and best-effort:
 * reuses (or creates) the workspace finder and tracks the access; a no-op when
 * fff is unavailable or the path is outside the indexed root.
 */
export function noteFileAccess(basePath: string, absolutePath: string): void {
  void (async (): Promise<void> => {
    try {
      const relativePath = relative(basePath, absolutePath);
      if (!relativePath || relativePath.startsWith("..")) {
        return;
      }
      const acquired = await acquireFinder(basePath);
      acquired?.finder.trackQuery(basename(absolutePath), relativePath);
    } catch {
      // best-effort frecency tracking
    }
  })();
}

/** Destroy every cached finder and free native resources (teardown). */
export async function disposeFinders(): Promise<void> {
  const entries = [...finders.values()];
  finders.clear();
  for (const entry of entries) {
    const acquired = await entry.catch(() => null);
    try {
      acquired?.finder.destroy();
    } catch {
      // best-effort teardown
    }
  }
}
