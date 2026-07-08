import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { toErrorMessage } from "@brewva/brewva-std/unknown";
import type { WorldEnumerationSource, WorldFileMode } from "./types.js";

/**
 * Capture-scope enumeration. The scope is the restore promise: what capture
 * enumerates is exactly what a later restore may write or delete, so both
 * backends share the same hard exclusions and the same size caps.
 *
 * - Git workspaces enumerate `tracked + untracked-unignored` via
 *   `git ls-files --cached --others --exclude-standard`, matching the ignore
 *   semantics the workspace already declares.
 * - Git-less workspaces fall back to a bounded walk with fixed directory-name
 *   exclusions.
 * - Exceeding `maxFileCount`/`maxTotalBytes` fails the capture closed on
 *   EITHER backend rather than silently truncating or silently hashing
 *   gigabytes at a turn boundary.
 *
 * Symlinks and directories (git submodule links) are outside the promise:
 * they are never captured, so restore never deletes them. This walker is
 * deliberately not the navigation-family `walkWorkspaceFiles` search walker:
 * capture scope is a durable contract (hidden files included, runtime data
 * roots excluded, caps fail closed), not a search heuristic.
 */

/**
 * Runtime-data root directory names never treated as workspace content — the
 * single source of truth shared by capture enumeration AND the delegation fork
 * copy. The store must not capture itself, and brewva's own durable state
 * (`.git`; `.brewva` tape/worlds/steering; `.orchestrator` ledger/projection/
 * recovery-WAL and delegation artifacts) churns constantly — capturing it would
 * defeat world dedup and make a restore rewrite live runtime state.
 */
export const RUNTIME_DATA_ROOT_NAMES: ReadonlySet<string> = new Set([
  ".git",
  ".brewva",
  ".orchestrator",
]);

/** Additional directory names the git-less walk skips. */
const WALK_EXCLUDED_DIR_NAMES = new Set([...RUNTIME_DATA_ROOT_NAMES, "node_modules"]);

const GIT_LS_FILES_MAX_BUFFER_BYTES = 128 * 1024 * 1024;

/**
 * The one `git ls-files` invocation: tracked + untracked-unignored, NUL-split,
 * shared by capture enumeration and the delegation fork copy. Returns undefined
 * when the root is not a usable git workspace (no `.git`, missing/failed git),
 * so callers degrade to their own fallback.
 */
