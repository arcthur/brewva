import { existsSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
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

function findAncestor(startDir: string, predicate: (dir: string) => boolean): string | undefined {
  let current = resolve(startDir);
  while (true) {
    if (predicate(current)) {
      return current;
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
  const files = input.spec?.targets?.files?.filter((value) => value.trim().length > 0) ?? [];
  const anchors =
    files.length > 0 ? files.map((file) => resolveTargetAnchor(input.cwd, file)) : [input.cwd];
  const roots = anchors.map(
    (anchor) => findAncestor(anchor, hasRepositoryMarker) ?? resolve(anchor),
  );
  return uniqueOrdered(roots.length > 0 ? roots : [input.workspaceRoot]);
}

export function resolvePrimaryTaskTargetRoot(input: {
  cwd: string;
  workspaceRoot: string;
  spec?: TaskSpec;
}): string {
  return resolveTaskTargetRoots(input)[0] ?? resolve(input.cwd);
}
