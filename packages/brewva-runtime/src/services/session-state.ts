import type {
  ActiveSkillRuntimeState,
  HistoryViewBaselineSnapshot,
  OpenToolCallRecord,
  PromptStabilityState,
  ResourceLeaseRecord,
  SessionHydrationState,
  SessionUncleanShutdownDiagnostic,
  SkillCompletionFailureRecord,
  SkillOutputRecord,
  TransientReductionState,
} from "../contracts/index.js";

interface ReservedContextInjectionTokens {
  primaryTokens: number;
  supplementalTokens: number;
}

export interface ConsecutiveToolCallState {
  toolName: string;
  hash: string;
  count: number;
}

export class RuntimeSessionStateCell {
  activeSkill?: string;
  activeSkillState?: ActiveSkillRuntimeState;
  latestSkillFailure?: SkillCompletionFailureRecord;
  turn = 0;
  toolCalls = 0;
  openToolCalls = new Map<string, OpenToolCallRecord>();
  uncleanShutdownDiagnostic?: SessionUncleanShutdownDiagnostic;
  consecutiveToolCall?: ConsecutiveToolCallState;
  effectCommitmentRequestIdsByToolCallId = new Map<string, string>();
  inflightEffectCommitmentRequestIds = new Set<string>();
  lastInjectedContextFingerprintByScope = new Map<string, string>();
  reservedContextInjectionTokensByScope = new Map<string, ReservedContextInjectionTokens>();
  promptStability?: PromptStabilityState;
  transientReduction?: TransientReductionState;
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
  skillBudgetWarnings = new Set<string>();
  skillParallelWarnings = new Set<string>();
  resourceLeases = new Map<string, ResourceLeaseRecord>();
  skillOutputs = new Map<string, SkillOutputRecord>();
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

  private static readSessionIdFromScopeKey(scopeKey: string): string {
    const separatorIndex = scopeKey.indexOf("::");
    if (separatorIndex < 0) {
      throw new Error(`Invalid injection scope key '${scopeKey}'.`);
    }
    const sessionId = scopeKey.slice(0, separatorIndex).trim();
    if (!sessionId) {
      throw new Error(`Invalid injection scope key '${scopeKey}'.`);
    }
    return sessionId;
  }

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

  buildInjectionScopeKey(sessionId: string, scopeId?: string): string {
    const normalizedScope = scopeId?.trim();
    if (!normalizedScope) return `${sessionId}::root`;
    return `${sessionId}::${normalizedScope}`;
  }

  private normalizeReservedTokens(tokens: number): number {
    if (!Number.isFinite(tokens)) {
      return 0;
    }
    return Math.max(0, Math.floor(tokens));
  }

  private getReservedTokensRecord(scopeKey: string): ReservedContextInjectionTokens | undefined {
    return this.getExistingCell(
      RuntimeSessionStateStore.readSessionIdFromScopeKey(scopeKey),
    )?.reservedContextInjectionTokensByScope.get(scopeKey);
  }

  private setReservedTokensRecord(scopeKey: string, record: ReservedContextInjectionTokens): void {
    const normalizedRecord: ReservedContextInjectionTokens = {
      primaryTokens: this.normalizeReservedTokens(record.primaryTokens),
      supplementalTokens: this.normalizeReservedTokens(record.supplementalTokens),
    };

    const totalTokens = normalizedRecord.primaryTokens + normalizedRecord.supplementalTokens;
    const sessionId = RuntimeSessionStateStore.readSessionIdFromScopeKey(scopeKey);
    const store = this.getCell(sessionId).reservedContextInjectionTokensByScope;
    if (totalTokens <= 0) {
      store.delete(scopeKey);
      return;
    }
    store.set(scopeKey, normalizedRecord);
  }

  getReservedInjectionTokens(scopeKey: string): number | undefined {
    const record = this.getReservedTokensRecord(scopeKey);
    if (!record) {
      return undefined;
    }
    return record.primaryTokens + record.supplementalTokens;
  }

  setReservedInjectionTokens(scopeKey: string, tokens: number): void {
    this.setReservedTokensRecord(scopeKey, {
      primaryTokens: tokens,
      supplementalTokens: 0,
    });
  }

  getReservedPrimaryInjectionTokens(scopeKey: string): number | undefined {
    return this.getReservedTokensRecord(scopeKey)?.primaryTokens;
  }

  setReservedPrimaryInjectionTokens(scopeKey: string, tokens: number): void {
    const current = this.getReservedTokensRecord(scopeKey);
    this.setReservedTokensRecord(scopeKey, {
      primaryTokens: tokens,
      supplementalTokens: current?.supplementalTokens ?? 0,
    });
  }

  getReservedSupplementalInjectionTokens(scopeKey: string): number | undefined {
    return this.getReservedTokensRecord(scopeKey)?.supplementalTokens;
  }

  setReservedSupplementalInjectionTokens(scopeKey: string, tokens: number): void {
    const current = this.getReservedTokensRecord(scopeKey);
    this.setReservedTokensRecord(scopeKey, {
      primaryTokens: current?.primaryTokens ?? 0,
      supplementalTokens: tokens,
    });
  }

  getLastInjectedFingerprint(scopeKey: string): string | undefined {
    return this.getExistingCell(
      RuntimeSessionStateStore.readSessionIdFromScopeKey(scopeKey),
    )?.lastInjectedContextFingerprintByScope.get(scopeKey);
  }

  setLastInjectedFingerprint(scopeKey: string, fingerprint: string): void {
    this.getCell(
      RuntimeSessionStateStore.readSessionIdFromScopeKey(scopeKey),
    ).lastInjectedContextFingerprintByScope.set(scopeKey, fingerprint);
  }

  getPromptStability(sessionId: string): PromptStabilityState | undefined {
    return this.getExistingCell(sessionId)?.promptStability;
  }

  setPromptStability(sessionId: string, state: PromptStabilityState): void {
    this.getCell(sessionId).promptStability = state;
  }

  getTransientReduction(sessionId: string): TransientReductionState | undefined {
    return this.getExistingCell(sessionId)?.transientReduction;
  }

  setTransientReduction(sessionId: string, state: TransientReductionState): void {
    this.getCell(sessionId).transientReduction = state;
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

  clearInjectionFingerprintsForSession(sessionId: string): void {
    this.cells.get(sessionId)?.lastInjectedContextFingerprintByScope.clear();
  }

  clearReservedInjectionTokensForSession(sessionId: string): void {
    this.cells.get(sessionId)?.reservedContextInjectionTokensByScope.clear();
  }

  clearSession(sessionId: string): void {
    this.cells.delete(sessionId);
  }
}
