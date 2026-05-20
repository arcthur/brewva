import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { cp, copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import type { PatchFileAction, PatchSet } from "@brewva/brewva-runtime/protocol";
import {
  PATCH_HISTORY_FILE,
  collectPersistedPatchPaths,
  listPersistedPatchSets,
} from "@brewva/brewva-runtime/protocol";
import { sha256Hex, shortSha256Hex } from "@brewva/brewva-std/hash";
import { resolveDelegationContextBundleManifestPath } from "./context-manifest.js";

const IGNORED_ROOT_SEGMENTS = new Set([".git", "node_modules", ".orchestrator"]);
const IGNORED_RELATIVE_PATHS = new Set([".brewva/skills_index.json"]);
const IGNORED_RELATIVE_PREFIXES = [".brewva/tape/"] as const;
const PATCH_ARTIFACT_ROOT = ".orchestrator/subagent-patch-artifacts";
const PATCH_MANIFEST_FILE_NAME = "patchset.json";
const ISOLATED_WORKSPACE_BASELINE_FILE = ".orchestrator/isolated-workspace-baseline.json";

interface WorkspaceFileMetadata {
  size: number;
  mtimeMs: string;
}

interface IsolatedWorkspaceBaselineManifest {
  schema: "brewva.isolated-workspace-baseline.v1";
  capturedAt: number;
  files: Record<string, WorkspaceFileMetadata>;
}

function normalizeRelativePath(path: string): string {
  return path.replaceAll("\\", "/");
}

function shouldIgnorePath(relativePath: string): boolean {
  const normalized = normalizeRelativePath(relativePath).replace(/^\.\/+/u, "");
  if (!normalized) {
    return false;
  }
  if (IGNORED_RELATIVE_PATHS.has(normalized)) {
    return true;
  }
  if (IGNORED_RELATIVE_PREFIXES.some((prefix) => normalized.startsWith(prefix))) {
    return true;
  }
  const [firstSegment] = normalized.split("/");
  return firstSegment ? IGNORED_ROOT_SEGMENTS.has(firstSegment) : false;
}

function hashBuffer(buffer: Buffer): string {
  return sha256Hex(buffer);
}

function buildPatchArtifactFileName(relativePath: string): string {
  const digest = shortSha256Hex(relativePath, 16);
  const name = basename(relativePath).replaceAll(/[^a-zA-Z0-9._-]+/g, "_");
  return `${digest}-${name || "artifact"}`;
}

function sanitizeSessionId(sessionId: string): string {
  return sessionId.replaceAll(/[^\w.-]+/g, "_");
}

function resolvePatchHistoryPath(isolatedRoot: string, childSessionId: string): string {
  return resolve(
    isolatedRoot,
    ".orchestrator",
    "snapshots",
    sanitizeSessionId(childSessionId),
    PATCH_HISTORY_FILE,
  );
}

async function collectWorkspaceFiles(
  root: string,
  candidatePaths?: readonly string[],
): Promise<Map<string, string>> {
  const files = new Map<string, string>();

  if (candidatePaths && candidatePaths.length > 0) {
    for (const candidatePath of candidatePaths) {
      const normalizedPath = normalizeRelativePath(candidatePath);
      if (!normalizedPath || shouldIgnorePath(normalizedPath)) {
        continue;
      }
      try {
        const content = await readFile(resolve(root, normalizedPath));
        files.set(normalizedPath, hashBuffer(content));
      } catch {
        // Missing candidate paths are expected for deleted files.
      }
    }
    return files;
  }

  async function walk(currentDir: string): Promise<void> {
    const entries = await readdir(currentDir, { withFileTypes: true });
    await Promise.all(
      entries.map(async (entry) => {
        const absolutePath = resolve(currentDir, entry.name);
        const relativePath = normalizeRelativePath(relative(root, absolutePath));
        if (shouldIgnorePath(relativePath)) {
          return;
        }
        if (entry.isDirectory()) {
          await walk(absolutePath);
          return;
        }
        if (!entry.isFile()) {
          return;
        }
        const content = await readFile(absolutePath);
        files.set(relativePath, hashBuffer(content));
      }),
    );
  }

  await walk(root);
  return files;
}

function collectWorkspaceMetadata(root: string): Map<string, WorkspaceFileMetadata> {
  const files = new Map<string, WorkspaceFileMetadata>();

  function walk(currentDir: string): void {
    const entries = readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const absolutePath = resolve(currentDir, entry.name);
      const relativePath = normalizeRelativePath(relative(root, absolutePath));
      if (shouldIgnorePath(relativePath)) {
        continue;
      }
      if (entry.isDirectory()) {
        walk(absolutePath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      const stats = statSync(absolutePath);
      files.set(relativePath, {
        size: stats.size,
        mtimeMs: stats.mtimeMs.toFixed(3),
      });
    }
  }

  walk(root);
  return files;
}

function buildWorkspaceBaselineManifest(root: string): IsolatedWorkspaceBaselineManifest {
  return {
    schema: "brewva.isolated-workspace-baseline.v1",
    capturedAt: Date.now(),
    files: Object.fromEntries(collectWorkspaceMetadata(root)),
  };
}

function readWorkspaceBaselineManifest(
  isolatedRoot: string,
): IsolatedWorkspaceBaselineManifest | undefined {
  try {
    const raw = JSON.parse(
      readFileSync(resolve(isolatedRoot, ISOLATED_WORKSPACE_BASELINE_FILE), "utf8"),
    ) as Partial<IsolatedWorkspaceBaselineManifest>;
    if (raw?.schema !== "brewva.isolated-workspace-baseline.v1") {
      return undefined;
    }
    if (!raw.files || typeof raw.files !== "object") {
      return undefined;
    }
    const files = Object.fromEntries(
      Object.entries(raw.files).flatMap(([path, metadata]) => {
        if (
          typeof path !== "string" ||
          shouldIgnorePath(path) ||
          !metadata ||
          typeof metadata !== "object" ||
          typeof metadata.size !== "number" ||
          typeof metadata.mtimeMs !== "string"
        ) {
          return [];
        }
        return [
          [
            path,
            { size: metadata.size, mtimeMs: metadata.mtimeMs } satisfies WorkspaceFileMetadata,
          ],
        ];
      }),
    );
    return {
      schema: "brewva.isolated-workspace-baseline.v1",
      capturedAt: typeof raw.capturedAt === "number" ? raw.capturedAt : 0,
      files,
    };
  } catch {
    return undefined;
  }
}

function collectChangedPathsFromBaselineManifest(isolatedRoot: string): string[] | undefined {
  const baseline = readWorkspaceBaselineManifest(isolatedRoot);
  if (!baseline) {
    return undefined;
  }
  const current = collectWorkspaceMetadata(isolatedRoot);
  const changed = new Set<string>();
  const allPaths = new Set<string>([...Object.keys(baseline.files), ...current.keys()]);
  for (const path of allPaths) {
    if (shouldIgnorePath(path)) {
      continue;
    }
    const before = baseline.files[path];
    const after = current.get(path);
    if (!before || !after) {
      changed.add(path);
      continue;
    }
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
      changed.add(path);
    }
  }
  return changed.size > 0 ? [...changed].toSorted() : undefined;
}

export interface IsolatedWorkspaceHandle {
  root: string;
  dispose(): Promise<void>;
}

export async function createIsolatedWorkspace(
  sourceRoot: string,
  prefix = "brewva-subagent-",
): Promise<IsolatedWorkspaceHandle> {
  const resolvedSourceRoot = resolve(sourceRoot);
  const tempRoot = await mkdtemp(join(tmpdir(), prefix));
  const isolatedRoot = resolve(tempRoot, "workspace");
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
  await mkdir(resolve(isolatedRoot, ".orchestrator"), { recursive: true });
  await writeFile(
    resolve(isolatedRoot, ISOLATED_WORKSPACE_BASELINE_FILE),
    JSON.stringify(buildWorkspaceBaselineManifest(isolatedRoot), null, 2),
    "utf8",
  );
  return {
    root: isolatedRoot,
    dispose: async () => {
      await rm(tempRoot, { recursive: true, force: true });
    },
  };
}

export function collectChangedPathsFromIsolatedWorkspace(input: {
  isolatedRoot: string;
  childSessionId?: string;
}): string[] | undefined {
  const changedPaths = new Set<string>();
  if (input.childSessionId) {
    const patchSets = listPersistedPatchSets({
      path: resolvePatchHistoryPath(input.isolatedRoot, input.childSessionId),
      sessionId: input.childSessionId,
    });
    for (const path of collectPersistedPatchPaths(patchSets)) {
      if (!shouldIgnorePath(path)) {
        changedPaths.add(path);
      }
    }
  }
  for (const path of collectChangedPathsFromBaselineManifest(input.isolatedRoot) ?? []) {
    changedPaths.add(path);
  }
  return changedPaths.size > 0 ? [...changedPaths].toSorted() : undefined;
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

export async function capturePatchSetFromIsolatedWorkspace(input: {
  sourceRoot: string;
  isolatedRoot: string;
  summary?: string;
  candidatePaths?: readonly string[];
}): Promise<PatchSet | undefined> {
  const candidatePaths = [
    ...(input.candidatePaths ?? []),
    ...(collectChangedPathsFromBaselineManifest(input.isolatedRoot) ?? []),
  ]
    .map((path) => normalizeRelativePath(path))
    .filter(
      (path, index, array) =>
        path.length > 0 && !shouldIgnorePath(path) && array.indexOf(path) === index,
    );
  const normalizedCandidatePaths =
    candidatePaths
      ?.map((path) => normalizeRelativePath(path))
      .filter((path) => path.length > 0 && !shouldIgnorePath(path)) ?? [];
  const before = await collectWorkspaceFiles(
    input.sourceRoot,
    normalizedCandidatePaths.length > 0 ? normalizedCandidatePaths : undefined,
  );
  const after = await collectWorkspaceFiles(
    input.isolatedRoot,
    normalizedCandidatePaths.length > 0 ? normalizedCandidatePaths : undefined,
  );
  const patchSetId = `patch_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
  const paths =
    normalizedCandidatePaths.length > 0
      ? [...new Set(normalizedCandidatePaths)].toSorted()
      : [...new Set([...before.keys(), ...after.keys()])].toSorted();
  const changes: PatchSet["changes"] = [];

  for (const path of paths) {
    const beforeHash = before.get(path);
    const afterHash = after.get(path);
    let action: PatchFileAction | undefined;
    if (beforeHash && !afterHash) {
      action = "delete";
    } else if (!beforeHash && afterHash) {
      action = "add";
    } else if (beforeHash && afterHash && beforeHash !== afterHash) {
      action = "modify";
    }
    if (!action) {
      continue;
    }
    let artifactRef: string | undefined;
    if (action !== "delete") {
      const artifactDir = resolve(input.sourceRoot, PATCH_ARTIFACT_ROOT, patchSetId);
      await mkdir(artifactDir, { recursive: true });
      const artifactFileName = buildPatchArtifactFileName(path);
      const artifactAbsolutePath = resolve(artifactDir, artifactFileName);
      const artifactContent = await readFile(resolve(input.isolatedRoot, path));
      await writeFile(artifactAbsolutePath, artifactContent);
      artifactRef = normalizeRelativePath(relative(input.sourceRoot, artifactAbsolutePath));
    }
    changes.push({
      path,
      action,
      beforeHash,
      afterHash,
      artifactRef,
    });
  }

  if (changes.length === 0) {
    return undefined;
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
  return patchSet;
}
