import { readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { forEachUtf8LineSync } from "@brewva/brewva-std/node/fs";
import { readNonEmptyString } from "@brewva/brewva-std/text";
import { isRecord, toErrorMessage } from "@brewva/brewva-std/unknown";
import {
  buildManagedSessionContext,
  type BrewvaBranchSummaryEntry,
  type BrewvaCompactionEntry,
  type BrewvaManagedSessionStore,
  type BrewvaModelChangeEntry,
  type BrewvaModelPresetSelectEntry,
  type BrewvaSessionContext,
  type BrewvaSessionEntry,
  type BrewvaSessionMessageEntry,
  type BrewvaThinkingLevelChangeEntry,
} from "../session/managed-session-store.js";
import type { BrewvaModelRoleAlias, BrewvaModelRoleMap } from "../session/prompt-session.js";

export interface BrewvaSessionBundleManifest {
  format: "brewva.session.bundle.v1";
  sessionId: string;
  workspaceRoot: string;
  tapePath: string;
  checkpointPath: string;
  recoveryWalPath: string;
  projectionsDir: string;
  createdAt: string;
  updatedAt: string;
}

export interface ResolvedBrewvaSessionBundlePaths {
  tapePath: string;
  checkpointPath: string;
  recoveryWalPath: string;
  projectionsDir: string;
}

export interface BrewvaNativeSessionBundleArtifact {
  kind: "brewva_bundle";
  sourcePath: string;
  manifest: BrewvaSessionBundleManifest;
  bundleRoot: string;
  resolvedPaths: ResolvedBrewvaSessionBundlePaths;
}

export interface ImportedLegacyPiSessionArtifact {
  kind: "legacy_pi_jsonl";
  sourcePath: string;
  sessionId: string;
  workspaceRoot: string;
  createdAt: string;
  updatedAt: string;
  entries: BrewvaSessionEntry[];
  context: BrewvaSessionContext;
  warnings: string[];
}

export type BrewvaSessionBundleArtifact =
  | BrewvaNativeSessionBundleArtifact
  | ImportedLegacyPiSessionArtifact;

interface PiSessionHeader {
  type: "session";
  id: string;
  cwd: string;
  timestamp: string;
  version?: number;
}

type ReplayableSessionStore = Pick<
  BrewvaManagedSessionStore,
  | "resetLeaf"
  | "branch"
  | "appendMessage"
  | "appendThinkingLevelChange"
  | "appendModelChange"
  | "appendModelPresetSelection"
  | "appendCustomMessageEntry"
  | "appendCompaction"
  | "appendBranchSummaryEntry"
>;

function requireManifestString(
  record: Record<string, unknown>,
  key: keyof BrewvaSessionBundleManifest,
): string {
  const value = readNonEmptyString(record[key]);
  if (!value) {
    throw new Error(`invalid session bundle manifest: missing ${key}`);
  }
  return value;
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

const MODEL_ROLE_ALIASES = new Set<BrewvaModelRoleAlias>([
  "default",
  "smol",
  "slow",
  "plan",
  "commit",
  "task",
]);

function readOptionalRoleMap(value: unknown): BrewvaModelRoleMap | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const record: BrewvaModelRoleMap = {};
  for (const [key, rawValue] of Object.entries(value)) {
    if (!MODEL_ROLE_ALIASES.has(key as BrewvaModelRoleAlias)) {
      continue;
    }
    const stringValue = readOptionalString(rawValue);
    if (key.trim().length > 0 && stringValue) {
      record[key as BrewvaModelRoleAlias] = stringValue;
    }
  }
  return Object.keys(record).length > 0 ? record : {};
}

function ensureTimestamp(value: unknown, fallback: string): string {
  const raw = readOptionalString(value);
  if (!raw) {
    return fallback;
  }
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : fallback;
}

function ensureNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function buildResolvedPaths(
  bundleRoot: string,
  manifest: BrewvaSessionBundleManifest,
): ResolvedBrewvaSessionBundlePaths {
  return {
    tapePath: resolve(bundleRoot, manifest.tapePath),
    checkpointPath: resolve(bundleRoot, manifest.checkpointPath),
    recoveryWalPath: resolve(bundleRoot, manifest.recoveryWalPath),
    projectionsDir: resolve(bundleRoot, manifest.projectionsDir),
  };
}

function parseJsonLine(line: string, sourcePath: string, lineNumber: number): unknown {
  try {
    return JSON.parse(line);
  } catch (error) {
    throw new Error(
      `invalid session artifact ${sourcePath}:${lineNumber}: ${toErrorMessage(error)}`,
      {
        cause: error,
      },
    );
  }
}

function parseJsonLinesFile(sourcePath: string): unknown[] {
  const rows: unknown[] = [];
  forEachUtf8LineSync(sourcePath, (line, lineNumber) => {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }
    rows.push(parseJsonLine(trimmed, sourcePath, lineNumber));
  });
  return rows;
}

