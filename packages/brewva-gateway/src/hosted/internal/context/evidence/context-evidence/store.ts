import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import type {
  PromptStabilityState,
  ProviderCacheObservationState,
  TransientReductionState,
} from "@brewva/brewva-runtime";
import {
  CONTEXT_EVIDENCE_SAMPLE_SCHEMA,
  type ContextEvidenceArtifactRef,
  type ContextEvidenceSample,
  type ProviderCacheObservationEvidenceSample,
} from "./types.js";

const DEFAULT_CONTEXT_EVIDENCE_DIR = ".orchestrator/context-evidence";
const SESSION_FILE_PREFIX = "sess_";

const queuedSamplesByPath = new Map<string, ContextEvidenceSample[]>();
const flushingSamplesByPath = new Map<string, ContextEvidenceSample[]>();
const flushPromisesByPath = new Map<string, Promise<void>>();

function encodeSessionId(sessionId: string): string {
  return Buffer.from(sessionId, "utf8").toString("base64url");
}

export function normalizeRelativePath(value: string): string {
  return value.replaceAll("\\", "/");
}

export function resolveEvidenceDir(workspaceRoot: string): string {
  return resolve(workspaceRoot, DEFAULT_CONTEXT_EVIDENCE_DIR);
}

function resolveSessionEvidencePath(workspaceRoot: string, sessionId: string): string {
  return join(
    resolveEvidenceDir(workspaceRoot),
    `${SESSION_FILE_PREFIX}${encodeSessionId(sessionId)}.jsonl`,
  );
}

export function ensureParentDirectory(filePath: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
}

function toFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function toFiniteInteger(value: unknown): number | null {
  const numeric = toFiniteNumber(value);
  return numeric === null ? null : Math.trunc(numeric);
}

function toBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function toNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === "string");
}

function isProviderCacheStatus(
  value: unknown,
): value is ProviderCacheObservationEvidenceSample["status"] {
  return value === "cold" || value === "warm" || value === "break" || value === "limited";
}

function appendContextEvidenceSample(
  workspaceRoot: string,
  sample: ContextEvidenceSample,
): ContextEvidenceArtifactRef | null {
  try {
    const absolutePath = resolveSessionEvidencePath(workspaceRoot, sample.sessionId);
    const queued = queuedSamplesByPath.get(absolutePath) ?? [];
    queued.push(sample);
    queuedSamplesByPath.set(absolutePath, queued);
    scheduleContextEvidenceFlush(absolutePath);
    return {
      artifactRef: normalizeRelativePath(relative(workspaceRoot, absolutePath)),
      absolutePath,
    };
  } catch {
    return null;
  }
}

function scheduleContextEvidenceFlush(filePath: string): void {
  if (flushPromisesByPath.has(filePath)) {
    return;
  }
  const flushPromise = flushContextEvidencePath(filePath).finally(() => {
    flushPromisesByPath.delete(filePath);
    if ((queuedSamplesByPath.get(filePath)?.length ?? 0) > 0) {
      scheduleContextEvidenceFlush(filePath);
    }
  });
  flushPromisesByPath.set(filePath, flushPromise);
}

async function flushContextEvidencePath(filePath: string): Promise<void> {
  const queued = queuedSamplesByPath.get(filePath);
  if (!queued || queued.length === 0) {
    return;
  }

  queuedSamplesByPath.delete(filePath);
  flushingSamplesByPath.set(filePath, queued);
  try {
    await mkdir(dirname(filePath), { recursive: true });
    await appendFile(
      filePath,
      queued.map((sample) => `${JSON.stringify(sample)}\n`).join(""),
      "utf8",
    );
  } catch {
    // Best-effort sidecar telemetry must not block hosted request paths.
  } finally {
    flushingSamplesByPath.delete(filePath);
  }
}

export function recordPromptStabilityEvidence(input: {
  workspaceRoot: string;
  sessionId: string;
  observed: PromptStabilityState;
  compactionAdvised?: boolean;
  forcedCompaction?: boolean;
  usageRatio?: number | null;
  pendingCompactionReason?: string | null;
  gateRequired?: boolean;
}): ContextEvidenceArtifactRef | null {
  return appendContextEvidenceSample(input.workspaceRoot, {
    schema: CONTEXT_EVIDENCE_SAMPLE_SCHEMA,
    kind: "prompt_stability",
    sessionId: input.sessionId,
    turn: input.observed.turn,
    timestamp: input.observed.updatedAt,
    scopeKey: input.observed.scopeKey,
    stablePrefixHash: input.observed.stablePrefixHash,
    dynamicTailHash: input.observed.dynamicTailHash,
    stablePrefix: input.observed.stablePrefix,
    stableTail: input.observed.stableTail,
    compactionAdvised: input.compactionAdvised === true,
    forcedCompaction: input.forcedCompaction === true,
    usageRatio: input.usageRatio ?? null,
    pendingCompactionReason: input.pendingCompactionReason ?? null,
    gateRequired: input.gateRequired === true,
  });
}

