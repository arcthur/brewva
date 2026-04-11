import { realpathSync } from "node:fs";
import { isAbsolute, posix, relative, resolve } from "node:path";
import {
  PATCH_RECORDED_EVENT_TYPE,
  TOOL_READ_PATH_DISCOVERY_OBSERVED_EVENT_TYPE,
  TOOL_READ_PATH_GATE_ARMED_EVENT_TYPE,
} from "@brewva/brewva-runtime";
import { LRUCache } from "lru-cache";
import {
  registerToolRuntimeClearStateListener,
  resolveToolRuntimeEventPort,
} from "./runtime-internal.js";
import type { BrewvaToolRuntime } from "./types.js";

const MAX_SIGNAL_FILES = 256;
const MAX_SIGNAL_DIRECTORIES = 128;
const MAX_QUERY_COMBOS = 128;
const MAX_RECENT_INTENTS = 24;
const MAX_PROCESSED_EVENTS = 512;
const PATH_HALF_LIFE_MS = 20 * 60 * 1000;
const COMBO_HALF_LIFE_MS = 30 * 60 * 1000;
const FOLLOWTHROUGH_WINDOW_MS = 10 * 60 * 1000;
const IDENTICAL_SIGNAL_COOLDOWN_MS = 5 * 1000;
const COMBO_THRESHOLD = 3;
const MIN_DELIMITER_FALLBACK_LENGTH = 3;
const SIGNAL_EPSILON = 0.01;

const OBSERVED_PATH_WEIGHT = 3;
const OBSERVED_DIRECTORY_WEIGHT = 1;
const PATCHED_FILE_WEIGHT = 6;
const FAILED_READ_DIRECTORY_WEIGHT = 2;

type SearchToolName = "grep" | "toc_search";
type SignalSourceKind =
  | "observed_path"
  | "observed_directory"
  | "patched_file"
  | "failed_read_directory";

interface ScoreEntry {
  score: number;
  updatedAt: number;
}

interface QueryComboState extends ScoreEntry {
  filePath: string;
  hitCount: number;
}

interface RecentSearchIntent {
  toolName: SearchToolName;
  normalizedQuery: string;
  queryKey: string;
  issuedAt: number;
  requestedPaths: string[];
  previewPaths: string[];
  previewDirectories: string[];
  confirmedAt?: number;
}

interface SessionSearchAdvisorState {
  fileSignals: LRUCache<string, ScoreEntry>;
  directorySignals: LRUCache<string, ScoreEntry>;
  queryCombos: LRUCache<string, QueryComboState>;
  recentSearchIntents: RecentSearchIntent[];
  lastFoldTimestamp: number;
  processedEventIds: LRUCache<string, true>;
  lastContributionAt: Map<string, number>;
}

interface NormalizedEventRecord {
  id: string;
  type: string;
  timestamp: number;
  payload?: Record<string, unknown>;
}

export interface SearchAdvisorFileScore {
  pathScore: number;
  comboBias: number;
  comboHits: number;
  comboStrength: number;
  comboThresholdHit: boolean;
  totalScore: number;
}

export interface SearchAdvisorSnapshot {
  advisorEnabled: boolean;
  signalFiles: number;
  queryCombos: number;
  hotFiles: string[];
  scoreFile(input: {
    toolName: SearchToolName;
    query: string;
    filePath: string;
  }): SearchAdvisorFileScore;
  getComboMatch(input: { toolName: SearchToolName; query: string }): QueryComboState | undefined;
}

const sessionStates = new Map<string, SessionSearchAdvisorState>();
const attachedRuntimes = new WeakMap<object, number>();
let attachmentEpoch = 0;

function decayScore(score: number, ageMs: number, halfLifeMs: number): number {
  if (score <= 0) return 0;
  if (ageMs <= 0) return score;
  return score * Math.pow(0.5, ageMs / halfLifeMs);
}

function createSessionState(): SessionSearchAdvisorState {
  return {
    fileSignals: new LRUCache({
      max: MAX_SIGNAL_FILES,
    }),
    directorySignals: new LRUCache({
      max: MAX_SIGNAL_DIRECTORIES,
    }),
    queryCombos: new LRUCache({
      max: MAX_QUERY_COMBOS,
    }),
    recentSearchIntents: [],
    lastFoldTimestamp: 0,
    processedEventIds: new LRUCache({
      max: MAX_PROCESSED_EVENTS,
    }),
    lastContributionAt: new Map(),
  };
}

