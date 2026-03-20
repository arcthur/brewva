import type { ContextBudgetManager } from "../context/budget.js";
import type { ContextInjectionCollector } from "../context/injection.js";
import type { SessionCostTracker } from "../cost/tracker.js";
import type { BrewvaEventStore } from "../events/store.js";
import type { EvidenceLedger } from "../ledger/evidence-ledger.js";
import type { ParallelBudgetManager } from "../parallel/budget.js";
import type { ParallelResultStore } from "../parallel/results.js";
import type { ProjectionEngine } from "../projection/engine.js";
import type { RuntimeKernelContext } from "../runtime-kernel.js";
import type { FileChangeTracker } from "../state/file-change-tracker.js";
import { TAPE_CHECKPOINT_EVENT_TYPE, coerceTapeCheckpointPayload } from "../tape/events.js";
import type { TurnReplayEngine } from "../tape/replay-engine.js";
import type {
  BrewvaEventRecord,
  DelegationRunQuery,
  DelegationRunRecord,
  SessionHydrationIssue,
  SessionHydrationState,
} from "../types.js";
import type { VerificationGate } from "../verification/gate.js";
import type { ContextService } from "./context.js";
import { createCostHydrationFold } from "./session-hydration-fold-cost.js";
import { createDelegationHydrationFold } from "./session-hydration-fold-delegation.js";
import { createLedgerHydrationFold } from "./session-hydration-fold-ledger.js";
import { createResourceLeaseHydrationFold } from "./session-hydration-fold-resource-lease.js";
import { createSkillHydrationFold } from "./session-hydration-fold-skill.js";
import { createVerificationHydrationFold } from "./session-hydration-fold-verification.js";
import {
  applySessionHydrationFold,
  type SessionHydrationApplyContext,
  type SessionHydrationFold,
  type SessionHydrationFoldCallbacks,
  type SessionHydrationFoldContext,
} from "./session-hydration-fold.js";
import { RuntimeSessionStateCell, RuntimeSessionStateStore } from "./session-state.js";

export interface SessionLifecycleServiceOptions {
  sessionState: RuntimeKernelContext["sessionState"];
  contextBudget: RuntimeKernelContext["contextBudget"];
  contextInjection: RuntimeKernelContext["contextInjection"];
  fileChanges: RuntimeKernelContext["fileChanges"];
  verificationGate: RuntimeKernelContext["verificationGate"];
  parallel: RuntimeKernelContext["parallel"];
  parallelResults: RuntimeKernelContext["parallelResults"];
  costTracker: RuntimeKernelContext["costTracker"];
  projectionEngine: RuntimeKernelContext["projectionEngine"];
  turnReplay: RuntimeKernelContext["turnReplay"];
  eventStore: RuntimeKernelContext["eventStore"];
  evidenceLedger: RuntimeKernelContext["evidenceLedger"];
  recordEvent: RuntimeKernelContext["recordEvent"];
  contextService: Pick<ContextService, "clearReservedInjectionTokensForSession">;
}

interface SessionHydrationReplayState {
  costReplayStartIndex: number;
  checkpointTurn: number | null;
}

interface SessionHydrationFoldEntry {
  fold: SessionHydrationFold<unknown>;
  state: unknown;
}

interface SessionHydrationRun {
  issues: SessionHydrationIssue[];
  callbacks: SessionHydrationFoldCallbacks;
  applyContext: SessionHydrationApplyContext;
  foldEntries: SessionHydrationFoldEntry[];
}

export class SessionLifecycleService {
  private readonly sessionState: RuntimeSessionStateStore;
  private readonly contextBudget: ContextBudgetManager;
  private readonly contextInjection: ContextInjectionCollector;
  private readonly clearReservedInjectionTokensForSession: (sessionId: string) => void;
  private readonly fileChanges: FileChangeTracker;
  private readonly verification: VerificationGate;
  private readonly parallel: ParallelBudgetManager;
  private readonly parallelResults: ParallelResultStore;
  private readonly costTracker: SessionCostTracker;
  private readonly projectionEngine: ProjectionEngine;
  private readonly turnReplay: TurnReplayEngine;
  private readonly events: BrewvaEventStore;
  private readonly ledger: EvidenceLedger;
  private readonly recordEvent: (input: {
    sessionId: string;
    type: string;
    turn?: number;
    payload?: Record<string, unknown>;
    timestamp?: number;
    skipTapeCheckpoint?: boolean;
  }) => unknown;
  private readonly clearStateListeners = new Set<(sessionId: string) => void>();

