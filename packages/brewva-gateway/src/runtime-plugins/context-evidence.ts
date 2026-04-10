import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import type {
  BrewvaHostedRuntimePort,
  BrewvaRuntime,
  ContextPressureLevel,
  PromptStabilityState,
  TransientReductionState,
} from "@brewva/brewva-runtime";

const DEFAULT_CONTEXT_EVIDENCE_DIR = ".orchestrator/context-evidence";
const SESSION_FILE_PREFIX = "sess_";
const REPORT_FILE_NAME = "report-latest.json";
const CONTEXT_EVIDENCE_SAMPLE_SCHEMA = "brewva.context_evidence.sample.v1";
const CONTEXT_EVIDENCE_REPORT_SCHEMA = "brewva.context_evidence.report.v1";
const queuedSamplesByPath = new Map<string, ContextEvidenceSample[]>();
const flushingSamplesByPath = new Map<string, ContextEvidenceSample[]>();
const flushPromisesByPath = new Map<string, Promise<void>>();

function encodeSessionId(sessionId: string): string {
  return Buffer.from(sessionId, "utf8").toString("base64url");
}

function normalizeRelativePath(value: string): string {
  return value.replaceAll("\\", "/");
}

function resolveEvidenceDir(workspaceRoot: string): string {
  return resolve(workspaceRoot, DEFAULT_CONTEXT_EVIDENCE_DIR);
}

function resolveSessionEvidencePath(workspaceRoot: string, sessionId: string): string {
  return join(
    resolveEvidenceDir(workspaceRoot),
    `${SESSION_FILE_PREFIX}${encodeSessionId(sessionId)}.jsonl`,
  );
}

function ensureParentDirectory(filePath: string): void {
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

function toContextPressureLevel(value: unknown): ContextPressureLevel | "unknown" {
  switch (value) {
    case "none":
    case "low":
    case "medium":
    case "high":
    case "critical":
    case "unknown":
      return value;
    default:
      return "unknown";
  }
}

export interface PromptStabilityEvidenceSample {
  schema: typeof CONTEXT_EVIDENCE_SAMPLE_SCHEMA;
  kind: "prompt_stability";
  sessionId: string;
  turn: number;
  timestamp: number;
  scopeKey: string;
  stablePrefixHash: string;
  dynamicTailHash: string;
  stablePrefix: boolean;
  stableTail: boolean;
  pressureLevel: ContextPressureLevel | "unknown";
  usageRatio: number | null;
  pendingCompactionReason: string | null;
  gateRequired: boolean;
}

export interface TransientReductionEvidenceSample {
  schema: typeof CONTEXT_EVIDENCE_SAMPLE_SCHEMA;
  kind: "transient_reduction";
  sessionId: string;
  turn: number;
  timestamp: number;
  status: "completed" | "skipped";
  reason: string | null;
  eligibleToolResults: number;
  clearedToolResults: number;
  clearedChars: number;
  estimatedTokenSavings: number;
  pressureLevel: ContextPressureLevel | "unknown";
}

export type ContextEvidenceSample =
  | PromptStabilityEvidenceSample
  | TransientReductionEvidenceSample;

export interface ContextEvidenceArtifactRef {
  artifactRef: string;
  absolutePath: string;
}

export interface ContextEvidenceSessionReport {
  sessionId: string;
  promptObservedTurns: number;
  stablePrefixTurns: number;
  stablePrefixRate: number | null;
  dynamicTailStableTurns: number;
  dynamicTailStableRate: number | null;
  latestScopeKey: string | null;
  reductionObservedTurns: number;
  reductionCompletedTurns: number;
  reductionSkippedTurns: number;
  totalClearedToolResults: number;
  totalClearedChars: number;
  totalEstimatedTokenSavings: number;
  latestReductionStatus: "completed" | "skipped" | null;
  latestReductionReason: string | null;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cacheReadReported: boolean;
  cacheWriteReported: boolean;
  cacheAccountingObserved: boolean;
  compactionEvents: number;
  firstCompactionTurn: number | null;
  completedReductionTurnsBeforeFirstCompaction: number;
  highPressurePromptTurns: number;
  highPressureReductionTurns: number;
}

export interface ContextEvidenceAggregateReport {
  sessionsObserved: number;
  promptObservedTurns: number;
  stablePrefixTurns: number;
  stablePrefixRate: number | null;
  dynamicTailStableTurns: number;
  dynamicTailStableRate: number | null;
  reductionObservedTurns: number;
  reductionCompletedTurns: number;
  reductionSkippedTurns: number;
  totalClearedToolResults: number;
  totalClearedChars: number;
  totalEstimatedTokenSavings: number;
  totalCacheReadTokens: number;
  totalCacheWriteTokens: number;
  sessionsWithReportedCacheRead: number;
  sessionsWithReportedCacheWrite: number;
  sessionsWithObservedCacheAccounting: number;
  totalCompactionEvents: number;
  sessionsMeetingStablePrefixTarget: number;
  sessionsWithCompletedReduction: number;
  sessionsWithReductionBeforeCompaction: number;
  sessionsWithCompletedReductionAndNoCompaction: number;
}

export interface ContextEvidencePromotionReadiness {
  stablePrefixTargetMet: boolean;
  reductionEvidenceObserved: boolean;
  cacheAccountingObserved: boolean;
  ready: boolean;
  gaps: string[];
}

export interface ContextEvidenceReport {
  schema: typeof CONTEXT_EVIDENCE_REPORT_SCHEMA;
  generatedAt: string;
  workspaceRoot: string;
  sessionIds: string[];
  aggregate: ContextEvidenceAggregateReport;
  promotionReadiness: ContextEvidencePromotionReadiness;
  sessions: ContextEvidenceSessionReport[];
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
  pressureLevel?: ContextPressureLevel | "unknown";
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
    pressureLevel: input.pressureLevel ?? "unknown",
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
    pressureLevel: input.observed.pressureLevel,
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
      pressureLevel: toContextPressureLevel(record.pressureLevel),
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
      pressureLevel: toContextPressureLevel(record.pressureLevel),
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

function ratio(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}

function extractReportedCacheFieldFlags(payload: unknown): {
  cacheReadReported: boolean;
  cacheWriteReported: boolean;
} {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return {
      cacheReadReported: false,
      cacheWriteReported: false,
    };
  }

  const usage = (payload as { usage?: unknown }).usage;
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) {
    return {
      cacheReadReported: false,
      cacheWriteReported: false,
    };
  }

  const record = usage as {
    cacheReadReported?: unknown;
    cacheWriteReported?: unknown;
  };
  return {
    cacheReadReported: record.cacheReadReported === true,
    cacheWriteReported: record.cacheWriteReported === true,
  };
}