function getSessionState(sessionId: string): SessionSearchAdvisorState {
  const existing = sessionStates.get(sessionId);
  if (existing) return existing;
  const next = createSessionState();
  sessionStates.set(sessionId, next);
  return next;
}

function trimSessionState(state: SessionSearchAdvisorState, now: number): void {
  pruneDecayedEntries(state.fileSignals, now, PATH_HALF_LIFE_MS);
  pruneDecayedEntries(state.directorySignals, now, PATH_HALF_LIFE_MS);
  pruneDecayedEntries(state.queryCombos, now, COMBO_HALF_LIFE_MS);
  state.recentSearchIntents = state.recentSearchIntents
    .filter((intent) => now - intent.issuedAt <= FOLLOWTHROUGH_WINDOW_MS)
    .slice(-MAX_RECENT_INTENTS);

  for (const [key, timestamp] of state.lastContributionAt) {
    if (now - timestamp > FOLLOWTHROUGH_WINDOW_MS) {
      state.lastContributionAt.delete(key);
    }
  }
}

function pruneDecayedEntries<T extends ScoreEntry>(
  cache: LRUCache<string, T>,
  now: number,
  halfLifeMs: number,
): void {
  for (const [key, entry] of cache.entries()) {
    if (decayScore(entry.score, now - entry.updatedAt, halfLifeMs) < SIGNAL_EPSILON) {
      cache.delete(key);
    }
  }
}

function normalizeSessionId(sessionId: string | undefined): string | undefined {
  const normalized = sessionId?.trim();
  return normalized ? normalized : undefined;
}

function normalizeSignalPath(path: string): string {
  const normalized = path
    .trim()
    .replaceAll("\\", "/")
    .replace(/^\.\/+/u, "");
  return normalized.length === 0 ? "." : normalized;
}

export function normalizeSearchAdvisorPath(baseCwd: string, candidate: string): string | undefined {
  const trimmed = candidate.trim();
  if (!trimmed) {
    return undefined;
  }
  const resolvedBase = resolve(baseCwd);
  let normalizedBase = resolvedBase;
  try {
    normalizedBase = realpathSync.native(normalizedBase);
  } catch {
    // ignore
  }
  const absolutePath = isAbsolute(trimmed) ? resolve(trimmed) : resolve(normalizedBase, trimmed);
  let normalizedAbsolute = absolutePath;
  try {
    normalizedAbsolute = realpathSync.native(normalizedAbsolute);
  } catch {
    if (absolutePath === resolvedBase || absolutePath.startsWith(`${resolvedBase}/`)) {
      normalizedAbsolute = `${normalizedBase}${absolutePath.slice(resolvedBase.length)}`;
    }
  }
  const relativePath = relative(normalizedBase, normalizedAbsolute).replaceAll("\\", "/");
  if (relativePath.startsWith("../") || relativePath === "..") {
    return undefined;
  }
  if (relativePath.length === 0) {
    return ".";
  }
  return normalizeSignalPath(relativePath);
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const output: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const normalized = normalizeSignalPath(entry);
    if (!output.includes(normalized)) {
      output.push(normalized);
    }
  }
  return output;
}

function normalizePayloadRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function normalizeEventRecord(value: unknown): NormalizedEventRecord | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const type = typeof record.type === "string" ? record.type : undefined;
  const timestamp = typeof record.timestamp === "number" ? record.timestamp : undefined;
  if (!type || !timestamp) {
    return undefined;
  }
  const id =
    typeof record.id === "string" && record.id.length > 0
      ? record.id
      : `${type}:${timestamp}:${JSON.stringify(record.payload ?? null)}`;
  return {
    id,
    type,
    timestamp,
    payload: normalizePayloadRecord(record.payload),
  };
}

