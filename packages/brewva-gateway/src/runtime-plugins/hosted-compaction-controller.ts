import type { BrewvaRuntime, ContextBudgetUsage } from "@brewva/brewva-runtime";
import { extractCompactionEntryId, extractCompactionSummary } from "./context-shared.js";
import {
  AUTO_COMPACTION_WATCHDOG_ERROR,
  type HostedContextTelemetry,
} from "./hosted-context-telemetry.js";
import { createRuntimeTurnClockStore, type RuntimeTurnClockStore } from "./runtime-turn-clock.js";

export interface HostedManualCompactOptions {
  customInstructions?: string;
  onComplete?: () => void;
  onError?: (error: unknown) => void;
}

export type HostedManualCompact = ((options: HostedManualCompactOptions) => void) | undefined;

export interface HostedContextGateStatePort {
  getTurnIndex: (sessionId: string) => number;
  setLastRuntimeGateRequired: (sessionId: string, required: boolean) => void;
}

export interface HostedCompactionController extends HostedContextGateStatePort {
  turnStart: (input: { sessionId: string; turnIndex: number; timestamp: number }) => void;
  context: (input: {
    sessionId: string;
    usage?: ContextBudgetUsage;
    hasUI: boolean;
    idle: boolean;
    compact: HostedManualCompact;
  }) => void;
  sessionCompact: (input: {
    sessionId: string;
    usage?: ContextBudgetUsage;
    compactionEntry?: {
      id?: unknown;
      summary?: unknown;
      content?: unknown;
      text?: unknown;
    };
    fromExtension?: unknown;
  }) => void;
  sessionShutdown: (input: { sessionId: string }) => void;
}

export interface HostedCompactionControllerOptions {
  autoCompactionWatchdogMs?: number;
}

interface CompactionGateState {
  turnIndex: number;
  lastRuntimeGateRequired: boolean;
  autoCompactionInFlight: boolean;
  autoCompactionWatchdog: ReturnType<typeof setTimeout> | null;
  deferredAutoCompactionReason: string | null;
}

export const DEFAULT_AUTO_COMPACTION_WATCHDOG_MS = 30_000;

function getOrCreateGateState(
  store: Map<string, CompactionGateState>,
  sessionId: string,
): CompactionGateState {
  const existing = store.get(sessionId);
  if (existing) {
    return existing;
  }
  const created: CompactionGateState = {
    turnIndex: 0,
    lastRuntimeGateRequired: false,
    autoCompactionInFlight: false,
    autoCompactionWatchdog: null,
    deferredAutoCompactionReason: null,
  };
  store.set(sessionId, created);
  return created;
}

function clearAutoCompactionState(state: CompactionGateState): void {
  state.autoCompactionInFlight = false;
  state.deferredAutoCompactionReason = null;
  if (state.autoCompactionWatchdog) {
    clearTimeout(state.autoCompactionWatchdog);
    state.autoCompactionWatchdog = null;
  }
}

