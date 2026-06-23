import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { resolve, sep } from "node:path";
import type { WorktreeInfo } from "@brewva/brewva-substrate/prompt";

export function parseGitWorktreePorcelain(stdout: string): WorktreeInfo[] {
  const worktrees: WorktreeInfo[] = [];
  let current: WorktreeInfo | undefined;
  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.trim();
    if (line.startsWith("worktree ")) {
      if (current) {
        worktrees.push(current);
      }
      current = { path: line.slice("worktree ".length), branch: undefined };
    } else if (line.startsWith("branch ") && current) {
      current.branch = line.slice("branch ".length).replace(/^refs\/heads\//u, "");
    }
  }
  if (current) {
    worktrees.push(current);
  }
  return worktrees;
}

function canonicalPath(path: string): string {
  const resolved = resolve(path);
  try {
    return existsSync(resolved) ? realpathSync(resolved) : resolved;
  } catch {
    return resolved;
  }
}

function isPathInsideRoot(path: string, root: string): boolean {
  const resolvedPath = resolve(path);
  const resolvedRoot = resolve(root);
  if (resolvedPath === resolvedRoot) {
    return true;
  }
  const prefix = resolvedRoot.endsWith(sep) ? resolvedRoot : `${resolvedRoot}${sep}`;
  return resolvedPath.startsWith(prefix);
}

export function filterGitWorktreesInsideRoot(
  worktrees: readonly WorktreeInfo[],
  root: string,
): WorktreeInfo[] {
  const canonicalRoot = canonicalPath(root);
  return worktrees
    .map((worktree) => ({ ...worktree, path: canonicalPath(worktree.path) }))
    .filter((worktree) => isPathInsideRoot(worktree.path, canonicalRoot));
}

/**
 * Collect the git worktrees rooted at `cwd` so the agent's environment block can
 * advertise them. Returns [] when `cwd` is not a git repository or git is
 * unavailable: this is advisory context for navigation, never a hard failure.
 */
export function collectGitWorktrees(cwd: string): WorktreeInfo[] {
  try {
    const stdout = execFileSync("git", ["worktree", "list", "--porcelain"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
    });
    return filterGitWorktreesInsideRoot(parseGitWorktreePorcelain(stdout), cwd);
  } catch {
    return [];
  }
}
