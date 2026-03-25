import { createHash, randomUUID } from "node:crypto";
import { cp, copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import type { PatchFileAction, PatchSet } from "@brewva/brewva-runtime";
import { resolveDetachedSubagentContextManifestPath } from "./background-protocol.js";

const IGNORED_ROOT_SEGMENTS = new Set([".git", "node_modules", ".orchestrator"]);
const IGNORED_RELATIVE_PATHS = new Set([".brewva/skills_index.json"]);
const PATCH_ARTIFACT_ROOT = ".orchestrator/subagent-patch-artifacts";
const PATCH_MANIFEST_FILE_NAME = "patchset.json";

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
  const [firstSegment] = normalized.split("/");
  return firstSegment ? IGNORED_ROOT_SEGMENTS.has(firstSegment) : false;
}

function hashBuffer(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function buildPatchArtifactFileName(relativePath: string): string {
  const digest = createHash("sha256").update(relativePath).digest("hex").slice(0, 16);
  const name = basename(relativePath).replaceAll(/[^a-zA-Z0-9._-]+/g, "_");
  return `${digest}-${name || "artifact"}`;
}

async function collectWorkspaceFiles(root: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();

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
  await cp(resolvedSourceRoot, isolatedRoot, {
    recursive: true,
    force: true,
    filter: (sourcePath) => {
      const relativePath = normalizeRelativePath(relative(resolvedSourceRoot, sourcePath));
      return !shouldIgnorePath(relativePath);
    },
  });
  return {
    root: isolatedRoot,
    dispose: async () => {
      await rm(tempRoot, { recursive: true, force: true });
    },
  };
}

export async function copyDelegationContextManifestToIsolatedWorkspace(input: {
  sourceRoot: string;
  isolatedRoot: string;
  runId: string;
}): Promise<string | undefined> {
  const sourcePath = resolveDetachedSubagentContextManifestPath(input.sourceRoot, input.runId);
  const targetPath = resolveDetachedSubagentContextManifestPath(input.isolatedRoot, input.runId);
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
}): Promise<PatchSet | undefined> {
  const before = await collectWorkspaceFiles(input.sourceRoot);
  const after = await collectWorkspaceFiles(input.isolatedRoot);
  const patchSetId = `patch_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
  const paths = [...new Set([...before.keys(), ...after.keys()])].toSorted();
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