export function createHostedCompactionController(
  runtime: BrewvaRuntime,
  telemetry: HostedContextTelemetry,
  turnClock: RuntimeTurnClockStore = createRuntimeTurnClockStore(),
  options: HostedCompactionControllerOptions = {},
): HostedCompactionController {
  const gateStateBySession = new Map<string, CompactionGateState>();
  const autoCompactionWatchdogMs = Math.max(
    1,
    Math.trunc(options.autoCompactionWatchdogMs ?? DEFAULT_AUTO_COMPACTION_WATCHDOG_MS),
  );

  return {
    getTurnIndex(sessionId) {
      return getOrCreateGateState(gateStateBySession, sessionId).turnIndex;
    },
    setLastRuntimeGateRequired(sessionId, required) {
      getOrCreateGateState(gateStateBySession, sessionId).lastRuntimeGateRequired = required;
    },
    turnStart(input) {
      const state = getOrCreateGateState(gateStateBySession, input.sessionId);
      const runtimeTurn = turnClock.observeTurnStart(
        input.sessionId,
        input.turnIndex,
        input.timestamp,
      );
      state.turnIndex = runtimeTurn;
      runtime.context.onTurnStart(input.sessionId, runtimeTurn);
    },
    context(input) {
      const state = getOrCreateGateState(gateStateBySession, input.sessionId);
      runtime.context.observeUsage(input.sessionId, input.usage);

      if (!runtime.context.checkAndRequestCompaction(input.sessionId, input.usage)) {
        return;
      }

      if (input.hasUI) {
        if (!input.idle) {
          const pendingReason =
            runtime.context.getPendingCompactionReason(input.sessionId) ?? "usage_threshold";
          if (state.deferredAutoCompactionReason === pendingReason) {
            return;
          }
          state.deferredAutoCompactionReason = pendingReason;
          telemetry.emitCompactionSkipped({
            sessionId: input.sessionId,
            turn: state.turnIndex,
            reason: "agent_active_manual_compaction_unsafe",
          });
          return;
        }

        state.deferredAutoCompactionReason = null;

        if (state.autoCompactionInFlight) {
          telemetry.emitCompactionSkipped({
            sessionId: input.sessionId,
            turn: state.turnIndex,
            reason: "auto_compaction_in_flight",
          });
          return;
        }

        const pendingReason = runtime.context.getPendingCompactionReason(input.sessionId);
        const compactionReason = pendingReason ?? "usage_threshold";
        state.autoCompactionInFlight = true;
        if (state.autoCompactionWatchdog) {
          clearTimeout(state.autoCompactionWatchdog);
        }
        state.autoCompactionWatchdog = setTimeout(() => {
          if (!state.autoCompactionInFlight) {
            return;
          }
          clearAutoCompactionState(state);
          telemetry.emitAutoFailed({
            sessionId: input.sessionId,
            turn: state.turnIndex,
            reason: compactionReason,
            error: AUTO_COMPACTION_WATCHDOG_ERROR,
            watchdogMs: autoCompactionWatchdogMs,
          });
        }, autoCompactionWatchdogMs);

        telemetry.emitAutoRequested({
          sessionId: input.sessionId,
          turn: state.turnIndex,
          reason: compactionReason,
          usagePercent: runtime.context.getUsageRatio(input.usage),
          tokens: input.usage?.tokens ?? null,
        });

        const clearInFlight = () => {
          clearAutoCompactionState(state);
        };
        const recordAutoFailure = (error: unknown) => {
          telemetry.emitAutoFailed({
            sessionId: input.sessionId,
            turn: state.turnIndex,
            reason: compactionReason,
            error: telemetry.normalizeRuntimeError(error),
          });
        };

        try {
          const compact = input.compact as NonNullable<HostedManualCompact>;
          compact({
            customInstructions: runtime.context.getCompactionInstructions(),
            onComplete: () => {
              clearInFlight();
              telemetry.emitAutoCompleted({
                sessionId: input.sessionId,
                turn: state.turnIndex,
                reason: compactionReason,
              });
            },
            onError: (error) => {
              clearInFlight();
              recordAutoFailure(error);
            },
          });
        } catch (error) {
          clearInFlight();
          recordAutoFailure(error);
        }

        return;
      }

      telemetry.emitCompactionSkipped({
        sessionId: input.sessionId,
        turn: state.turnIndex,
        reason: "non_interactive_mode",
      });
    },
    sessionCompact(input) {
      const state = getOrCreateGateState(gateStateBySession, input.sessionId);
      const wasGated = state.lastRuntimeGateRequired;
      state.lastRuntimeGateRequired = false;
      clearAutoCompactionState(state);

      runtime.context.markCompacted(input.sessionId, {
        fromTokens: null,
        toTokens: input.usage?.tokens ?? null,
        summary: extractCompactionSummary({
          compactionEntry: input.compactionEntry,
        }),
        entryId: extractCompactionEntryId({
          compactionEntry: input.compactionEntry,
        }),
      });

      telemetry.emitSessionCompact({
        sessionId: input.sessionId,
        turn: state.turnIndex,
        entryId: typeof input.compactionEntry?.id === "string" ? input.compactionEntry.id : null,
        fromExtension: input.fromExtension === true ? true : undefined,
      });

      if (wasGated) {
        telemetry.emitGateCleared({
          sessionId: input.sessionId,
          turn: state.turnIndex,
          reason: "session_compact_performed",
        });
      }
    },
    sessionShutdown(input) {
      const state = gateStateBySession.get(input.sessionId);
      if (state) {
        clearAutoCompactionState(state);
      }
      gateStateBySession.delete(input.sessionId);
      turnClock.clearSession(input.sessionId);
    },
  };
}