export function recordTransientReductionEvidence(input: {
  workspaceRoot: string;
  sessionId: string;
  observed: TransientReductionState;
}): ContextEvidenceArtifactRef | null {
  return appendContextEvidenceSample(input.workspaceRoot, {
    schema: CONTEXT_EVIDENCE_SAMPLE_SCHEMA,
    kind: "transient_reduction",
    sessionId: input.sessionId,
    turn: input.observed.turn,
    timestamp: input.observed.updatedAt,
    status: input.observed.status,
    reason: input.observed.reason,
    eligibleToolResults: input.observed.eligibleToolResults,
    clearedToolResults: input.observed.clearedToolResults,
    clearedChars: input.observed.clearedChars,
    estimatedTokenSavings: input.observed.estimatedTokenSavings,
    compactionAdvised: input.observed.compactionAdvised,
    forcedCompaction: input.observed.forcedCompaction,
  });
}

export function recordProviderCacheObservationEvidence(input: {
  workspaceRoot: string;
  sessionId: string;
  observed: ProviderCacheObservationState;
}): ContextEvidenceArtifactRef | null {
  return appendContextEvidenceSample(input.workspaceRoot, {
    schema: CONTEXT_EVIDENCE_SAMPLE_SCHEMA,
    kind: "provider_cache_observation",
    sessionId: input.sessionId,
    turn: input.observed.turn,
    timestamp: input.observed.updatedAt,
    source: input.observed.source,
    status: input.observed.breakObservation.status,
    classification: input.observed.breakObservation.classification,
    expected: input.observed.breakObservation.expected,
    reason: input.observed.breakObservation.reason,
    cacheReadTokens: input.observed.breakObservation.cacheReadTokens,
    cacheWriteTokens: input.observed.breakObservation.cacheWriteTokens,
    cacheMissTokens: input.observed.breakObservation.cacheMissTokens,
    changedFields: [...input.observed.breakObservation.changedFields],
  });
}

function parseContextEvidenceSample(raw: unknown): ContextEvidenceSample | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const record = raw as Record<string, unknown>;
  if (record.schema !== CONTEXT_EVIDENCE_SAMPLE_SCHEMA) {
    return null;
  }
  const sessionId = toNonEmptyString(record.sessionId);
  const kind = record.kind;
  const turn = toFiniteInteger(record.turn);
  const timestamp = toFiniteInteger(record.timestamp);
  if (!sessionId || turn === null || timestamp === null) {
    return null;
  }

  if (kind === "prompt_stability") {
    const scopeKey = toNonEmptyString(record.scopeKey);
    const stablePrefixHash = toNonEmptyString(record.stablePrefixHash);
    const dynamicTailHash = toNonEmptyString(record.dynamicTailHash);
    const stablePrefix = toBoolean(record.stablePrefix);
    const stableTail = toBoolean(record.stableTail);
    const gateRequired = toBoolean(record.gateRequired);
    if (
      !scopeKey ||
      !stablePrefixHash ||
      !dynamicTailHash ||
      stablePrefix === null ||
      stableTail === null ||
      gateRequired === null
    ) {
      return null;
    }
    return {
      schema: CONTEXT_EVIDENCE_SAMPLE_SCHEMA,
      kind,
      sessionId,
      turn,
      timestamp,
      scopeKey,
      stablePrefixHash,
      dynamicTailHash,
      stablePrefix,
      stableTail,
      compactionAdvised: toBoolean(record.compactionAdvised) ?? false,
      forcedCompaction: toBoolean(record.forcedCompaction) ?? false,
      usageRatio: toFiniteNumber(record.usageRatio),
      pendingCompactionReason: toNonEmptyString(record.pendingCompactionReason),
      gateRequired,
    };
  }

  if (kind === "transient_reduction") {
    const status =
      record.status === "completed" || record.status === "skipped" ? record.status : null;
    if (status === null) {
      return null;
    }
    return {
      schema: CONTEXT_EVIDENCE_SAMPLE_SCHEMA,
      kind,
      sessionId,
      turn,
      timestamp,
      status,
      reason: toNonEmptyString(record.reason),
      eligibleToolResults: Math.max(0, toFiniteInteger(record.eligibleToolResults) ?? 0),
      clearedToolResults: Math.max(0, toFiniteInteger(record.clearedToolResults) ?? 0),
      clearedChars: Math.max(0, toFiniteInteger(record.clearedChars) ?? 0),
      estimatedTokenSavings: Math.max(0, toFiniteInteger(record.estimatedTokenSavings) ?? 0),
      compactionAdvised: toBoolean(record.compactionAdvised) ?? false,
      forcedCompaction: toBoolean(record.forcedCompaction) ?? false,
    };
  }

  if (kind === "provider_cache_observation") {
    const source = toNonEmptyString(record.source);
    const status = isProviderCacheStatus(record.status) ? record.status : null;
    const classification = toNonEmptyString(record.classification);
    const expected = toBoolean(record.expected);
    if (!source || status === null || !classification || expected === null) {
      return null;
    }
    return {
      schema: CONTEXT_EVIDENCE_SAMPLE_SCHEMA,
      kind,
      sessionId,
      turn,
      timestamp,
      source,
      status,
      classification,
      expected,
      reason: toNonEmptyString(record.reason),
      cacheReadTokens: Math.max(0, toFiniteInteger(record.cacheReadTokens) ?? 0),
      cacheWriteTokens: Math.max(0, toFiniteInteger(record.cacheWriteTokens) ?? 0),
      cacheMissTokens: Math.max(0, toFiniteInteger(record.cacheMissTokens) ?? 0),
      changedFields: toStringArray(record.changedFields),
    };
  }

  return null;
}