  constructor(options: SessionLifecycleServiceOptions) {
    this.sessionState = options.sessionState;
    this.contextBudget = options.contextBudget;
    this.contextInjection = options.contextInjection;
    this.clearReservedInjectionTokensForSession = (sessionId) =>
      options.contextService.clearReservedInjectionTokensForSession(sessionId);
    this.fileChanges = options.fileChanges;
    this.verification = options.verificationGate;
    this.parallel = options.parallel;
    this.parallelResults = options.parallelResults;
    this.costTracker = options.costTracker;
    this.projectionEngine = options.projectionEngine;
    this.turnReplay = options.turnReplay;
    this.events = options.eventStore;
    this.ledger = options.evidenceLedger;
    this.recordEvent = (input) => options.recordEvent(input);
  }

  private static readonly hydrationFolds: SessionHydrationFold<unknown>[] = [
    createSkillHydrationFold(),
    createVerificationHydrationFold(),
    createResourceLeaseHydrationFold(),
    createCostHydrationFold(),
    createLedgerHydrationFold(),
    createDelegationHydrationFold(),
  ];

  private static cloneDelegationRunRecord(record: DelegationRunRecord): DelegationRunRecord {
    return {
      ...record,
      artifactRefs: record.artifactRefs?.map((ref) => ({
        kind: ref.kind,
        path: ref.path,
        summary: ref.summary,
      })),
      delivery: record.delivery
        ? {
            mode: record.delivery.mode,
            scopeId: record.delivery.scopeId,
            label: record.delivery.label,
            supplementalAppended: record.delivery.supplementalAppended,
            updatedAt: record.delivery.updatedAt,
          }
        : undefined,
    };
  }

  onTurnStart(sessionId: string, turnIndex: number): void {
    this.hydrateSessionStateFromEvents(sessionId);
    const state = this.sessionState.getCell(sessionId);
    const current = state.turn;
    const effectiveTurn = Math.max(current, turnIndex);
    state.turn = effectiveTurn;
    this.contextBudget.beginTurn(sessionId, effectiveTurn);
    this.contextInjection.clearPending(sessionId);
    this.clearReservedInjectionTokensForSession(sessionId);
  }

  ensureHydrated(sessionId: string): void {
    this.hydrateSessionStateFromEvents(sessionId);
  }

  getHydrationState(sessionId: string): SessionHydrationState {
    const hydration = this.sessionState.getExistingCell(sessionId)?.hydration;
    if (!hydration) {
      return {
        status: "cold",
        issues: [],
      };
    }
    return {
      status: hydration.status,
      latestEventId: hydration.latestEventId,
      hydratedAt: hydration.hydratedAt,
      issues: hydration.issues.map((issue) => ({
        eventId: issue.eventId,
        eventType: issue.eventType,
        index: issue.index,
        reason: issue.reason,
      })),
    };
  }

  recordDelegationRun(sessionId: string, record: DelegationRunRecord): void {
    this.hydrateSessionStateFromEvents(sessionId);
    this.sessionState
      .getCell(sessionId)
      .delegationRuns.set(record.runId, SessionLifecycleService.cloneDelegationRunRecord(record));
  }

  getDelegationRun(sessionId: string, runId: string): DelegationRunRecord | undefined {
    this.hydrateSessionStateFromEvents(sessionId);
    const record = this.sessionState.getExistingCell(sessionId)?.delegationRuns.get(runId);
    if (!record) {
      return undefined;
    }
    return SessionLifecycleService.cloneDelegationRunRecord(record);
  }

