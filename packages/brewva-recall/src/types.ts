export const RECALL_BROKER_STATE_SCHEMA = "brewva.recall.broker.v3" as const;
export const RECALL_CURATION_HALFLIFE_DAYS = 45;

export const RECALL_SOURCE_FAMILIES = [
  "tape_evidence",
  "narrative_memory",
  "deliberation_memory",
  "optimization_continuity",
  "promotion_draft",
  "repository_precedent",
] as const;

export const RECALL_SCOPE_VALUES = [
  "session_local",
  "user_repository_root",
  "workspace_wide",
] as const;

export const RECALL_CURATION_SIGNAL_VALUES = [
  "helpful",
  "stale",
  "superseded",
  "wrong_scope",
  "misleading",
] as const;

export const RECALL_FRESHNESS_VALUES = ["fresh", "aging", "stale", "unknown"] as const;

export type RecallSourceFamily = (typeof RECALL_SOURCE_FAMILIES)[number];
export type RecallScope = (typeof RECALL_SCOPE_VALUES)[number];
export type RecallCurationSignal = (typeof RECALL_CURATION_SIGNAL_VALUES)[number];
export type RecallFreshness = (typeof RECALL_FRESHNESS_VALUES)[number];

export interface RecallSessionDigest {
  sessionId: string;
  eventCount: number;
  lastEventAt: number;
  repositoryRoot: string;
  primaryRoot: string;
  targetRoots: string[];
  taskGoal?: string;
  digestText: string;
}

export interface RecallEvidenceIndexEntry {
  sessionId: string;
  eventCount: number;
  lastEventAt: number;
  repositoryRoot: string;
  primaryRoot: string;
  targetRoots: string[];
  digestText: string;
}

export interface RecallCurationAggregate {
  stableId: string;
  helpfulSignals: number;
  staleSignals: number;
  supersededSignals: number;
  wrongScopeSignals: number;
  misleadingSignals: number;
  helpfulWeight: number;
  staleWeight: number;
  supersededWeight: number;
  wrongScopeWeight: number;
  misleadingWeight: number;
  lastSignalAt?: number;
}

export interface RecallCurationSnapshot {
  helpfulSignals: number;
  staleSignals: number;
  supersededSignals: number;
  wrongScopeSignals: number;
  misleadingSignals: number;
  helpfulWeight: number;
  staleWeight: number;
  supersededWeight: number;
  wrongScopeWeight: number;
  misleadingWeight: number;
  lastSignalAt?: number;
  scoreAdjustment: number;
}

export interface RecallBrokerState {
  schema: typeof RECALL_BROKER_STATE_SCHEMA;
  updatedAt: number;
  sessionDigests: RecallSessionDigest[];
  evidenceIndex: RecallEvidenceIndexEntry[];
  curation: RecallCurationAggregate[];
}

export interface RecallSearchEntry {
  stableId: string;
  sourceFamily: RecallSourceFamily;
  scope: RecallScope;
  score: number;
  title: string;
  summary: string;
  excerpt: string;
  freshness: RecallFreshness;
  matchReasons: string[];
  sessionId?: string;
  relativePath?: string;
  targetRoots?: string[];
  curation?: RecallCurationSnapshot;
}

export interface RecallSearchResult {
  query: string;
  scope: RecallScope;
  results: RecallSearchEntry[];
}

export interface RecallInspectResult {
  scope: RecallScope;
  requestedStableIds: string[];
  unresolvedStableIds: string[];
  results: RecallSearchEntry[];
}