function queryRelevantEvents(
  eventPort: NonNullable<ReturnType<typeof resolveToolRuntimeEventPort>>,
  sessionId: string,
  after?: number,
): NormalizedEventRecord[] {
  return [
    ...(eventPort.query?.(sessionId, {
      type: TOOL_READ_PATH_DISCOVERY_OBSERVED_EVENT_TYPE,
      ...(typeof after === "number" ? { after } : {}),
    }) ?? []),
    ...(eventPort.query?.(sessionId, {
      type: PATCH_RECORDED_EVENT_TYPE,
      ...(typeof after === "number" ? { after } : {}),
    }) ?? []),
    ...(eventPort.query?.(sessionId, {
      type: TOOL_READ_PATH_GATE_ARMED_EVENT_TYPE,
      ...(typeof after === "number" ? { after } : {}),
    }) ?? []),
  ]
    .map((event) => normalizeEventRecord(event))
    .filter((event): event is NormalizedEventRecord => Boolean(event))
    .toSorted((left, right) => {
      if (left.timestamp !== right.timestamp) return left.timestamp - right.timestamp;
      return left.id.localeCompare(right.id);
    });
}

function attachRuntime(runtime: BrewvaToolRuntime | undefined): void {
  if (!runtime) {
    return;
  }
  const runtimeKey = runtime as object;
  if (attachedRuntimes.get(runtimeKey) === attachmentEpoch) {
    return;
  }
  registerToolRuntimeClearStateListener(runtime, (sessionId) => {
    const normalizedSessionId = normalizeSessionId(sessionId);
    if (!normalizedSessionId) {
      return;
    }
    const resetState = createSessionState();
    const eventPort = resolveToolRuntimeEventPort(runtime);
    const historicalEvents = eventPort?.query
      ? queryRelevantEvents(eventPort, normalizedSessionId)
      : [];
    let maxObservedTimestamp = 0;
    for (const event of historicalEvents) {
      resetState.processedEventIds.set(event.id, true);
      maxObservedTimestamp = Math.max(maxObservedTimestamp, event.timestamp);
    }
    if (maxObservedTimestamp > 0) {
      resetState.lastFoldTimestamp = maxObservedTimestamp + 1;
    }
    sessionStates.set(normalizedSessionId, resetState);
  });
  attachedRuntimes.set(runtimeKey, attachmentEpoch);
}

export function normalizeSearchAdvisorQuery(query: string): string {
  return query.trim().toLowerCase().replace(/\s+/gu, " ");
}

function buildQueryKey(toolName: SearchToolName, query: string): string | undefined {
  const normalizedQuery = normalizeSearchAdvisorQuery(query);
  if (!normalizedQuery) return undefined;
  return `${toolName}:${normalizedQuery}`;
}

function isWithinCooldown(
  state: SessionSearchAdvisorState,
  key: string,
  now: number,
  cooldownMs: number,
): boolean {
  const last = state.lastContributionAt.get(key);
  if (typeof last === "number" && now - last < cooldownMs) {
    return true;
  }
  state.lastContributionAt.set(key, now);
  return false;
}

function applyScoreContribution(
  cache: LRUCache<string, ScoreEntry>,
  key: string,
  weight: number,
  now: number,
  halfLifeMs: number,
): void {
  const current = cache.get(key);
  if (!current) {
    cache.set(key, {
      score: weight,
      updatedAt: now,
    });
    return;
  }
  current.score = decayScore(current.score, now - current.updatedAt, halfLifeMs) + weight;
  current.updatedAt = now;
  cache.set(key, current);
}

function applyPathSignal(
  state: SessionSearchAdvisorState,
  source: SignalSourceKind,
  path: string,
  weight: number,
  now: number,
): void {
  const normalizedPath = normalizeSignalPath(path);
  if (isWithinCooldown(state, `${source}:${normalizedPath}`, now, IDENTICAL_SIGNAL_COOLDOWN_MS)) {
    return;
  }
  applyScoreContribution(state.fileSignals, normalizedPath, weight, now, PATH_HALF_LIFE_MS);
}

function buildAncestorDirectories(path: string): string[] {
  const normalized = normalizeSignalPath(path);
  const output: string[] = [];
  const rooted = normalized.startsWith("/");
  let current = posix.dirname(normalized);
  if (current === "") current = rooted ? "/" : ".";
  while (true) {
    if (!output.includes(current)) {
      output.push(current);
    }
    if ((!rooted && current === ".") || (rooted && current === "/")) break;
    const next = posix.dirname(current);
    if (next === current) {
      break;
    }
    current = next === "" ? (rooted ? "/" : ".") : next;
  }
  return output;
}

