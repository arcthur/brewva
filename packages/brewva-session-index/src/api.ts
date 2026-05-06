import type {
  BrewvaEventQuery,
  BrewvaEventRecord,
  BrewvaStructuredEvent,
} from "@brewva/brewva-runtime/events";
import type { SESSION_INDEX_UNAVAILABLE } from "./unavailable.js";

export const SESSION_INDEX_SCHEMA_VERSION = 3;

export type SessionIndexScope = "session_local" | "user_repository_root" | "workspace_wide";

export interface SessionIndexEventSource {
  listSessionIds(): string[];
  list(sessionId: string, query?: BrewvaEventQuery): BrewvaEventRecord[];
  getLogPath(sessionId: string): string;
  subscribe(listener: (event: BrewvaStructuredEvent) => void): () => void;
}

export interface SessionIndexTaskSource {
  getTargetDescriptor(sessionId: string): {
    primaryRoot?: string;
    roots?: string[];
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
  logPath: string;
  logOffset: number;
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

export type SessionIndexStatus =
  | {
      ok: true;
      dbPath: string;
      schemaVersion: typeof SESSION_INDEX_SCHEMA_VERSION;
      writer: boolean;
      indexedSessions: number;
      indexedEvents: number;
      staleReason?: string;
      readSnapshotPath?: string;
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
  close(): Promise<void>;
}

export interface CreateSessionIndexInput {
  workspaceRoot: string;
  events: SessionIndexEventSource;
  task: SessionIndexTaskSource;
  dbPath?: string;
}