  listDelegationRuns(sessionId: string, query: DelegationRunQuery = {}): DelegationRunRecord[] {
    this.hydrateSessionStateFromEvents(sessionId);
    const cell = this.sessionState.getExistingCell(sessionId);
    if (!cell) {
      return [];
    }
    const runIdFilter =
      Array.isArray(query.runIds) && query.runIds.length > 0 ? new Set(query.runIds) : undefined;
    const statusFilter =
      Array.isArray(query.statuses) && query.statuses.length > 0
        ? new Set(query.statuses)
        : undefined;
    const includeTerminal = query.includeTerminal !== false;
    const runs = [...cell.delegationRuns.values()]
      .filter((record) => {
        if (runIdFilter && !runIdFilter.has(record.runId)) {
          return false;
        }
        if (
          !includeTerminal &&
          (record.status === "completed" ||
            record.status === "failed" ||
            record.status === "timeout" ||
            record.status === "cancelled" ||
            record.status === "merged")
        ) {
          return false;
        }
        if (statusFilter && !statusFilter.has(record.status)) {
          return false;
        }
        return true;
      })
      .toSorted((left, right) => {
        if (right.updatedAt !== left.updatedAt) {
          return right.updatedAt - left.updatedAt;
        }
        return left.runId.localeCompare(right.runId);
      })
      .map((record) => SessionLifecycleService.cloneDelegationRunRecord(record));
    if (typeof query.limit === "number" && Number.isFinite(query.limit) && query.limit > 0) {
      return runs.slice(0, Math.trunc(query.limit));
    }
    return runs;
  }

  onClearState(listener: (sessionId: string) => void): () => void {
    this.clearStateListeners.add(listener);
    return () => {
      this.clearStateListeners.delete(listener);
    };
  }

  clearSessionState(sessionId: string): void {
    for (const listener of this.clearStateListeners) {
      try {
        listener(sessionId);
      } catch {
        // Session cleanup listeners must never block runtime state teardown.
      }
    }

    this.sessionState.clearSession(sessionId);

    this.fileChanges.clearSession(sessionId);
    this.verification.stateStore.clear(sessionId);
    this.parallel.clear(sessionId);
    this.parallelResults.clear(sessionId);
    this.contextBudget.clear(sessionId);
    this.costTracker.clear(sessionId);

    this.contextInjection.clearSession(sessionId);
    this.projectionEngine.clearSessionCache(sessionId);

    this.turnReplay.clear(sessionId);

    this.events.clearSessionCache(sessionId);
    this.ledger.clearSessionCache(sessionId);
  }

  private hydrateSessionStateFromEvents(sessionId: string): void {
    const state = this.sessionState.getCell(sessionId);
    if (state.hydration.status !== "cold") return;

    const events = this.events.list(sessionId);
    this.resetHydrationSupportStores(sessionId);
    if (events.length === 0) {
      state.hydration = {
        status: "ready",
        hydratedAt: Date.now(),
        issues: [],
      };
      return;
    }

    this.projectionEngine.rebuildSessionFromTape({
      sessionId,
      events,
      mode: "missing_only",
    });

    const replayState = this.prepareHydrationReplayState(sessionId, events);
    const hydrationRun = this.createHydrationRun(sessionId, state);
    this.replayHydrationEvents(sessionId, events, hydrationRun, replayState);
    this.applyHydrationRun(state, events, hydrationRun);
  }

  private resetHydrationSupportStores(sessionId: string): void {
    this.costTracker.clear(sessionId);
    this.verification.stateStore.clear(sessionId);
  }

  private prepareHydrationReplayState(
    sessionId: string,
    events: BrewvaEventRecord[],
  ): SessionHydrationReplayState {
    const latestCheckpoint = this.findLatestCheckpoint(events);
    const replayState: SessionHydrationReplayState = {
      costReplayStartIndex: latestCheckpoint ? latestCheckpoint.index + 1 : 0,
      checkpointTurn: latestCheckpoint ? this.normalizeTurn(latestCheckpoint.turn) : null,
    };
    if (latestCheckpoint) {
      this.costTracker.restore(
        sessionId,
        latestCheckpoint.payload.state.cost,
        latestCheckpoint.payload.state.costSkillLastTurnByName,
      );
    }
    return replayState;
  }

  private createHydrationRun(
    sessionId: string,
    state: RuntimeSessionStateCell,
  ): SessionHydrationRun {
    const issues: SessionHydrationIssue[] = [];
    const callbacks = this.buildHydrationCallbacks();
    return {
      issues,
      callbacks,
      applyContext: {
        sessionId,
        callbacks,
      },
      foldEntries: SessionLifecycleService.hydrationFolds.map((fold) => ({
        fold,
        state: fold.initial(state),
      })),
    };
  }