function applyDirectorySignal(
  state: SessionSearchAdvisorState,
  source: SignalSourceKind,
  directory: string,
  weight: number,
  now: number,
): void {
  const normalizedDirectory = normalizeSignalPath(directory);
  if (
    isWithinCooldown(state, `${source}:${normalizedDirectory}`, now, IDENTICAL_SIGNAL_COOLDOWN_MS)
  ) {
    return;
  }
  applyScoreContribution(
    state.directorySignals,
    normalizedDirectory,
    weight,
    now,
    PATH_HALF_LIFE_MS,
  );
}

function getPathScore(state: SessionSearchAdvisorState, filePath: string, now: number): number {
  const normalizedPath = normalizeSignalPath(filePath);
  const fileScore = decayScore(
    state.fileSignals.get(normalizedPath)?.score ?? 0,
    now - (state.fileSignals.get(normalizedPath)?.updatedAt ?? now),
    PATH_HALF_LIFE_MS,
  );
  let directoryScore = 0;
  for (const directory of buildAncestorDirectories(normalizedPath)) {
    const entry = state.directorySignals.get(directory);
    if (!entry) continue;
    directoryScore = Math.max(
      directoryScore,
      decayScore(entry.score, now - entry.updatedAt, PATH_HALF_LIFE_MS),
    );
  }
  return fileScore + directoryScore;
}

function doesPreviewMatchPath(intent: RecentSearchIntent, path: string): boolean {
  const normalizedPath = normalizeSignalPath(path);
  if (intent.previewPaths.includes(normalizedPath)) {
    return true;
  }
  return intent.previewDirectories.some((directory) => {
    return (
      normalizedPath === directory ||
      (directory !== "." && normalizedPath.startsWith(`${directory}/`))
    );
  });
}

function applyComboConfirmation(
  state: SessionSearchAdvisorState,
  intent: RecentSearchIntent,
  filePath: string,
  now: number,
): void {
  if (intent.confirmedAt) {
    return;
  }
  if (
    isWithinCooldown(
      state,
      `combo:${intent.queryKey}:${filePath}`,
      now,
      IDENTICAL_SIGNAL_COOLDOWN_MS,
    )
  ) {
    return;
  }
  const existing = state.queryCombos.get(intent.queryKey);
  const normalizedPath = normalizeSignalPath(filePath);
  if (!existing || existing.filePath !== normalizedPath) {
    state.queryCombos.set(intent.queryKey, {
      filePath: normalizedPath,
      hitCount: 1,
      score: 1,
      updatedAt: now,
    });
    intent.confirmedAt = now;
    return;
  }
  existing.score = decayScore(existing.score, now - existing.updatedAt, COMBO_HALF_LIFE_MS) + 1;
  existing.updatedAt = now;
  existing.hitCount += 1;
  state.queryCombos.set(intent.queryKey, existing);
  intent.confirmedAt = now;
}

function attributeFollowthrough(
  state: SessionSearchAdvisorState,
  path: string,
  timestamp: number,
): void {
  const normalizedPath = normalizeSignalPath(path);
  for (let index = state.recentSearchIntents.length - 1; index >= 0; index -= 1) {
    const intent = state.recentSearchIntents[index];
    if (!intent) continue;
    if (intent.confirmedAt) continue;
    if (timestamp < intent.issuedAt) continue;
    if (timestamp - intent.issuedAt > FOLLOWTHROUGH_WINDOW_MS) continue;
    if (!doesPreviewMatchPath(intent, normalizedPath)) continue;
    applyComboConfirmation(state, intent, normalizedPath, timestamp);
    break;
  }
}

function foldDiscoveryObservedEvent(
  state: SessionSearchAdvisorState,
  payload: Record<string, unknown>,
  timestamp: number,
): void {
  const toolName = typeof payload.toolName === "string" ? payload.toolName : undefined;
  const observedPaths = normalizeStringArray(payload.observedPaths);
  const observedDirectories = normalizeStringArray(payload.observedDirectories);
  for (const path of observedPaths) {
    applyPathSignal(state, "observed_path", path, OBSERVED_PATH_WEIGHT, timestamp);
    if (toolName !== "grep" && toolName !== "toc_search") {
      attributeFollowthrough(state, path, timestamp);
    }
  }
  for (const directory of observedDirectories) {
    applyDirectorySignal(
      state,
      "observed_directory",
      directory,
      OBSERVED_DIRECTORY_WEIGHT,
      timestamp,
    );
  }
}

