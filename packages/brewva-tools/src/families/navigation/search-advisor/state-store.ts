import { LRUCache } from "lru-cache";
import { buildAncestorDirectories, buildQueryKey, normalizeSignalPath } from "./path.js";
import {
  COMBO_HALF_LIFE_MS,
  FOLLOWTHROUGH_WINDOW_MS,
  IDENTICAL_SIGNAL_COOLDOWN_MS,
  MAX_PROCESSED_EVENTS,
  MAX_QUERY_COMBOS,
  MAX_RECENT_INTENTS,
  MAX_SIGNAL_DIRECTORIES,
  MAX_SIGNAL_FILES,
  PATH_HALF_LIFE_MS,
  SIGNAL_EPSILON,
  type QueryComboState,
  type ScoreEntry,
  type SearchToolName,
  type SessionSearchAdvisorState,
  type SignalSourceKind,
} from "./types.js";

const sessionStates = new Map<string, SessionSearchAdvisorState>();
const attachedRuntimes = new WeakMap<object, number>();
let attachmentEpoch = 0;

export function decayScore(score: number, ageMs: number, halfLifeMs: number): number {
  if (score <= 0) return 0;
  if (ageMs <= 0) return score;
  return score * Math.pow(0.5, ageMs / halfLifeMs);
}

export function createSessionState(): SessionSearchAdvisorState {
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

export function getSessionState(sessionId: string): SessionSearchAdvisorState {
  const existing = sessionStates.get(sessionId);
  if (existing) return existing;
  const next = createSessionState();
  sessionStates.set(sessionId, next);
  return next;
}

export function replaceSessionState(sessionId: string, state: SessionSearchAdvisorState): void {
  sessionStates.set(sessionId, state);
}

export function trimSessionState(state: SessionSearchAdvisorState, now: number): void {
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

export function applyPathSignal(
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

export function applyDirectorySignal(
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

export function getPathScore(
  state: SessionSearchAdvisorState,
  filePath: string,
  now: number,
): number {
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

function doesPreviewMatchPath(
  intent: SessionSearchAdvisorState["recentSearchIntents"][number],
  path: string,
): boolean {
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
  intent: SessionSearchAdvisorState["recentSearchIntents"][number],
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

export function attributeFollowthrough(
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

export function readComboMatch(input: {
  state: SessionSearchAdvisorState;
  toolName: SearchToolName;
  query: string;
  now: number;
}): QueryComboState | undefined {
  const queryKey = buildQueryKey(input.toolName, input.query);
  if (!queryKey) {
    return undefined;
  }
  const combo = input.state.queryCombos.get(queryKey);
  if (!combo) {
    return undefined;
  }
  return {
    ...combo,
    score: decayScore(combo.score, input.now - combo.updatedAt, COMBO_HALF_LIFE_MS),
  };
}

export function isRuntimeAttached(runtimeKey: object): boolean {
  return attachedRuntimes.get(runtimeKey) === attachmentEpoch;
}

export function markRuntimeAttached(runtimeKey: object): void {
  attachedRuntimes.set(runtimeKey, attachmentEpoch);
}

export function resetSearchAdvisorStateStore(): void {
  sessionStates.clear();
  attachmentEpoch += 1;
}
