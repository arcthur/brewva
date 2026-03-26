import { existsSync, readFileSync } from "node:fs";
import type { PatchFileAction } from "../contracts/index.js";
import { isIgnoredWorkspacePath, normalizeWorkspaceRelativePath } from "./workspace-paths.js";

export const PATCH_HISTORY_FILE = "patchsets.json";

export interface PersistedPatchChange {
  path: string;
  action: PatchFileAction;
  beforeExists?: boolean;
  beforeHash?: string;
  afterHash?: string;
  beforeSnapshotFile?: string;
  artifactRef?: string;
}

export interface PersistedPatchSet {
  id: string;
  createdAt: number;
  summary?: string;
  toolName: string;
  appliedAt: number;
  changes: PersistedPatchChange[];
}

export interface PersistedPatchHistory {
  version: 1;
  sessionId: string;
  updatedAt: number;
  patchSets: PersistedPatchSet[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPatchAction(value: unknown): value is PatchFileAction {
  return value === "add" || value === "modify" || value === "delete";
}

function normalizePersistedPatchChange(value: unknown): PersistedPatchChange | null {
  if (!isRecord(value)) {
    return null;
  }
  if (typeof value.path !== "string" || !isPatchAction(value.action)) {
    return null;
  }

  const normalized: PersistedPatchChange = {
    path: normalizeWorkspaceRelativePath(value.path),
    action: value.action,
  };

  if (typeof value.beforeExists === "boolean") {
    normalized.beforeExists = value.beforeExists;
  }
  if (typeof value.beforeHash === "string") {
    normalized.beforeHash = value.beforeHash;
  }
  if (typeof value.afterHash === "string") {
    normalized.afterHash = value.afterHash;
  }
  if (typeof value.beforeSnapshotFile === "string") {
    normalized.beforeSnapshotFile = value.beforeSnapshotFile;
  }
  if (typeof value.artifactRef === "string") {
    normalized.artifactRef = value.artifactRef;
  }

  return normalized;
}

function normalizePersistedPatchSet(value: unknown): PersistedPatchSet | null {
  if (!isRecord(value)) {
    return null;
  }
  if (
    typeof value.id !== "string" ||
    typeof value.toolName !== "string" ||
    typeof value.createdAt !== "number" ||
    typeof value.appliedAt !== "number" ||
    !Array.isArray(value.changes)
  ) {
    return null;
  }

  const changes = value.changes
    .map((change) => normalizePersistedPatchChange(change))
    .filter((change): change is PersistedPatchChange => change !== null);

  return {
    id: value.id,
    createdAt: value.createdAt,
    summary: typeof value.summary === "string" ? value.summary : undefined,
    toolName: value.toolName,
    appliedAt: value.appliedAt,
    changes,
  };
}

export function readPersistedPatchHistory(path: string): PersistedPatchHistory | null {
  if (!existsSync(path)) {
    return null;
  }

  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!isRecord(parsed)) {
      return null;
    }
    if (
      parsed.version !== 1 ||
      typeof parsed.sessionId !== "string" ||
      typeof parsed.updatedAt !== "number" ||
      !Array.isArray(parsed.patchSets)
    ) {
      return null;
    }

    return {
      version: 1,
      sessionId: parsed.sessionId,
      updatedAt: parsed.updatedAt,
      patchSets: parsed.patchSets
        .map((entry) => normalizePersistedPatchSet(entry))
        .filter((entry): entry is PersistedPatchSet => entry !== null),
    };
  } catch {
    return null;
  }
}

export function listPersistedPatchSets(input: {
  path: string;
  sessionId?: string;
  cutoffTimestamp?: number | null;
}): PersistedPatchSet[] {
  const history = readPersistedPatchHistory(input.path);
  if (!history) {
    return [];
  }
  if (input.sessionId && history.sessionId !== input.sessionId) {
    return [];
  }

  return history.patchSets.filter((patchSet) => {
    if (input.cutoffTimestamp === null || input.cutoffTimestamp === undefined) {
      return true;
    }
    return patchSet.appliedAt <= input.cutoffTimestamp;
  });
}

export function collectPersistedPatchPaths(
  patchSets: PersistedPatchSet[],
  options: { ignoredPrefixes?: readonly string[] } = {},
): Set<string> {
  const collected = new Set<string>();
  for (const patchSet of patchSets) {
    for (const change of patchSet.changes) {
      const normalized = normalizeWorkspaceRelativePath(change.path);
      if (!normalized || isIgnoredWorkspacePath(normalized, options.ignoredPrefixes ?? [])) {
        continue;
      }
      collected.add(normalized);
    }
  }
  return collected;
}