function foldPatchRecordedEvent(
  state: SessionSearchAdvisorState,
  payload: Record<string, unknown>,
  timestamp: number,
): void {
  const failedPaths = new Set(normalizeStringArray(payload.failedPaths));
  const changes = Array.isArray(payload.changes) ? payload.changes : [];
  for (const change of changes) {
    const record = normalizePayloadRecord(change);
    const path = typeof record?.path === "string" ? normalizeSignalPath(record.path) : undefined;
    if (!path || failedPaths.has(path)) continue;
    applyPathSignal(state, "patched_file", path, PATCHED_FILE_WEIGHT, timestamp);
    attributeFollowthrough(state, path, timestamp);
  }
}

function foldReadPathGateArmedEvent(
  state: SessionSearchAdvisorState,
  payload: Record<string, unknown>,
  timestamp: number,
): void {
  const failedPaths = normalizeStringArray(payload.failedPaths);
  for (const failedPath of failedPaths) {
    for (const directory of buildAncestorDirectories(failedPath)) {
      applyDirectorySignal(
        state,
        "failed_read_directory",
        directory,
        FAILED_READ_DIRECTORY_WEIGHT,
        timestamp,
      );
    }
  }
}

function syncDurableState(
  runtime: BrewvaToolRuntime | undefined,
  sessionId: string | undefined,
  now: number,
): SessionSearchAdvisorState | undefined {
  const normalizedSessionId = normalizeSessionId(sessionId);
  if (!normalizedSessionId) {
    return undefined;
  }
  const eventPort = resolveToolRuntimeEventPort(runtime);
  const state = getSessionState(normalizedSessionId);
  attachRuntime(runtime);
  if (!eventPort?.query) {
    trimSessionState(state, now);
    return state;
  }

  const after = state.lastFoldTimestamp > 0 ? Math.max(0, state.lastFoldTimestamp - 1) : undefined;
  const merged = queryRelevantEvents(eventPort, normalizedSessionId, after)
    .filter((event) => !state.processedEventIds.has(event.id))
    .toSorted((left, right) => {
      if (left.timestamp !== right.timestamp) return left.timestamp - right.timestamp;
      return left.id.localeCompare(right.id);
    });

  for (const event of merged) {
    state.processedEventIds.set(event.id, true);
    state.lastFoldTimestamp = Math.max(state.lastFoldTimestamp, event.timestamp);
    if (!event.payload) continue;
    if (event.type === TOOL_READ_PATH_DISCOVERY_OBSERVED_EVENT_TYPE) {
      foldDiscoveryObservedEvent(state, event.payload, event.timestamp);
      continue;
    }
    if (event.type === PATCH_RECORDED_EVENT_TYPE) {
      foldPatchRecordedEvent(state, event.payload, event.timestamp);
      continue;
    }
    if (event.type === TOOL_READ_PATH_GATE_ARMED_EVENT_TYPE) {
      foldReadPathGateArmedEvent(state, event.payload, event.timestamp);
    }
  }

  trimSessionState(state, now);
  return state;
}

export function registerSearchIntent(input: {
  runtime?: BrewvaToolRuntime;
  sessionId?: string;
  toolName: SearchToolName;
  query: string;
  requestedPaths?: string[];
  now?: number;
}): void {
  const sessionId = normalizeSessionId(input.sessionId);
  if (!sessionId) {
    return;
  }
  const queryKey = buildQueryKey(input.toolName, input.query);
  if (!queryKey) {
    return;
  }
  attachRuntime(input.runtime);
  const state = getSessionState(sessionId);
  const now = input.now ?? Date.now();
  trimSessionState(state, now);
  state.recentSearchIntents.push({
    toolName: input.toolName,
    normalizedQuery: normalizeSearchAdvisorQuery(input.query),
    queryKey,
    issuedAt: now,
    requestedPaths: [...(input.requestedPaths ?? [])].map((path) => normalizeSignalPath(path)),
    previewPaths: [],
    previewDirectories: [],
  });
  if (state.recentSearchIntents.length > MAX_RECENT_INTENTS) {
    state.recentSearchIntents = state.recentSearchIntents.slice(-MAX_RECENT_INTENTS);
  }
}

