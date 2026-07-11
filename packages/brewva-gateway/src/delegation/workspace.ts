import { randomUUID } from "node:crypto";
import { constants, lstatSync } from "node:fs";
import { cp, copyFile, mkdir, mkdtemp, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { shortSha256Hex } from "@brewva/brewva-std/hash";
import { toPosixPath as normalizeRelativePath } from "@brewva/brewva-std/text";
import {
  createWorkspaceWorldStore,
  listGitScopedPaths,
  RUNTIME_DATA_ROOT_NAMES,
  WORLD_BLOB_HASH_PREFIX,
  type WorkspaceWorldStore,
  type WorldEnumerationSource,
  type WorldManifest,
} from "@brewva/brewva-tools/world-store";
import type { PatchFileAction, PatchSet } from "@brewva/brewva-vocabulary/workbench";
import { resolveDelegationContextBundleManifestPath } from "./context-manifest.js";

/**
 * Isolated-workspace physics for effectful delegation (the `patch-snapshot`
 * archetype and the `exec-ephemeral` verifier lane): fork a copy-on-write
 * workspace, run the worker inside it, and seal its delta as a basis-anchored
 * `PatchSet` the parent must explicitly adopt.
 *
 * Basis anchoring (coupled world rewind RFC, Phase 3): immediately after the
 * fork copy, the isolated tree is captured into the parent's world store —
 * `basisWorldId` is exactly what the worker saw. Sealing captures the fork
 * again (`resultWorldId`) and diffs the two content-addressed manifests, so
 * change detection cannot miss same-size/same-mtime rewrites, and every
 * change's `beforeHash` is BASIS content rather than whatever the parent
 * happens to contain at seal time. Adoption then detects parent divergence
 * per path instead of last-writer-wins.
 */

// The worker fork must not clone the parent's runtime state at all: tapes and
// steering are session truth the child must own fresh, the session-index clone
// would be a torn SQLite snapshot carrying the parent's live write lease, and
// the world store would recurse. `.git` is handled separately (git-scoped
// forks clone it; the filter governs the git-less fallback copy).
// The fork copy excludes the shared runtime-data roots (one source of truth
// with capture enumeration) plus `node_modules` as a copy-cost optimization
// (git ls-files already drops ignored deps; this covers the walk fallback).
const IGNORED_ROOT_SEGMENTS = new Set([...RUNTIME_DATA_ROOT_NAMES, "node_modules"]);
const PATCH_ARTIFACT_ROOT = ".orchestrator/subagent-patch-artifacts";
const PATCH_MANIFEST_FILE_NAME = "patchset.json";

function shouldIgnorePath(relativePath: string): boolean {
  const normalized = normalizeRelativePath(relativePath).replace(/^\.\/+/u, "");
  if (!normalized) {
    return false;
  }
  const [firstSegment] = normalized.split("/");
  return firstSegment ? IGNORED_ROOT_SEGMENTS.has(firstSegment) : false;
}

function buildPatchArtifactFileName(relativePath: string): string {
  const digest = shortSha256Hex(relativePath, 16);
  const name = basename(relativePath).replaceAll(/[^a-zA-Z0-9._-]+/g, "_");
  return `${digest}-${name || "artifact"}`;
}

/** Blob ref → the raw-hex form PatchSet changes carry. */
function blobRefToChangeHash(blobRef: string): string {
  return blobRef.startsWith(WORLD_BLOB_HASH_PREFIX)
    ? blobRef.slice(WORLD_BLOB_HASH_PREFIX.length)
    : blobRef;
}

// The fork's world store is FORK-LOCAL and ephemeral: it lives beside the
// isolated copy under the same tmpdir and dies with it on dispose. It never
// touches the parent's `.brewva/worlds`, so a delegation run neither pollutes
// the checkpoint lane's store (which is gated on `worlds.enabled`; delegation
// is not) nor shares its stat cache / GC lock / blobs. Basis and result worlds
// are transient diff scratch — nothing reads them after seal (adoption reads
// the artifact bytes copied to `.orchestrator/subagent-patch-artifacts`), so a
// fork-local store loses no durable capability while removing every shared-
// state hazard. Retention is irrelevant (the store holds one run's ≤2 worlds
// and is disposed whole), so a tiny bound suffices.
const FORK_STORE_DIR_NAME = "worlds";
const FORK_STORE_RETAIN = 4;
const FORK_STORE_SESSION_ID = "fork";

export interface IsolatedWorkspaceHandle {
  root: string;
  /** Content-addressed world of the fork at fork time — what the worker saw. */
  readonly basisWorldId: string;
  /** Enumeration backend the basis used; the seal must match it. */
  readonly basisSource: WorldEnumerationSource;
  readonly store: WorkspaceWorldStore;
  readonly runSessionId: string;
  dispose(): Promise<void>;
}

export class IsolatedWorkspaceForkError extends Error {
  constructor(
    readonly reason: string,
    detail?: string,
  ) {
    super(`isolated_workspace_fork_failed:${reason}${detail ? `:${detail}` : ""}`);
    this.name = "IsolatedWorkspaceForkError";
  }
}

export async function createIsolatedWorkspace(
  sourceRoot: string,
  prefix = "brewva-subagent-",
): Promise<IsolatedWorkspaceHandle> {
  const resolvedSourceRoot = resolve(sourceRoot);
  const tempRoot = await mkdtemp(join(tmpdir(), prefix));
  const isolatedRoot = resolve(tempRoot, "workspace");
  // Git workspaces fork by SCOPE, not by tree: clone exactly the parent's
  // tracked + untracked-unignored files plus `.git` itself. The fork then
  // enumerates with git semantics (basis and seal stay gitignore-scoped and
  // dedup against the parent's own worlds), gitignored build payloads never
  // bloat the store or trip the size caps, and the worker keeps git tooling.
  const gitScope = listGitScopedPaths(resolvedSourceRoot)?.filter(
    (path) => !shouldIgnorePath(path),
  );
  if (gitScope) {
    await mkdir(isolatedRoot, { recursive: true });
    for (const relativePath of gitScope) {
      const from = resolve(resolvedSourceRoot, relativePath);
      let stats;
      try {
        stats = lstatSync(from);
      } catch {
        continue;
      }
      const to = resolve(isolatedRoot, relativePath);
      await mkdir(dirname(to), { recursive: true });
      if (stats.isSymbolicLink()) {
        // Tracked symlinks stay symlinks (relative targets stay coherent
        // inside the fork; absolute targets behave as they did in place).
        try {
          await symlink(await readlink(from), to);
        } catch {
          // A broken or duplicate link is outside the capture promise anyway.
        }
        continue;
      }
      if (stats.isDirectory()) {
        // A gitlink (checked-out submodule): clone its whole tree so the
        // worker sees the same workspace the whole-tree copy used to give it.
        const copySubmodule = { recursive: true, force: true } satisfies Parameters<typeof cp>[2];
        try {
          await cp(from, to, { ...copySubmodule, mode: constants.COPYFILE_FICLONE });
        } catch {
          await cp(from, to, copySubmodule).catch(() => undefined);
        }
        continue;
      }
      if (!stats.isFile()) {
        continue;
      }
      try {
        await copyFile(from, to, constants.COPYFILE_FICLONE);
      } catch {
        await copyFile(from, to);
      }
    }
    // Clone `.git` ONLY when it is the real metadata directory. A linked
    // worktree's `.git` is a pointer FILE into the primary checkout's shared
    // metadata — copying it would let worker git commands mutate the PARENT's
    // index/HEAD through the fork. Such forks stay git-less on purpose; their
    // scope was already narrowed by the ls-files copy above, so walk-backed
    // basis/seal enumeration sees exactly the same files.
    let gitStats;
    try {
      gitStats = lstatSync(resolve(resolvedSourceRoot, ".git"));
    } catch {
      gitStats = undefined;
    }
    if (gitStats?.isDirectory()) {
      const gitDir = resolve(resolvedSourceRoot, ".git");
      const copyGit = { recursive: true, force: true } satisfies Parameters<typeof cp>[2];
      try {
        await cp(gitDir, resolve(isolatedRoot, ".git"), {
          ...copyGit,
          mode: constants.COPYFILE_FICLONE,
        });
      } catch {
        await cp(gitDir, resolve(isolatedRoot, ".git"), copyGit);
      }
    }
  } else {
    const copyOptions = {
      recursive: true,
      force: true,
      filter: (sourcePath: string) => {
        const relativePath = normalizeRelativePath(relative(resolvedSourceRoot, sourcePath));
        return !shouldIgnorePath(relativePath);
      },
    } satisfies Parameters<typeof cp>[2];
    try {
      await cp(resolvedSourceRoot, isolatedRoot, {
        ...copyOptions,
        mode: constants.COPYFILE_FICLONE,
      });
    } catch {
      await cp(resolvedSourceRoot, isolatedRoot, copyOptions);
    }
  }
  await mkdir(resolve(isolatedRoot, ".orchestrator"), { recursive: true });
  // Disposing the tmpdir reclaims the workspace copy AND the fork-local world
  // store (manifests, blobs, refs, stat cache) atomically — no lifecycle hook
  // into a shared store is needed.
  const dispose = async () => {
    await rm(tempRoot, { recursive: true, force: true });
  };
  // The basis capture IS the fork contract: without it the seal cannot anchor
  // `beforeHash` to what the worker saw, so a failed capture fails the fork
  // closed instead of degrading to last-writer-wins adoption. The store roots
  // at `tempRoot/worlds` — a sibling of the captured `isolatedRoot`, so it is
  // never itself enumerated — and dies with the tmpdir.
  const store = createWorkspaceWorldStore({
    workspaceRoot: isolatedRoot,
    dir: relative(isolatedRoot, resolve(tempRoot, FORK_STORE_DIR_NAME)),
    retainPerSession: FORK_STORE_RETAIN,
  });
  const basis = store.capture({ sessionId: FORK_STORE_SESSION_ID });
  if (!basis.ok) {
    await dispose();
    throw new IsolatedWorkspaceForkError(basis.reason, basis.detail);
  }
  return {
    root: isolatedRoot,
    basisWorldId: basis.worldId,
    basisSource: basis.source,
    store,
    runSessionId: FORK_STORE_SESSION_ID,
    dispose,
  };
}

export async function copyDelegationContextManifestToIsolatedWorkspace(input: {
  sourceRoot: string;
  isolatedRoot: string;
  runId: string;
}): Promise<string | undefined> {
  const sourcePath = resolveDelegationContextBundleManifestPath(input.sourceRoot, input.runId);
  const targetPath = resolveDelegationContextBundleManifestPath(input.isolatedRoot, input.runId);
  await mkdir(dirname(targetPath), { recursive: true });
  try {
    await copyFile(sourcePath, targetPath);
    return normalizeRelativePath(relative(input.isolatedRoot, targetPath));
  } catch {
    return undefined;
  }
}

function manifestByPath(manifest: WorldManifest | undefined): Map<string, string> {
  const byPath = new Map<string, string>();
  for (const entry of manifest?.files ?? []) {
    byPath.set(entry.path, entry.blob);
  }
  return byPath;
}

export type IsolatedPatchSealResult =
  | { readonly ok: true; readonly patchSet: PatchSet | undefined }
  | { readonly ok: false; readonly reason: string; readonly detail?: string };

export async function capturePatchSetFromIsolatedWorkspace(input: {
  sourceRoot: string;
  handle: IsolatedWorkspaceHandle;
  summary?: string;
}): Promise<IsolatedPatchSealResult> {
  const { handle } = input;
  const result = handle.store.capture({ sessionId: handle.runSessionId });
  if (!result.ok) {
    return {
      ok: false,
      reason: result.reason,
      ...(result.detail ? { detail: result.detail } : {}),
    };
  }
  if (result.source !== handle.basisSource) {
    // A worker that created or destroyed `.git` inside the fork flipped the
    // enumeration backend; the two manifests would no longer share a scope
    // and the diff would fabricate deletes for every newly-out-of-scope file.
    return {
      ok: false,
      reason: "enumeration_backend_changed",
      detail: `basis=${handle.basisSource} seal=${result.source}`,
    };
  }
  const basisManifest = handle.store.readManifest(handle.basisWorldId);
  if (!basisManifest) {
    return { ok: false, reason: "basis_world_missing", detail: handle.basisWorldId };
  }
  const before = manifestByPath(basisManifest);
  const after = manifestByPath(handle.store.readManifest(result.worldId));

  const patchSetId = `patch_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
  const paths = [...new Set([...before.keys(), ...after.keys()])].toSorted();
  const changes: PatchSet["changes"] = [];
  for (const path of paths) {
    const beforeBlob = before.get(path);
    const afterBlob = after.get(path);
    let action: PatchFileAction | undefined;
    if (beforeBlob && !afterBlob) {
      action = "delete";
    } else if (!beforeBlob && afterBlob) {
      action = "add";
    } else if (beforeBlob && afterBlob && beforeBlob !== afterBlob) {
      action = "modify";
    }
    if (!action) {
      continue;
    }
    let artifactRef: string | undefined;
    if (action !== "delete" && afterBlob) {
      // Artifact bytes come from the sealed world's blob, not a re-read of
      // the live fork file — the artifact is exactly what was sealed.
      const content = handle.store.readBlob(afterBlob);
      if (content === undefined) {
        return { ok: false, reason: "sealed_blob_missing", detail: path };
      }
      const artifactDir = resolve(input.sourceRoot, PATCH_ARTIFACT_ROOT, patchSetId);
      await mkdir(artifactDir, { recursive: true });
      const artifactAbsolutePath = resolve(artifactDir, buildPatchArtifactFileName(path));
      await writeFile(artifactAbsolutePath, content);
      artifactRef = normalizeRelativePath(relative(input.sourceRoot, artifactAbsolutePath));
    }
    changes.push({
      path,
      action,
      beforeHash: beforeBlob ? blobRefToChangeHash(beforeBlob) : undefined,
      afterHash: afterBlob ? blobRefToChangeHash(afterBlob) : undefined,
      artifactRef,
    });
  }

  if (changes.length === 0) {
    return { ok: true, patchSet: undefined };
  }

  const patchSet: PatchSet = {
    id: patchSetId,
    createdAt: Date.now(),
    summary: input.summary ?? `Captured ${changes.length} isolated workspace changes`,
    changes,
  };
  const manifestDir = resolve(input.sourceRoot, PATCH_ARTIFACT_ROOT, patchSetId);
  await mkdir(manifestDir, { recursive: true });
  await writeFile(
    resolve(manifestDir, PATCH_MANIFEST_FILE_NAME),
    JSON.stringify(patchSet, null, 2),
    "utf8",
  );
  return { ok: true, patchSet };
}
