import type {
  HistoryViewBaselineSnapshot,
  ResourceLeaseRecord,
  VisibleReadState,
} from "../context/api.js";
import type {
  OpenToolCallRecord,
  SessionHydrationState,
  SessionUncleanShutdownDiagnostic,
} from "./types.js";

export interface ConsecutiveToolCallState {
  toolName: string;
  hash: string;
  count: number;
}

export class RuntimeSessionStateCell {
  turn = 0;
  toolCalls = 0;
  openToolCalls = new Map<string, OpenToolCallRecord>();
  uncleanShutdownDiagnostic?: SessionUncleanShutdownDiagnostic;
  consecutiveToolCall?: ConsecutiveToolCallState;
  effectCommitmentRequestIdsByToolCallId = new Map<string, string>();
  inflightEffectCommitmentRequestIds = new Set<string>();
  visibleReadEpoch = 0;
  visibleReadStates = new Map<string, VisibleReadState>();
  historyViewBaselineCache?: HistoryViewBaselineSnapshot;
  historyViewBaselineCacheLatestEventId?: string | null;
  historyViewBaselineCacheEventCount?: number;
  historyViewBaselineCacheDegradedReason?: string | null;
  historyViewBaselineCachePostureMode?: "degraded" | "diagnostic_only" | null;
  historyViewBaselineCacheReferenceContextDigest?: string | null;
  historyViewBaselineCacheMaxBaselineTokens?: number | null;
  lastLedgerCompactionTurn?: number;
  toolContractWarnings = new Set<string>();
  governanceMetadataWarnings = new Set<string>();
  resourceLeases = new Map<string, ResourceLeaseRecord>();
  tapeCheckpointWriteInProgress = false;
  tapeCheckpointCounterInitialized = false;
  tapeEntriesSinceCheckpoint = 0;
  tapeLatestAnchorEventId?: string;
  tapeLastCheckpointEventId?: string;
  tapeProcessedEventIdsSinceCheckpoint = new Set<string>();
  parallelBudgetHydrated = false;
  parallelBudgetLatestEventId?: string;
  hydration: SessionHydrationState = {
    status: "cold",
    issues: [],
  };
}

export class RuntimeSessionStateStore {
  private readonly cells = new Map<string, RuntimeSessionStateCell>();

  getCell(sessionId: string): RuntimeSessionStateCell {
    const existing = this.cells.get(sessionId);
    if (existing) return existing;

    const created = new RuntimeSessionStateCell();
    this.cells.set(sessionId, created);
    return created;
  }

  getExistingCell(sessionId: string): RuntimeSessionStateCell | undefined {
    return this.cells.get(sessionId);
  }

  getCurrentTurn(sessionId: string): number {
    return this.cells.get(sessionId)?.turn ?? 0;
  }

  getVisibleReadEpoch(sessionId: string): number {
    return this.getExistingCell(sessionId)?.visibleReadEpoch ?? 0;
  }

  advanceVisibleReadEpoch(sessionId: string): number {
    const cell = this.getCell(sessionId);
    cell.visibleReadEpoch += 1;
    cell.visibleReadStates.clear();
    return cell.visibleReadEpoch;
  }

  rememberVisibleReadState(sessionId: string, state: VisibleReadState): void {
    this.getCell(sessionId).visibleReadStates.set(buildVisibleReadStateKey(state), {
      ...state,
    });
  }

  isVisibleReadStateCurrent(sessionId: string, state: VisibleReadState): boolean {
    const cell = this.getExistingCell(sessionId);
    if (!cell || state.visibleHistoryEpoch !== cell.visibleReadEpoch) {
      return false;
    }
    const remembered = cell.visibleReadStates.get(buildVisibleReadStateKey(state));
    return remembered?.signatureHash === state.signatureHash;
  }

  getHistoryViewBaselineCache(sessionId: string):
    | {
        snapshot?: HistoryViewBaselineSnapshot;
        latestEventId: string | null;
        eventCount: number;
        degradedReason: string | null;
        postureMode: "degraded" | "diagnostic_only" | null;
        referenceContextDigest: string | null;
        maxBaselineTokens: number | null;
      }
    | undefined {
    const cell = this.getExistingCell(sessionId);
    if (
      !cell ||
      cell.historyViewBaselineCacheEventCount === undefined ||
      cell.historyViewBaselineCacheLatestEventId === undefined
    ) {
      return undefined;
    }
    return {
      snapshot: cell.historyViewBaselineCache,
      latestEventId: cell.historyViewBaselineCacheLatestEventId,
      eventCount: cell.historyViewBaselineCacheEventCount,
      degradedReason: cell.historyViewBaselineCacheDegradedReason ?? null,
      postureMode: cell.historyViewBaselineCachePostureMode ?? null,
      referenceContextDigest: cell.historyViewBaselineCacheReferenceContextDigest ?? null,
      maxBaselineTokens: cell.historyViewBaselineCacheMaxBaselineTokens ?? null,
    };
  }

  setHistoryViewBaselineCache(
    sessionId: string,
    input: {
      snapshot?: HistoryViewBaselineSnapshot;
      latestEventId: string | null;
      eventCount: number;
      degradedReason: string | null;
      postureMode: "degraded" | "diagnostic_only" | null;
      referenceContextDigest: string | null;
      maxBaselineTokens: number | null;
    },
  ): void {
    const cell = this.getCell(sessionId);
    cell.historyViewBaselineCache = input.snapshot;
    cell.historyViewBaselineCacheLatestEventId = input.latestEventId;
    cell.historyViewBaselineCacheEventCount = Math.max(0, Math.trunc(input.eventCount));
    cell.historyViewBaselineCacheDegradedReason = input.degradedReason;
    cell.historyViewBaselineCachePostureMode = input.postureMode;
    cell.historyViewBaselineCacheReferenceContextDigest = input.referenceContextDigest;
    cell.historyViewBaselineCacheMaxBaselineTokens =
      input.maxBaselineTokens === null || input.maxBaselineTokens === undefined
        ? null
        : Math.max(0, Math.trunc(input.maxBaselineTokens));
  }

  clearSession(sessionId: string): void {
    this.cells.delete(sessionId);
  }
}

function buildVisibleReadStateKey(state: VisibleReadState): string {
  return [
    state.path,
    String(Math.max(0, Math.trunc(state.offset))),
    state.limit === null ? "none" : String(Math.max(0, Math.trunc(state.limit))),
    state.encoding,
    state.previousReadId,
  ].join("\0");
}
