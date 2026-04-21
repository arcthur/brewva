import type { RecoveryWalStore } from "../channels/recovery-wal.js";
import type { ContextBudgetManager } from "../context/budget.js";
import type { ContextInjectionCollector } from "../context/injection.js";
import type {
  IntegrityStatus,
  OpenToolCallRecord,
  SessionHydrationState,
  SessionUncleanShutdownDiagnostic,
} from "../contracts/index.js";
import type { SessionCostTracker } from "../cost/tracker.js";
import type { BrewvaEventStore } from "../events/store.js";
import type { ParallelBudgetManager } from "../parallel/budget.js";
import type { ParallelResultStore } from "../parallel/results.js";
import { deriveParallelBudgetStateFromEvents } from "../parallel/state.js";
import type { ProjectionEngine } from "../projection/engine.js";
import type { RuntimeKernelContext } from "../runtime-kernel.js";
import type { FileChangeTracker } from "../state/file-change-tracker.js";
import type { TurnReplayEngine } from "../tape/replay-engine.js";
import type { VerificationGate } from "../verification/gate.js";
import type { ContextService } from "./context.js";
import type { ReversibleMutationService } from "./reversible-mutation.js";
import { SessionHydrationCoordinator } from "./session-hydration-coordinator.js";
import { SessionIntegrityCoordinator } from "./session-integrity-coordinator.js";
import { RuntimeSessionStateStore } from "./session-state.js";

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
  recoveryWalStore: RecoveryWalStore;
  reversibleMutationService: ReversibleMutationService;
  recordEvent: RuntimeKernelContext["recordEvent"];
  contextService: Pick<ContextService, "clearReservedInjectionTokensForSession">;
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
  private readonly reversibleMutations: ReversibleMutationService;
  private readonly hydrationCoordinator: SessionHydrationCoordinator;
  private readonly integrityCoordinator: SessionIntegrityCoordinator;
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
    this.reversibleMutations = options.reversibleMutationService;
    this.hydrationCoordinator = new SessionHydrationCoordinator({
      costTracker: this.costTracker,
      verificationGate: this.verification,
    });
    this.integrityCoordinator = new SessionIntegrityCoordinator({
      sessionState: this.sessionState,
      eventStore: options.eventStore,
      recoveryWalStore: options.recoveryWalStore,
      recordEvent: (input) => options.recordEvent(input),
    });
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
    this.integrityCoordinator.refreshHydrationState(sessionId);
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
      issues: structuredClone(hydration.issues),
    };
  }

  getIntegrityStatus(sessionId: string): IntegrityStatus {
    return this.integrityCoordinator.getIntegrityStatus(sessionId);
  }

  getOpenToolCalls(sessionId: string): OpenToolCallRecord[] {
    this.ensureHydrated(sessionId);
    return [...(this.sessionState.getExistingCell(sessionId)?.openToolCalls.values() ?? [])].map(
      (record) => Object.assign({}, record),
    );
  }

  getUncleanShutdownDiagnostic(sessionId: string): SessionUncleanShutdownDiagnostic | undefined {
    this.ensureHydrated(sessionId);
    const diagnostic = this.sessionState.getExistingCell(sessionId)?.uncleanShutdownDiagnostic;
    return diagnostic ? structuredClone(diagnostic) : undefined;
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
  }

  private hydrateSessionStateFromEvents(sessionId: string): void {
    const state = this.sessionState.getCell(sessionId);
    if (state.hydration.status !== "cold") return;

    const events = this.events.list(sessionId);
    const integrityIssues = this.events.getIntegrityIssues(sessionId);
    this.resetHydrationSupportStores(sessionId);
    this.integrityCoordinator.canonicalizeBeforeHydration({
      sessionId,
      events,
      integrityIssues,
    });
    const parallelBudgetState = deriveParallelBudgetStateFromEvents(events);
    this.parallel.restoreSession(sessionId, {
      activeRunIds: parallelBudgetState.activeRunIds,
      totalStarted: parallelBudgetState.totalStarted,
    });
    state.parallelBudgetHydrated = true;
    state.parallelBudgetLatestEventId = parallelBudgetState.latestEventId;
    if (events.length === 0) {
      state.hydration = {
        status: integrityIssues.length > 0 ? "degraded" : "ready",
        hydratedAt: Date.now(),
        issues: integrityIssues,
      };
      return;
    }

    this.reversibleMutations.restoreFromEvents(sessionId, events);
    this.hydrationCoordinator.hydrate({
      sessionId,
      state,
      events,
      initialIssues: integrityIssues,
    });
    this.integrityCoordinator.reconcileHydratedSession({
      sessionId,
      events,
      state,
      initialIssues: integrityIssues,
    });
  }

  private resetHydrationSupportStores(sessionId: string): void {
    this.costTracker.clear(sessionId);
    this.verification.stateStore.clear(sessionId);
    this.reversibleMutations.clear(sessionId);
    this.parallel.clear(sessionId);
  }
}