export function listGitScopedPaths(root: string): string[] | undefined {
  if (!existsSync(join(root, ".git"))) {
    return undefined;
  }
  const listed = spawnSync(
    "git",
    ["-C", root, "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { encoding: "utf8", maxBuffer: GIT_LS_FILES_MAX_BUFFER_BYTES },
  );
  if (listed.error || listed.status !== 0 || typeof listed.stdout !== "string") {
    return undefined;
  }
  return listed.stdout.split("\0").filter((path) => path.length > 0);
}

export interface EnumeratedFile {
  /** Workspace-relative path, `/`-separated. */
  readonly path: string;
  readonly absolutePath: string;
  readonly size: number;
  /** Nanosecond mtime as a decimal string (JSON-safe). */
  readonly mtimeNs: string;
  readonly mode: WorldFileMode;
}

export interface EnumerationSuccess {
  readonly ok: true;
  readonly source: WorldEnumerationSource;
  readonly files: readonly EnumeratedFile[];
}

export type EnumerationFailureReason =
  | "workspace_missing"
  | "enumeration_failed"
  | "workspace_too_large";

export interface EnumerationFailure {
  readonly ok: false;
  readonly reason: EnumerationFailureReason;
  readonly detail?: string;
}

export type EnumerationResult = EnumerationSuccess | EnumerationFailure;

export interface EnumerationOptions {
  readonly maxFileCount: number;
  readonly maxTotalBytes: number;
  /**
   * Workspace-relative paths (and their subtrees) excluded from the scope in
   * addition to the hard runtime-data roots — the resolved store directory is
   * always threaded here so a non-default `worlds.dir` can never capture
   * itself.
   */
  readonly excludedWorkspaceRelativePaths: readonly string[];
}

function isExcludedPath(
  relativePath: string,
  excludedWorkspaceRelativePaths: readonly string[],
): boolean {
  const [head] = relativePath.split("/", 1);
  if (head !== undefined && RUNTIME_DATA_ROOT_NAMES.has(head)) {
    return true;
  }
  return excludedWorkspaceRelativePaths.some(
    (excluded) => relativePath === excluded || relativePath.startsWith(`${excluded}/`),
  );
}

/** Lstat a candidate; returns undefined for anything outside the promise. */
function statEnumeratedFile(root: string, relativePath: string): EnumeratedFile | undefined {
  const absolutePath = join(root, relativePath);
  let stats;
  try {
    stats = lstatSync(absolutePath, { bigint: true });
  } catch {
    // Deleted-on-disk tracked files stay listed by `ls-files --cached`; the
    // world reflects the disk, so they simply leave the manifest.
    return undefined;
  }
  if (!stats.isFile()) {
    return undefined;
  }
  const executable = (Number(stats.mode) & 0o111) !== 0;
  return {
    path: relativePath,
    absolutePath,
    size: Number(stats.size),
    mtimeNs: stats.mtimeNs.toString(),
    mode: executable ? "executable" : "normal",
  };
}

function capExceeded(
  files: readonly EnumeratedFile[],
  totalBytes: number,
  options: EnumerationOptions,
): EnumerationFailure | undefined {
  if (files.length > options.maxFileCount || totalBytes > options.maxTotalBytes) {
    return {
      ok: false,
      reason: "workspace_too_large",
      detail: `entries=${files.length} bytes=${totalBytes}`,
    };
  }
  return undefined;
}

/** Returns undefined when git is unusable so the caller degrades to the walk. */
function enumerateViaGit(
  root: string,
  options: EnumerationOptions,
): EnumerationSuccess | EnumerationFailure | undefined {
  const scoped = listGitScopedPaths(root);
  if (scoped === undefined) {
    return undefined;
  }
  const seen = new Set<string>();
  const files: EnumeratedFile[] = [];
  let totalBytes = 0;
  for (const raw of scoped) {
    if (!raw || seen.has(raw) || isExcludedPath(raw, options.excludedWorkspaceRelativePaths)) {
      continue;
    }
    seen.add(raw);
    const file = statEnumeratedFile(root, raw);
    if (!file) {
      continue;
    }
    files.push(file);
    totalBytes += file.size;
    const exceeded = capExceeded(files, totalBytes, options);
    if (exceeded) {
      return exceeded;
    }
  }
  return { ok: true, source: "git", files: sortByPath(files) };
}

function enumerateViaWalk(root: string, options: EnumerationOptions): EnumerationResult {
  const files: EnumeratedFile[] = [];
  let totalBytes = 0;
  const pending: string[] = [""];
  while (pending.length > 0) {
    const relativeDir = pending.pop() ?? "";
    let entries;
    try {
      entries = readdirSync(join(root, relativeDir), { withFileTypes: true });
    } catch (error) {
      return { ok: false, reason: "enumeration_failed", detail: toErrorMessage(error) };
    }
    for (const entry of entries) {
      const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      if (isExcludedPath(relativePath, options.excludedWorkspaceRelativePaths)) {
        continue;
      }
      if (entry.isDirectory()) {
        if (!WALK_EXCLUDED_DIR_NAMES.has(entry.name)) {
          pending.push(relativePath);
        }
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      const file = statEnumeratedFile(root, relativePath);
      if (!file) {
        continue;
      }
      files.push(file);
      totalBytes += file.size;
      const exceeded = capExceeded(files, totalBytes, options);
      if (exceeded) {
        return exceeded;
      }
    }
  }
  return { ok: true, source: "walk", files: sortByPath(files) };
}

function sortByPath(files: EnumeratedFile[]): EnumeratedFile[] {
  return files.toSorted((left, right) => (left.path < right.path ? -1 : 1));
}

export function enumerateWorkspaceFiles(
  root: string,
  options: EnumerationOptions,
): EnumerationResult {
  let rootStats;
  try {
    // statSync (not lstat): a workspace root reached through a symlink is a
    // perfectly usable workspace.
    rootStats = statSync(root);
  } catch {
    return { ok: false, reason: "workspace_missing" };
  }
  if (!rootStats.isDirectory()) {
    return { ok: false, reason: "workspace_missing" };
  }
  if (existsSync(join(root, ".git"))) {
    const viaGit = enumerateViaGit(root, options);
    if (viaGit) {
      return viaGit;
    }
  }
  return enumerateViaWalk(root, options);
}
