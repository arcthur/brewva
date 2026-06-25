import type { BrewvaEventQuery, BrewvaEventRecord } from "@brewva/brewva-vocabulary/events";
import type {
  HarnessPatternCandidate,
  HarnessTraceSnapshot,
} from "@brewva/brewva-vocabulary/harness";
import type { SESSION_INDEX_UNAVAILABLE } from "./unavailable.js";

// Version 8 marks the SQLite + FTS5 schema generation (session_fts / event_fts),
// distinct from the DuckDB-era token tables that also carried version 7; on any
// stale lower-version index `hasSchemaMismatch` triggers a full rebuild.
export const SESSION_INDEX_SCHEMA_VERSION = 8;

export type SessionIndexScope = "session_local" | "user_repository_root" | "workspace_wide";

export interface SessionIndexEventSource {
  readonly records: {
    listSessionIds(): string[];
    list(sessionId: string, query?: BrewvaEventQuery): BrewvaEventRecord[];
    subscribe(listener: (event: BrewvaEventRecord) => void): () => void;
  };
}

export interface SessionIndexTaskSource {
  readonly target: {
    getDescriptor(sessionId: string): {
      primaryRoot?: string;
      roots?: string[];
    };
  };
}

export interface SessionIndexDigest {
  sessionId: string;
  eventCount: number;
  lastEventAt: number;
  repositoryRoot: string;
  primaryRoot: string;
  targetRoots: string[];
  taskGoal?: string;
  digestText: string;
  tokenScore: number;
}

export interface SessionIndexTapeEvidence {
  eventId: string;
  sessionId: string;
  timestamp: number;
  turn?: number;
  type: string;
  payload: Record<string, unknown>;
  searchText: string;
  sourceUri: string;
  sourceSequence: number;
  tokenScore: number;
}

export interface QuerySessionDigestsInput {
  currentSessionId: string;
  scope: SessionIndexScope;
  targetRoots: readonly string[];
  query: string;
  limit: number;
}

export interface QueryTapeEvidenceInput {
  sessionIds: readonly string[];
  query: string;
  limit: number;
}

export interface QueryRecentSessionsInput {
  limit: number;
}

export interface FilterSessionIdsByScopeInput {
  currentSessionId: string;
  scope: SessionIndexScope;
  targetRoots: readonly string[];
  sessionIds: readonly string[];
}

export interface ListSessionDigestsInput {
  limit?: number;
}

export interface SessionIndexRecentSession {
  sessionId: string;
  eventCount: number;
  lastEventAt: number;
}

export interface SessionIndexBox {
  sessionId: string;
  boxId: string;
  image: string;
  createdAt: number;
  lastExecAt: number;
  fingerprint?: string;
  snapshotRefs: string[];
}

export interface SessionIndexRewindTarget {
  sessionId: string;
  checkpointId: string;
  turn: number;
  timestamp: number;
  promptPreview: string;
  patchSetCountAfter: number;
  fileSummary: {
    added: number;
    modified: number;
    deleted: number;
  };
  lineage: { kind: "active" } | { kind: "abandoned"; rewoundBy: string; rewoundAt: number };
}

export interface SessionIndexDelegationRun {
  sessionId: string;
  runId: string;
  status: string;
  taskPath?: string;
  nickname?: string;
  delegate?: string;
  agent?: string;
  kind?: string;
  childSessionId?: string;
  summary?: string;
  error?: string;
  updatedAt: number;
  eventId: string;
  record: Record<string, unknown>;
  cursor: {
    eventCount: number;
    schemaVersion: typeof SESSION_INDEX_SCHEMA_VERSION;
  };
}

export interface SessionIndexWorkerResult {
  sessionId: string;
  workerId: string;
  status: string;
  summary?: string;
  patchSetId?: string;
  updatedAt: number;
  eventId: string;
  record: Record<string, unknown>;
  cursor: {
    eventCount: number;
    schemaVersion: typeof SESSION_INDEX_SCHEMA_VERSION;
  };
}

export interface SessionIndexParallelBudgetView {
  sessionId: string;
  activeRunIds: string[];
  totalStarted: number;
  eventCount: number;
  latestEventId?: string;
  schemaVersion: typeof SESSION_INDEX_SCHEMA_VERSION;
}

export interface SessionIndexDelegationProjection {
  sessionId: string;
  runs: SessionIndexDelegationRun[];
  workerResults: SessionIndexWorkerResult[];
  parallelBudget: SessionIndexParallelBudgetView;
}

export type SessionIndexHarnessTraceSnapshot = HarnessTraceSnapshot;
export type SessionIndexHarnessPatternCandidate = HarnessPatternCandidate;

export type SessionIndexStatus =
  | {
      ok: true;
      dbPath: string;
      schemaVersion: typeof SESSION_INDEX_SCHEMA_VERSION;
      writer: boolean;
      indexedSessions: number;
      indexedEvents: number;
      staleReason?: string;
      lastIndexedAt?: number;
      indexAgeMs?: number;
    }
  | {
      ok: false;
      dbPath: string;
      error: typeof SESSION_INDEX_UNAVAILABLE;
      message: string;
    };

export interface SessionIndex {
  readonly dbPath: string;
  status(): Promise<SessionIndexStatus>;
  catchUp(): Promise<SessionIndexStatus>;
  rebuild(): Promise<SessionIndexStatus>;
  querySessionDigests(input: QuerySessionDigestsInput): Promise<SessionIndexDigest[]>;
  listSessionDigests(input?: ListSessionDigestsInput): Promise<SessionIndexDigest[]>;
  getSessionDigest(input: { sessionId: string }): Promise<SessionIndexDigest | undefined>;
  filterSessionIdsByScope(input: FilterSessionIdsByScopeInput): Promise<string[]>;
  queryTapeEvidence(input: QueryTapeEvidenceInput): Promise<SessionIndexTapeEvidence[]>;
  getTapeEvent(input: {
    sessionId: string;
    eventId: string;
  }): Promise<SessionIndexTapeEvidence | undefined>;
  listRecentSessions(input: QueryRecentSessionsInput): Promise<SessionIndexRecentSession[]>;
  listSessionBoxes(input?: { sessionId?: string }): Promise<SessionIndexBox[]>;
  listSessionRewindTargets(input: { sessionId: string }): Promise<SessionIndexRewindTarget[]>;
  listDelegationRuns(input?: {
    sessionId?: string;
    includeTerminal?: boolean;
    limit?: number;
  }): Promise<SessionIndexDelegationRun[]>;
  listPendingDelegationOutcomes(input: {
    sessionId: string;
    limit?: number;
  }): Promise<SessionIndexDelegationRun[]>;
  listWorkerResults(input?: {
    sessionId?: string;
    limit?: number;
  }): Promise<SessionIndexWorkerResult[]>;
  getParallelBudgetView(input: { sessionId: string }): Promise<SessionIndexParallelBudgetView>;
  listHarnessTraceSnapshots(input?: {
    sessionId?: string;
    limit?: number;
  }): Promise<SessionIndexHarnessTraceSnapshot[]>;
  getHarnessTraceSnapshot(input: {
    snapshotId: string;
  }): Promise<SessionIndexHarnessTraceSnapshot | undefined>;
  listHarnessPatternCandidates(input?: {
    sessionId?: string;
    minOccurrences?: number;
    limit?: number;
  }): Promise<SessionIndexHarnessPatternCandidate[]>;
  close(): Promise<void>;
}

export interface CreateSessionIndexInput {
  workspaceRoot: string;
  events: SessionIndexEventSource;
  task: SessionIndexTaskSource;
  dbPath?: string;
}