  private replayHydrationEvents(
    sessionId: string,
    events: BrewvaEventRecord[],
    hydrationRun: SessionHydrationRun,
    replayState: SessionHydrationReplayState,
  ): void {
    for (let index = 0; index < events.length; index += 1) {
      const event = events[index];
      if (!event) continue;
      const foldContext: SessionHydrationFoldContext = {
        sessionId,
        index,
        replayCostTail: index >= replayState.costReplayStartIndex,
        replayCheckpointTurnTransient: this.shouldReplayCheckpointTurnTransient(
          event,
          index,
          replayState,
        ),
        callbacks: hydrationRun.callbacks,
        issues: hydrationRun.issues,
      };
      for (const entry of hydrationRun.foldEntries) {
        applySessionHydrationFold(entry.fold, entry.state, event, foldContext);
      }
    }
  }

  private shouldReplayCheckpointTurnTransient(
    event: BrewvaEventRecord,
    index: number,
    replayState: SessionHydrationReplayState,
  ): boolean {
    if (index >= replayState.costReplayStartIndex || replayState.checkpointTurn === null) {
      return false;
    }
    return (
      this.normalizeTurn(event.turn) === replayState.checkpointTurn &&
      this.isCheckpointTurnCostTransientEvent(event.type)
    );
  }

  private applyHydrationRun(
    state: RuntimeSessionStateCell,
    events: BrewvaEventRecord[],
    hydrationRun: SessionHydrationRun,
  ): void {
    for (const entry of hydrationRun.foldEntries) {
      entry.fold.apply(entry.state, state, hydrationRun.applyContext);
    }
    state.hydration = {
      status: hydrationRun.issues.length > 0 ? "degraded" : "ready",
      latestEventId: events[events.length - 1]?.id,
      hydratedAt: Date.now(),
      issues: hydrationRun.issues,
    };
  }

  private buildHydrationCallbacks(): SessionHydrationFoldCallbacks {
    return {
      replayCostStateEvent: (sessionId, event, payload, options) =>
        this.replayCostStateEvent(sessionId, event, payload, options),
      restoreVerificationState: (sessionId, snapshot) => {
        this.verification.stateStore.clear(sessionId);
        this.verification.stateStore.restore(sessionId, snapshot);
      },
    };
  }

  private findLatestCheckpoint(events: BrewvaEventRecord[]): {
    index: number;
    turn: number;
    payload: NonNullable<ReturnType<typeof coerceTapeCheckpointPayload>>;
  } | null {
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (!event || event.type !== TAPE_CHECKPOINT_EVENT_TYPE) continue;
      const payload = coerceTapeCheckpointPayload(event.payload);
      if (!payload) continue;
      return {
        index,
        turn: this.normalizeTurn(event.turn),
        payload,
      };
    }
    return null;
  }

  private isCheckpointTurnCostTransientEvent(type: string): boolean {
    return type === "tool_call_marked";
  }

  private replayCostStateEvent(
    sessionId: string,
    event: BrewvaEventRecord,
    payload: Record<string, unknown> | null,
    options?: {
      checkpointTurnTransient?: boolean;
    },
  ): void {
    const turn = this.normalizeTurn(event.turn);
    const checkpointTurnTransient = options?.checkpointTurnTransient === true;

    if (event.type === "tool_call_marked") {
      const toolName =
        payload && typeof payload.toolName === "string" ? payload.toolName.trim() : "";
      if (!toolName) return;
      if (checkpointTurnTransient) {
        this.costTracker.restoreToolCallForTurn(sessionId, {
          toolName,
          turn,
        });
      } else {
        this.costTracker.recordToolCall(sessionId, {
          toolName,
          turn,
        });
      }
      return;
    }

    if (event.type !== "cost_update" || !payload) return;
    this.costTracker.applyCostUpdateEvent(sessionId, payload, turn, event.timestamp);
  }

  private normalizeTurn(value: unknown): number {
    if (typeof value !== "number" || !Number.isFinite(value)) return 0;
    return Math.max(0, Math.floor(value));
  }

  private readNonNegativeNumber(value: unknown): number | null {
    if (typeof value !== "number" || !Number.isFinite(value)) return null;
    return Math.max(0, value);
  }
}
