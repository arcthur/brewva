import { relative, resolve } from "node:path";

const DEFAULT_PATHISH_KEY_PATTERN = /(path|paths|file|files|cwd|workdir|dir|directory)/i;

interface CollectPathCandidatesOptions {
  keyPattern?: RegExp;
  allowUnkeyedString?: boolean;
}

interface ResolveWorkspacePathInput {
  candidate: string;
  cwd: string;
  workspaceRoot: string;
  allowWorkspaceRoot?: boolean;
  ignoredPrefixes?: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeWorkspaceRelativePath(path: string): string {
  return path.replaceAll("\\", "/").trim();
}

export function toWorkspaceRelativePath(
  workspaceRoot: string,
  absolutePath: string,
): string | null {
  const normalizedRoot = resolve(workspaceRoot);
  const normalizedPath = resolve(absolutePath);
  const rel = normalizeWorkspaceRelativePath(relative(normalizedRoot, normalizedPath));
  if (!rel || rel === ".") {
    return ".";
  }
  if (rel === ".." || rel.startsWith("../")) {
    return null;
  }
  return rel;
}

export function isIgnoredWorkspacePath(
  path: string,
  ignoredPrefixes: readonly string[] = [],
): boolean {
  const normalized = normalizeWorkspaceRelativePath(path);
  return ignoredPrefixes.some((prefix) => {
    const normalizedPrefix = normalizeWorkspaceRelativePath(prefix);
    const trimmedPrefix = normalizedPrefix.endsWith("/")
      ? normalizedPrefix.slice(0, -1)
      : normalizedPrefix;
    return normalized === trimmedPrefix || normalized.startsWith(`${trimmedPrefix}/`);
  });
}

export function collectPathCandidates(
  value: unknown,
  options: CollectPathCandidatesOptions = {},
): string[] {
  const keyPattern = options.keyPattern ?? DEFAULT_PATHISH_KEY_PATTERN;
  const output: string[] = [];

  const visit = (candidate: unknown, keyHint?: string): void => {
    if (typeof candidate === "string") {
      if (
        (typeof keyHint === "string" && keyPattern.test(keyHint)) ||
        (keyHint === undefined && options.allowUnkeyedString === true)
      ) {
        output.push(candidate);
      }
      return;
    }

    if (Array.isArray(candidate)) {
      for (const item of candidate) {
        visit(item, keyHint);
      }
      return;
    }

    if (!isRecord(candidate)) {
      return;
    }

    for (const [childKey, childValue] of Object.entries(candidate)) {
      visit(childValue, childKey);
    }
  };

  visit(value);
  return output;
}

export function resolveWorkspacePath(
  input: ResolveWorkspacePathInput,
): { absolutePath: string; relativePath: string } | undefined {
  const trimmed = input.candidate.trim();
  if (!trimmed || trimmed.includes("\0")) {
    return undefined;
  }

  const absolutePath = resolve(input.cwd, trimmed);
  const relativePath = toWorkspaceRelativePath(input.workspaceRoot, absolutePath);
  if (!relativePath) {
    return undefined;
  }
  if (!input.allowWorkspaceRoot && relativePath === ".") {
    return undefined;
  }
  if (isIgnoredWorkspacePath(relativePath, input.ignoredPrefixes ?? [])) {
    return undefined;
  }

  return {
    absolutePath,
    relativePath,
  };
}