function isPiSessionHeader(value: unknown): value is PiSessionHeader {
  return (
    isRecord(value) &&
    value.type === "session" &&
    typeof value.id === "string" &&
    value.id.trim().length > 0 &&
    typeof value.cwd === "string" &&
    value.cwd.trim().length > 0 &&
    typeof value.timestamp === "string" &&
    value.timestamp.trim().length > 0
  );
}

function createMigratedEntryId(index: number): string {
  return `pi_import_${index.toString(16).padStart(4, "0")}`;
}

function migratePiEntriesInPlace(
  sourcePath: string,
  header: PiSessionHeader,
  entries: Record<string, unknown>[],
): void {
  const version = typeof header.version === "number" ? header.version : 1;

  if (version < 2) {
    const generatedIds = new Map<number, string>();
    let previousId: string | null = null;

    for (const [entryIndex, entry] of entries.entries()) {
      const fileIndex = entryIndex + 1;
      const id = createMigratedEntryId(fileIndex);
      generatedIds.set(fileIndex, id);
      entry.id = id;
      entry.parentId = previousId;
      previousId = id;
    }

    for (const entry of entries) {
      if (entry.type !== "compaction" || typeof entry.firstKeptEntryIndex !== "number") {
        continue;
      }
      const firstKeptId = generatedIds.get(entry.firstKeptEntryIndex);
      if (firstKeptId) {
        entry.firstKeptEntryId = firstKeptId;
      }
      delete entry.firstKeptEntryIndex;
    }
  }

  if (version < 3) {
    for (const entry of entries) {
      if (entry.type !== "message" || !isRecord(entry.message)) {
        continue;
      }
      if (entry.message.role === "hookMessage") {
        entry.message.role = "custom";
      }
    }
  }

  header.version = 3;

  for (const entry of entries) {
    const id = readOptionalString(entry.id);
    const timestamp = readOptionalString(entry.timestamp);
    if (!id || !timestamp) {
      throw new Error(`invalid Pi session artifact ${sourcePath}: missing entry id/timestamp`);
    }
    if (
      entry.parentId !== null &&
      entry.parentId !== undefined &&
      !readOptionalString(entry.parentId)
    ) {
      throw new Error(`invalid Pi session artifact ${sourcePath}: malformed parentId for ${id}`);
    }
  }
}

function toImportedMessage(
  sourcePath: string,
  entryId: string,
  candidate: unknown,
): BrewvaSessionMessageEntry["message"] {
  if (!isRecord(candidate)) {
    throw new Error(
      `invalid Pi session artifact ${sourcePath}: malformed message entry ${entryId}`,
    );
  }

  const role = readOptionalString(candidate.role);
  const timestamp = candidate.timestamp;
  if (!role || typeof timestamp !== "number" || !Number.isFinite(timestamp)) {
    throw new Error(
      `invalid Pi session artifact ${sourcePath}: malformed message entry ${entryId}`,
    );
  }

  return {
    ...structuredClone(candidate),
    role,
    timestamp,
  };
}

