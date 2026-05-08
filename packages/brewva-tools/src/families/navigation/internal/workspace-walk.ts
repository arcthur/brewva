import { lstatSync, readdirSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";

export const DEFAULT_SKIPPED_WORKSPACE_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  ".next",
  "coverage",
]);

const DEFAULT_ALLOWED_HIDDEN_DIRS = new Set([".config"]);

export interface WalkWorkspaceFilesOptions {
  roots: readonly string[];
  maxFiles: number;
  isMatch(filePath: string): boolean;
  skippedDirs?: ReadonlySet<string>;
  allowedHiddenDirs?: ReadonlySet<string>;
  includeRootFiles?: boolean;
}

export function walkWorkspaceFiles(input: WalkWorkspaceFilesOptions): {
  files: string[];
  overflow: boolean;
} {
  const seenDirectories = new Set<string>();
  const seenFiles = new Set<string>();
  const files: string[] = [];
  let overflow = false;
  const skippedDirs = input.skippedDirs ?? DEFAULT_SKIPPED_WORKSPACE_DIRS;
  const allowedHiddenDirs = input.allowedHiddenDirs ?? DEFAULT_ALLOWED_HIDDEN_DIRS;
  const includeRootFiles = input.includeRootFiles ?? true;

  const resolveCanonicalPath = (target: string): string => {
    try {
      return realpathSync(target);
    } catch {
      return target;
    }
  };

  const pushFile = (filePath: string, isRoot: boolean): void => {
    if (isRoot && !includeRootFiles) {
      return;
    }
    if (!input.isMatch(filePath)) {
      return;
    }
    if (seenFiles.has(filePath)) {
      return;
    }
    if (files.length >= input.maxFiles) {
      overflow = true;
      return;
    }
    seenFiles.add(filePath);
    files.push(filePath);
  };

  const visitDirectory = (directoryPath: string): void => {
    if (overflow) {
      return;
    }
    const canonicalDirectory = resolveCanonicalPath(directoryPath);
    if (seenDirectories.has(canonicalDirectory)) {
      return;
    }
    seenDirectories.add(canonicalDirectory);

    let entries: Array<import("node:fs").Dirent>;
    try {
      entries = readdirSync(canonicalDirectory, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (overflow) {
        return;
      }
      if (entry.name.startsWith(".") && !allowedHiddenDirs.has(entry.name)) {
        continue;
      }
      if (entry.isDirectory() && skippedDirs.has(entry.name)) {
        continue;
      }
      const childPath = join(canonicalDirectory, entry.name);
      if (entry.isDirectory()) {
        visitDirectory(childPath);
        continue;
      }
      if (entry.isFile()) {
        pushFile(childPath, false);
        continue;
      }
      visit(childPath, false);
    }
  };

  const visit = (target: string, isRoot = false): void => {
    if (overflow) {
      return;
    }

    let stats: import("node:fs").Stats;
    let canonicalTarget = target;
    try {
      const targetStats = lstatSync(target);
      if (targetStats.isSymbolicLink()) {
        canonicalTarget = resolveCanonicalPath(target);
        stats = statSync(canonicalTarget);
      } else {
        stats = targetStats;
        if (stats.isDirectory() || stats.isFile()) {
          canonicalTarget = resolveCanonicalPath(target);
        }
      }
    } catch {
      return;
    }

    if (stats.isDirectory()) {
      visitDirectory(canonicalTarget);
      return;
    }
    if (!stats.isFile()) {
      return;
    }
    pushFile(canonicalTarget, isRoot);
  };

  for (const root of input.roots) {
    visit(root, true);
  }

  return {
    files,
    overflow,
  };
}