function countScopeAwareStablePrefixTurns(
  promptSamples: readonly PromptStabilityEvidenceSample[],
): number {
  let previous: PromptStabilityEvidenceSample | undefined;
  let stableTurns = 0;

  for (const sample of promptSamples) {
    const seedsNewScope = previous === undefined || previous.scopeKey !== sample.scopeKey;
    if (seedsNewScope || sample.stablePrefix) {
      stableTurns += 1;
    }
    previous = sample;
  }

  return stableTurns;
}

export function buildContextEvidenceReport(
  runtime: Pick<BrewvaRuntime | BrewvaHostedRuntimePort, "workspaceRoot" | "inspect">,
  options: { sessionIds?: readonly string[] } = {},
): ContextEvidenceReport {
  const samples = readContextEvidenceSamples({
    workspaceRoot: runtime.workspaceRoot,
    sessionIds: options.sessionIds,
  });
  const sessionIdSet = new Set<string>(options.sessionIds ?? []);
  if (!options.sessionIds || options.sessionIds.length === 0) {
    for (const sessionId of runtime.inspect.events.listSessionIds()) {
      sessionIdSet.add(sessionId);
    }
    for (const sample of samples) {
      sessionIdSet.add(sample.sessionId);
    }
  }

  const sessions = [...sessionIdSet]
    .toSorted()
    .map((sessionId): ContextEvidenceSessionReport => {
      const promptSamples = samples.filter(
        (sample): sample is PromptStabilityEvidenceSample =>
          sample.sessionId === sessionId && sample.kind === "prompt_stability",
      );
      const reductionSamples = samples.filter(
        (sample): sample is TransientReductionEvidenceSample =>
          sample.sessionId === sessionId && sample.kind === "transient_reduction",
      );
      const latestPrompt = promptSamples.at(-1) ?? null;
      const latestReduction = reductionSamples.at(-1) ?? null;
      const compactionEvents = runtime.inspect.events.query(sessionId, { type: "session_compact" });
      const messageEndEvents = runtime.inspect.events.query(sessionId, { type: "message_end" });
      const firstCompactionTurn =
        compactionEvents
          .map((event) => (typeof event.turn === "number" ? event.turn : null))
          .filter((turn): turn is number => turn !== null)
          .toSorted((left, right) => left - right)[0] ?? null;
      const cost = runtime.inspect.cost.getSummary(sessionId);
      const cacheReadReported = messageEndEvents.some(
        (event) => extractReportedCacheFieldFlags(event.payload).cacheReadReported,
      );
      const cacheWriteReported = messageEndEvents.some(
        (event) => extractReportedCacheFieldFlags(event.payload).cacheWriteReported,
      );
      const cacheAccountingObserved =
        (cacheReadReported || cacheWriteReported) &&
        (cost.cacheReadTokens > 0 || cost.cacheWriteTokens > 0);
      const stablePrefixTurns = countScopeAwareStablePrefixTurns(promptSamples);
      const dynamicTailStableTurns = promptSamples.filter((sample) => sample.stableTail).length;
      const reductionCompletedTurns = reductionSamples.filter(
        (sample) => sample.status === "completed",
      ).length;
      const reductionSkippedTurns = reductionSamples.filter(
        (sample) => sample.status === "skipped",
      ).length;
      const totalClearedToolResults = reductionSamples.reduce(
        (sum, sample) => sum + sample.clearedToolResults,
        0,
      );
      const totalClearedChars = reductionSamples.reduce(
        (sum, sample) => sum + sample.clearedChars,
        0,
      );
      const totalEstimatedTokenSavings = reductionSamples.reduce(
        (sum, sample) => sum + sample.estimatedTokenSavings,
        0,
      );
      const completedReductionTurnsBeforeFirstCompaction = reductionSamples.filter(
        (sample) =>
          sample.status === "completed" &&
          firstCompactionTurn !== null &&
          sample.turn < firstCompactionTurn,
      ).length;
      const highPressurePromptTurns = promptSamples.filter(
        (sample) => sample.pressureLevel === "high",
      ).length;
      const highPressureReductionTurns = reductionSamples.filter(
        (sample) => sample.status === "completed" && sample.pressureLevel === "high",
      ).length;

      return {
        sessionId,
        promptObservedTurns: promptSamples.length,
        stablePrefixTurns,
        stablePrefixRate: ratio(stablePrefixTurns, promptSamples.length),
        dynamicTailStableTurns,
        dynamicTailStableRate: ratio(dynamicTailStableTurns, promptSamples.length),
        latestScopeKey: latestPrompt?.scopeKey ?? null,
        reductionObservedTurns: reductionSamples.length,
        reductionCompletedTurns,
        reductionSkippedTurns,
        totalClearedToolResults,
        totalClearedChars,
        totalEstimatedTokenSavings,
        latestReductionStatus: latestReduction?.status ?? null,
        latestReductionReason: latestReduction?.reason ?? null,
        cacheReadTokens: cost.cacheReadTokens,
        cacheWriteTokens: cost.cacheWriteTokens,
        cacheReadReported,
        cacheWriteReported,
        cacheAccountingObserved,
        compactionEvents: compactionEvents.length,
        firstCompactionTurn,
        completedReductionTurnsBeforeFirstCompaction,
        highPressurePromptTurns,
        highPressureReductionTurns,
      };
    })
    .filter(
      (session) =>
        session.promptObservedTurns > 0 ||
        session.reductionObservedTurns > 0 ||
        session.compactionEvents > 0 ||
        session.cacheReadReported ||
        session.cacheWriteReported ||
        session.cacheReadTokens > 0 ||
        session.cacheWriteTokens > 0,
    );

  const aggregate: ContextEvidenceAggregateReport = {
    sessionsObserved: sessions.length,
    promptObservedTurns: sessions.reduce((sum, session) => sum + session.promptObservedTurns, 0),
    stablePrefixTurns: sessions.reduce((sum, session) => sum + session.stablePrefixTurns, 0),
    stablePrefixRate: null,
    dynamicTailStableTurns: sessions.reduce(
      (sum, session) => sum + session.dynamicTailStableTurns,
      0,
    ),
    dynamicTailStableRate: null,
    reductionObservedTurns: sessions.reduce(
      (sum, session) => sum + session.reductionObservedTurns,
      0,
    ),
    reductionCompletedTurns: sessions.reduce(
      (sum, session) => sum + session.reductionCompletedTurns,
      0,
    ),
    reductionSkippedTurns: sessions.reduce(
      (sum, session) => sum + session.reductionSkippedTurns,
      0,
    ),
    totalClearedToolResults: sessions.reduce(
      (sum, session) => sum + session.totalClearedToolResults,
      0,
    ),
    totalClearedChars: sessions.reduce((sum, session) => sum + session.totalClearedChars, 0),
    totalEstimatedTokenSavings: sessions.reduce(
      (sum, session) => sum + session.totalEstimatedTokenSavings,
      0,
    ),
    totalCacheReadTokens: sessions.reduce((sum, session) => sum + session.cacheReadTokens, 0),
    totalCacheWriteTokens: sessions.reduce((sum, session) => sum + session.cacheWriteTokens, 0),
    sessionsWithReportedCacheRead: sessions.filter((session) => session.cacheReadReported).length,
    sessionsWithReportedCacheWrite: sessions.filter((session) => session.cacheWriteReported).length,
    sessionsWithObservedCacheAccounting: sessions.filter(
      (session) => session.cacheAccountingObserved,
    ).length,
    totalCompactionEvents: sessions.reduce((sum, session) => sum + session.compactionEvents, 0),
    sessionsMeetingStablePrefixTarget: sessions.filter(
      (session) => (session.stablePrefixRate ?? 0) >= 0.95,
    ).length,
    sessionsWithCompletedReduction: sessions.filter(
      (session) => session.reductionCompletedTurns > 0,
    ).length,
    sessionsWithReductionBeforeCompaction: sessions.filter(
      (session) => session.completedReductionTurnsBeforeFirstCompaction > 0,
    ).length,
    sessionsWithCompletedReductionAndNoCompaction: sessions.filter(
      (session) => session.reductionCompletedTurns > 0 && session.compactionEvents === 0,
    ).length,
  };
  aggregate.stablePrefixRate = ratio(aggregate.stablePrefixTurns, aggregate.promptObservedTurns);
  aggregate.dynamicTailStableRate = ratio(
    aggregate.dynamicTailStableTurns,
    aggregate.promptObservedTurns,
  );

  const promotionReadiness: ContextEvidencePromotionReadiness = {
    stablePrefixTargetMet: (aggregate.stablePrefixRate ?? 0) >= 0.95,
    reductionEvidenceObserved:
      aggregate.reductionCompletedTurns > 0 &&
      aggregate.totalEstimatedTokenSavings > 0 &&
      (aggregate.sessionsWithReductionBeforeCompaction > 0 ||
        aggregate.sessionsWithCompletedReductionAndNoCompaction > 0),
    cacheAccountingObserved: aggregate.sessionsWithObservedCacheAccounting > 0,
    ready: false,
    gaps: [],
  };
  if (!promotionReadiness.stablePrefixTargetMet) {
    promotionReadiness.gaps.push("stable_prefix_below_target");
  }
  if (!promotionReadiness.reductionEvidenceObserved) {
    promotionReadiness.gaps.push("transient_reduction_deferral_evidence_missing");
  }
  if (!promotionReadiness.cacheAccountingObserved) {
    promotionReadiness.gaps.push("cache_accounting_missing");
  }
  promotionReadiness.ready = promotionReadiness.gaps.length === 0;

  return {
    schema: CONTEXT_EVIDENCE_REPORT_SCHEMA,
    generatedAt: new Date().toISOString(),
    workspaceRoot: runtime.workspaceRoot,
    sessionIds: sessions.map((session) => session.sessionId),
    aggregate,
    promotionReadiness,
    sessions,
  };
}

export function persistContextEvidenceReport(input: {
  workspaceRoot: string;
  report: ContextEvidenceReport;
}): ContextEvidenceArtifactRef {
  const absolutePath = resolve(resolveEvidenceDir(input.workspaceRoot), REPORT_FILE_NAME);
  ensureParentDirectory(absolutePath);
  writeFileSync(absolutePath, `${JSON.stringify(input.report, null, 2)}\n`, "utf8");
  return {
    artifactRef: normalizeRelativePath(relative(input.workspaceRoot, absolutePath)),
    absolutePath,
  };
}