function toImportedSessionEntry(
  sourcePath: string,
  entry: Record<string, unknown>,
  warnings: string[],
): BrewvaSessionEntry | undefined {
  const type = readOptionalString(entry.type);
  const id = readOptionalString(entry.id);
  const timestamp = readOptionalString(entry.timestamp);
  const parentId =
    entry.parentId === null ? null : (readOptionalString(entry.parentId) ?? undefined);
  if (!type || !id || !timestamp || parentId === undefined) {
    throw new Error(`invalid Pi session artifact ${sourcePath}: malformed entry`);
  }

  if (type === "message") {
    return {
      type: "message",
      id,
      parentId,
      timestamp,
      message: toImportedMessage(sourcePath, id, entry.message),
    };
  }

  if (type === "thinking_level_change") {
    const thinkingLevel = readOptionalString(entry.thinkingLevel);
    if (!thinkingLevel) {
      throw new Error(`invalid Pi session artifact ${sourcePath}: missing thinkingLevel for ${id}`);
    }
    return {
      type: "thinking_level_change",
      id,
      parentId,
      timestamp,
      thinkingLevel,
    } satisfies BrewvaThinkingLevelChangeEntry;
  }

  if (type === "model_change") {
    const provider = readOptionalString(entry.provider);
    const modelId = readOptionalString(entry.modelId);
    if (!provider || !modelId) {
      throw new Error(`invalid Pi session artifact ${sourcePath}: malformed model_change ${id}`);
    }
    return {
      type: "model_change",
      id,
      parentId,
      timestamp,
      provider,
      modelId,
    } satisfies BrewvaModelChangeEntry;
  }

  if (type === "model_preset_select") {
    const presetName = readOptionalString(entry.presetName);
    if (!presetName) {
      throw new Error(
        `invalid Pi session artifact ${sourcePath}: malformed model_preset_select ${id}`,
      );
    }
    return {
      type: "model_preset_select",
      id,
      parentId,
      timestamp,
      presetName,
      previousPresetName: readOptionalString(entry.previousPresetName),
      source: readOptionalString(entry.source),
      roles: readOptionalRoleMap(entry.roles),
      synthetic: entry.synthetic === true ? true : undefined,
    } satisfies BrewvaModelPresetSelectEntry;
  }

  if (type === "custom_message") {
    const customType = readOptionalString(entry.customType);
    if (!customType) {
      throw new Error(`invalid Pi session artifact ${sourcePath}: missing customType for ${id}`);
    }
    return {
      type: "custom_message",
      id,
      parentId,
      timestamp,
      customType,
      content: structuredClone(entry.content) as string | Array<{ type: string }>,
      details: structuredClone(entry.details),
      display: entry.display === true,
    };
  }

  if (type === "compaction") {
    const summary = typeof entry.summary === "string" ? entry.summary : "";
    const firstKeptEntryId = readOptionalString(entry.firstKeptEntryId);
    if (!firstKeptEntryId) {
      throw new Error(
        `invalid Pi session artifact ${sourcePath}: missing firstKeptEntryId for ${id}`,
      );
    }
    return {
      type: "compaction",
      id,
      parentId,
      timestamp,
      summary,
      firstKeptEntryId,
      tokensBefore: ensureNumber(entry.tokensBefore),
      details: structuredClone(entry.details),
      fromHook: entry.fromHook === true,
    } satisfies BrewvaCompactionEntry;
  }

  if (type === "branch_summary") {
    const fromId = readOptionalString(entry.fromId);
    const summary = typeof entry.summary === "string" ? entry.summary : "";
    if (!fromId) {
      throw new Error(`invalid Pi session artifact ${sourcePath}: missing fromId for ${id}`);
    }
    return {
      type: "branch_summary",
      id,
      parentId,
      timestamp,
      fromId,
      summary,
      details: structuredClone(entry.details),
      fromHook: entry.fromHook === true,
    } satisfies BrewvaBranchSummaryEntry;
  }

  warnings.push(`ignored unsupported Pi session entry type: ${type}`);
  return undefined;
}

function importLegacyPiSessionArtifact(sourcePath: string): ImportedLegacyPiSessionArtifact {
  const fileEntries = parseJsonLinesFile(sourcePath);
  const [headerCandidate, ...entryCandidates] = fileEntries;
  if (!isPiSessionHeader(headerCandidate)) {
    throw new Error(`invalid Pi session artifact ${sourcePath}: missing session header`);
  }

  const header = structuredClone(headerCandidate);
  const entryRecords = entryCandidates.map((candidate) => {
    if (!isRecord(candidate)) {
      throw new Error(`invalid Pi session artifact ${sourcePath}: entry must be an object`);
    }
    return structuredClone(candidate);
  });
  migratePiEntriesInPlace(sourcePath, header, entryRecords);

  const warnings: string[] = [];
  const entries = entryRecords
    .map((entry) => toImportedSessionEntry(sourcePath, entry, warnings))
    .filter((entry): entry is BrewvaSessionEntry => entry !== undefined);
  const byId = new Map<string, BrewvaSessionEntry>(entries.map((entry) => [entry.id, entry]));
  const leafId = entries[entries.length - 1]?.id ?? null;
  const context = buildManagedSessionContext(entries, leafId, byId);
  const stats = statSync(sourcePath);
  const updatedAt = entries.reduce((latest, entry) => {
    const timestamp = Date.parse(entry.timestamp);
    if (!Number.isFinite(timestamp)) {
      return latest;
    }
    return Math.max(latest, timestamp);
  }, Date.parse(header.timestamp));

  return {
    kind: "legacy_pi_jsonl",
    sourcePath,
    sessionId: header.id,
    workspaceRoot: header.cwd,
    createdAt: ensureTimestamp(header.timestamp, new Date(stats.birthtimeMs).toISOString()),
    updatedAt: new Date(Number.isFinite(updatedAt) ? updatedAt : stats.mtimeMs).toISOString(),
    entries,
    context,
    warnings,
  };
}

