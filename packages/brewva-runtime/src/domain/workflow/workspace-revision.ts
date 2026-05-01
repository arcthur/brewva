import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { readString } from "./shared.js";

function readPackedRef(gitDir: string, refName: string): string | undefined {
  const packedRefsPath = join(gitDir, "packed-refs");
  if (!existsSync(packedRefsPath)) return undefined;
  try {
    const lines = readFileSync(packedRefsPath, "utf8").split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("^")) continue;
      const [hash, name] = trimmed.split(" ", 2);
      if (name === refName && readString(hash)) {
        return hash;
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function resolveGitDir(workspaceRoot: string): string | undefined {
  const dotGit = join(resolve(workspaceRoot), ".git");
  if (!existsSync(dotGit)) return undefined;
  try {
    const stats = statSync(dotGit);
    if (stats.isDirectory()) {
      return dotGit;
    }
    if (!stats.isFile()) return undefined;
    const contents = readFileSync(dotGit, "utf8");
    const match = contents.match(/^gitdir:\s*(.+)\s*$/im);
    if (!match?.[1]) return undefined;
    return resolve(workspaceRoot, match[1].trim());
  } catch {
    return undefined;
  }
}

export function resolveWorkspaceRevision(workspaceRoot: string): string | undefined {
  const gitDir = resolveGitDir(workspaceRoot);
  if (!gitDir) return undefined;
  const headPath = join(gitDir, "HEAD");
  if (!existsSync(headPath)) return undefined;
  try {
    const head = readFileSync(headPath, "utf8").trim();
    if (!head) return undefined;
    if (!head.startsWith("ref:")) {
      return head;
    }
    const refName = head.slice("ref:".length).trim();
    if (!refName) return undefined;
    const refPath = join(gitDir, refName);
    if (existsSync(refPath)) {
      return readString(readFileSync(refPath, "utf8")) ?? undefined;
    }
    return readPackedRef(gitDir, refName);
  } catch {
    return undefined;
  }
}