export function attachSearchIntentPreviewCandidates(input: {
  sessionId?: string;
  toolName: SearchToolName;
  query: string;
  candidatePaths: string[];
  now?: number;
}): void {
  const sessionId = normalizeSessionId(input.sessionId);
  if (!sessionId) {
    return;
  }
  const queryKey = buildQueryKey(input.toolName, input.query);
  if (!queryKey) {
    return;
  }
  const state = getSessionState(sessionId);
  const now = input.now ?? Date.now();
  trimSessionState(state, now);
  const intent = state.recentSearchIntents
    .toReversed()
    .find((entry) => entry.queryKey === queryKey && entry.toolName === input.toolName);
  if (!intent) {
    return;
  }
  intent.previewPaths = [...new Set(input.candidatePaths.map((path) => normalizeSignalPath(path)))];
  intent.previewDirectories = [];
}

export function buildDelimiterInsensitivePattern(query: string): string | null {
  const normalized = normalizeSearchAdvisorQuery(query)
    .replace(/[_./:\-\s]+/gu, "")
    .trim();
  if (normalized.length < MIN_DELIMITER_FALLBACK_LENGTH) {
    return null;
  }
  return normalized
    .split("")
    .map((char) => char.replace(/[|\\{}()[\]^$+*?.]/gu, "\\$&"))
    .join("[-_./:\\s]*");
}

export function buildSearchAdvisorSnapshot(input: {
  runtime?: BrewvaToolRuntime;
  sessionId?: string;
  now?: number;
}): SearchAdvisorSnapshot {
  const now = input.now ?? Date.now();
  const sessionId = normalizeSessionId(input.sessionId);
  const state = syncDurableState(input.runtime, sessionId, now);
  if (!state) {
    return {
      advisorEnabled: false,
      signalFiles: 0,
      queryCombos: 0,
      hotFiles: [],
      scoreFile() {
        return {
          pathScore: 0,
          comboBias: 0,
          comboHits: 0,
          comboStrength: 0,
          comboThresholdHit: false,
          totalScore: 0,
        };
      },
      getComboMatch() {
        return undefined;
      },
    };
  }

  const hotFiles = [...state.fileSignals.entries()]
    .map(([filePath, entry]) => ({
      filePath,
      score: decayScore(entry.score, now - entry.updatedAt, PATH_HALF_LIFE_MS),
    }))
    .filter((entry) => entry.score >= SIGNAL_EPSILON)
    .toSorted((left, right) => right.score - left.score)
    .map((entry) => entry.filePath);

  return {
    advisorEnabled: true,
    signalFiles: hotFiles.length,
    queryCombos: state.queryCombos.size,
    hotFiles,
    scoreFile: ({ toolName, query, filePath }) => {
      const normalizedPath = normalizeSignalPath(filePath);
      const queryKey = buildQueryKey(toolName, query);
      const pathScore = getPathScore(state, normalizedPath, now);
      const combo = queryKey ? state.queryCombos.get(queryKey) : undefined;
      if (!combo || combo.filePath !== normalizedPath) {
        return {
          pathScore,
          comboBias: 0,
          comboHits: 0,
          comboStrength: 0,
          comboThresholdHit: false,
          totalScore: pathScore,
        };
      }
      const comboHits = combo.hitCount;
      const comboStrength = decayScore(combo.score, now - combo.updatedAt, COMBO_HALF_LIFE_MS);
      const comboThresholdHit = comboHits >= COMBO_THRESHOLD;
      const comboBias = comboThresholdHit ? comboStrength * 100 : comboStrength * 5;
      return {
        pathScore,
        comboBias,
        comboHits,
        comboStrength,
        comboThresholdHit,
        totalScore: pathScore + comboBias,
      };
    },
    getComboMatch: ({ toolName, query }) => {
      const queryKey = buildQueryKey(toolName, query);
      if (!queryKey) {
        return undefined;
      }
      const combo = state.queryCombos.get(queryKey);
      if (!combo) {
        return undefined;
      }
      return {
        ...combo,
        score: decayScore(combo.score, now - combo.updatedAt, COMBO_HALF_LIFE_MS),
      };
    },
  };
}

export function resetSearchAdvisorStateForTests(): void {
  sessionStates.clear();
  attachmentEpoch += 1;
}