function listEvidenceFiles(workspaceRoot: string, sessionIds?: readonly string[]): string[] {
  const directory = resolveEvidenceDir(workspaceRoot);
  if (!existsSync(directory)) {
    if (sessionIds && sessionIds.length > 0) {
      return [...new Set(sessionIds)]
        .map((sessionId) => resolveSessionEvidencePath(workspaceRoot, sessionId))
        .filter((path) => queuedSamplesByPath.has(path) || flushingSamplesByPath.has(path));
    }
    return [...new Set([...queuedSamplesByPath.keys(), ...flushingSamplesByPath.keys()])]
      .filter((path) => dirname(path) === directory)
      .toSorted();
  }
  if (sessionIds && sessionIds.length > 0) {
    return [...new Set(sessionIds)]
      .map((sessionId) => resolveSessionEvidencePath(workspaceRoot, sessionId))
      .filter(
        (path) =>
          existsSync(path) || queuedSamplesByPath.has(path) || flushingSamplesByPath.has(path),
      );
  }
  return [
    ...new Set([
      ...readdirSync(directory)
        .filter((name) => name.startsWith(SESSION_FILE_PREFIX) && name.endsWith(".jsonl"))
        .map((name) => join(directory, name)),
      ...[...queuedSamplesByPath.keys()].filter((path) => dirname(path) === directory),
      ...[...flushingSamplesByPath.keys()].filter((path) => dirname(path) === directory),
    ]),
  ].toSorted();
}

export function readContextEvidenceSamples(input: {
  workspaceRoot: string;
  sessionIds?: readonly string[];
}): ContextEvidenceSample[] {
  const samples: ContextEvidenceSample[] = [];
  for (const path of listEvidenceFiles(input.workspaceRoot, input.sessionIds)) {
    if (existsSync(path)) {
      const lines = readFileSync(path, "utf8")
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      for (const line of lines) {
        try {
          const parsed = parseContextEvidenceSample(JSON.parse(line));
          if (parsed) {
            samples.push(parsed);
          }
        } catch {
          continue;
        }
      }
    }
    for (const sample of flushingSamplesByPath.get(path) ?? []) {
      samples.push(sample);
    }
    for (const sample of queuedSamplesByPath.get(path) ?? []) {
      samples.push(sample);
    }
  }
  return samples.toSorted((left, right) => {
    if (left.sessionId !== right.sessionId) {
      return left.sessionId.localeCompare(right.sessionId);
    }
    if (left.turn !== right.turn) {
      return left.turn - right.turn;
    }
    return left.timestamp - right.timestamp;
  });
}

export const readContextEvidenceRecords = readContextEvidenceSamples;
