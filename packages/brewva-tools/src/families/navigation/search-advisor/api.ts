import type { BrewvaToolRuntime } from "../../../contracts/index.js";
import { attachRuntime, syncDurableState } from "./durable-events.js";
import {
  buildQueryKey,
  normalizeSearchAdvisorQuery,
  normalizeSessionId,
  normalizeSignalPath,
} from "./path.js";
import {
  decayScore,
  getPathScore,
  getSessionState,
  readComboMatch,
  trimSessionState,
} from "./state-store.js";
import {
  COMBO_HALF_LIFE_MS,
  COMBO_THRESHOLD,
  MAX_RECENT_INTENTS,
  PATH_HALF_LIFE_MS,
  SIGNAL_EPSILON,
  type SearchAdvisorSnapshot,
  type SearchToolName,
} from "./types.js";

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
      return readComboMatch({
        state,
        toolName,
        query,
        now,
      });
    },
  };
}
