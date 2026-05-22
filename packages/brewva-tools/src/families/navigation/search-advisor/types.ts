import type { LRUCache } from "lru-cache";

export const MAX_SIGNAL_FILES = 256;
export const MAX_SIGNAL_DIRECTORIES = 128;
export const MAX_QUERY_COMBOS = 128;
export const MAX_RECENT_INTENTS = 24;
export const MAX_PROCESSED_EVENTS = 512;
export const PATH_HALF_LIFE_MS = 20 * 60 * 1000;
export const COMBO_HALF_LIFE_MS = 30 * 60 * 1000;
export const FOLLOWTHROUGH_WINDOW_MS = 10 * 60 * 1000;
export const IDENTICAL_SIGNAL_COOLDOWN_MS = 5 * 1000;
export const COMBO_THRESHOLD = 3;
export const MIN_DELIMITER_FALLBACK_LENGTH = 3;
export const SIGNAL_EPSILON = 0.01;

export const OBSERVED_PATH_WEIGHT = 3;
export const OBSERVED_DIRECTORY_WEIGHT = 1;
export const PATCHED_FILE_WEIGHT = 6;
export const FAILED_READ_DIRECTORY_WEIGHT = 2;

export type SearchToolName = "grep" | "code_digest";
export type SignalSourceKind =
  | "observed_path"
  | "observed_directory"
  | "patched_file"
  | "failed_read_directory";

export interface ScoreEntry {
  score: number;
  updatedAt: number;
}

export interface QueryComboState extends ScoreEntry {
  filePath: string;
  hitCount: number;
}

export interface RecentSearchIntent {
  toolName: SearchToolName;
  normalizedQuery: string;
  queryKey: string;
  issuedAt: number;
  requestedPaths: string[];
  previewPaths: string[];
  previewDirectories: string[];
  confirmedAt?: number;
}

export interface SessionSearchAdvisorState {
  fileSignals: LRUCache<string, ScoreEntry>;
  directorySignals: LRUCache<string, ScoreEntry>;
  queryCombos: LRUCache<string, QueryComboState>;
  recentSearchIntents: RecentSearchIntent[];
  lastFoldTimestamp: number;
  processedEventIds: LRUCache<string, true>;
  lastContributionAt: Map<string, number>;
}

export interface NormalizedEventRecord {
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
