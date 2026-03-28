import { existsSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { TaskSpec } from "../contracts/index.js";

function isAbsoluteTargetDirectory(pathText: string): boolean {
  try {
    return existsSync(pathText) && statSync(pathText).isDirectory();
  } catch {
    return false;
  }
}

function resolveTargetAnchor(cwd: string, pathText: string): string {
  const absolute = resolve(cwd, pathText);
  if (isAbsoluteTargetDirectory(absolute)) {
    return absolute;
  }
  return dirname(absolute);
}

function findAncestor(
  startDir: string,
  predicate: (dir: string) => boolean,
  stopDir?: string,
): string | undefined {
  let current = resolve(startDir);
  const boundary = stopDir ? resolve(stopDir) : undefined;
  while (true) {
    if (predicate(current)) {
      return current;
    }
    if (boundary && current === boundary) {
      break;
    }
    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return undefined;
}

function hasRepositoryMarker(dir: string): boolean {
  return existsSync(resolve(dir, ".git")) || existsSync(resolve(dir, ".brewva", "brewva.json"));
}

function isWithinWorkspace(workspaceRoot: string, candidate: string): boolean {
  const resolvedWorkspaceRoot = resolve(workspaceRoot);
  const relativePath = relative(resolvedWorkspaceRoot, resolve(candidate));
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

function uniqueOrdered(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const normalized = resolve(value);
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

export function resolveTaskTargetRoots(input: {
  cwd: string;
  workspaceRoot: string;
  spec?: TaskSpec;
}): string[] {
  const workspaceRoot = resolve(input.workspaceRoot);
  const files = input.spec?.targets?.files?.filter((value) => value.trim().length > 0) ?? [];
  const anchors =
    files.length > 0 ? files.map((file) => resolveTargetAnchor(input.cwd, file)) : [input.cwd];
  const roots = anchors.map((anchor) => {
    const normalizedAnchor = resolve(anchor);
    return (
      findAncestor(
        normalizedAnchor,
        hasRepositoryMarker,
        isWithinWorkspace(workspaceRoot, normalizedAnchor) ? workspaceRoot : undefined,
      ) ?? normalizedAnchor
    );
  });
  return uniqueOrdered(roots.length > 0 ? roots : [workspaceRoot]);
}

export function resolvePrimaryTaskTargetRoot(input: {
  cwd: string;
  workspaceRoot: string;
  spec?: TaskSpec;
}): string {
  return resolveTaskTargetRoots(input)[0] ?? resolve(input.cwd);
}