function readNativeBundleArtifact(sourcePath: string): BrewvaNativeSessionBundleArtifact {
  const manifest = assertSessionBundleManifest(JSON.parse(readFileSync(sourcePath, "utf8")));
  const bundleRoot = dirname(sourcePath);
  return {
    kind: "brewva_bundle",
    sourcePath,
    manifest,
    bundleRoot,
    resolvedPaths: buildResolvedPaths(bundleRoot, manifest),
  };
}

function mapImportedEntryId(
  originalId: string,
  idMap: ReadonlyMap<string, string>,
  fieldName: string,
): string {
  const mapped = idMap.get(originalId);
  if (!mapped) {
    throw new Error(
      `cannot replay imported session entries: unresolved ${fieldName} ${originalId}`,
    );
  }
  return mapped;
}

export function isLegacyPiSessionArtifactPath(path: string): boolean {
  const normalized = path.replace(/\\/g, "/").toLowerCase();
  return normalized.includes("/.pi/agent/sessions/") && normalized.endsWith(".jsonl");
}

export function assertSessionBundleManifest(input: unknown): BrewvaSessionBundleManifest {
  if (!isRecord(input)) {
    throw new Error("invalid session bundle manifest: expected object");
  }

  const record = input;
  const format = requireManifestString(record, "format");
  if (format !== "brewva.session.bundle.v1") {
    if (format.startsWith("pi.")) {
      throw new Error("legacy Pi session artifacts are not supported");
    }
    throw new Error(`invalid session bundle manifest: unsupported format ${format}`);
  }

  return {
    format: "brewva.session.bundle.v1",
    sessionId: requireManifestString(record, "sessionId"),
    workspaceRoot: requireManifestString(record, "workspaceRoot"),
    tapePath: requireManifestString(record, "tapePath"),
    checkpointPath: requireManifestString(record, "checkpointPath"),
    recoveryWalPath: requireManifestString(record, "recoveryWalPath"),
    projectionsDir: requireManifestString(record, "projectionsDir"),
    createdAt: requireManifestString(record, "createdAt"),
    updatedAt: requireManifestString(record, "updatedAt"),
  };
}

export function readSessionBundleArtifact(sourcePath: string): BrewvaSessionBundleArtifact {
  if (sourcePath.toLowerCase().endsWith(".jsonl")) {
    return importLegacyPiSessionArtifact(sourcePath);
  }
  return readNativeBundleArtifact(sourcePath);
}

export function replayImportedSessionEntries(
  store: ReplayableSessionStore,
  entries: readonly BrewvaSessionEntry[],
): Map<string, string> {
  const idMap = new Map<string, string>();
  store.resetLeaf();

  for (const entry of entries) {
    const parentId =
      entry.parentId === null ? null : mapImportedEntryId(entry.parentId, idMap, "parentId");
    if (parentId === null) {
      store.resetLeaf();
    } else {
      store.branch(parentId);
    }

    let nextId: string;
    switch (entry.type) {
      case "message":
        nextId = store.appendMessage(structuredClone(entry.message));
        break;
      case "thinking_level_change":
        nextId = store.appendThinkingLevelChange(entry.thinkingLevel);
        break;
      case "model_change":
        nextId = store.appendModelChange(entry.provider, entry.modelId);
        break;
      case "model_preset_select":
        nextId = store.appendModelPresetSelection({
          presetName: entry.presetName,
          previousPresetName: entry.previousPresetName,
          source: entry.source,
          roles: entry.roles,
          synthetic: entry.synthetic,
        });
        break;
      case "custom_message":
        nextId = store.appendCustomMessageEntry(
          entry.customType,
          structuredClone(entry.content),
          entry.display,
          structuredClone(entry.details),
        );
        break;
      case "compaction":
        nextId = store.appendCompaction(
          entry.summary,
          mapImportedEntryId(entry.firstKeptEntryId, idMap, "firstKeptEntryId"),
          entry.tokensBefore,
          structuredClone(entry.details),
          entry.fromHook,
        );
        break;
      case "branch_summary":
        nextId = store.appendBranchSummaryEntry(
          parentId,
          entry.fromId === "root" ? "root" : mapImportedEntryId(entry.fromId, idMap, "fromId"),
          entry.summary,
          structuredClone(entry.details),
          entry.fromHook,
        );
        break;
    }
    idMap.set(entry.id, nextId);
  }

  return idMap;
}
