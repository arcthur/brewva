import { createHash } from "node:crypto";
import type { BrewvaHostedRuntimePort, ContextBudgetUsage } from "@brewva/brewva-runtime";
import {
  extractCompactionEntryId,
  extractCompactionSummary,
  resolveInjectionScopeId,
} from "./context-shared.js";
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
    sessionManager?: {
      getLeafId?: () => string | null | undefined;
    };
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

type CompactionLadderStep =
  | "no_request"
  | "non_interactive_mode"
  | "agent_active_manual_compaction_unsafe"
  | "auto_compaction_breaker_open"
  | "auto_compaction_in_flight"
  | "execute_auto_compaction";

interface CompactionLadderDecision {
  step: CompactionLadderStep;
  compactionReason: string | null;
}

interface CompactionGateState {
  hydrated: boolean;
  turnIndex: number;
  lastObservedUsageTokens: number | null;
  lastRuntimeGateRequired: boolean;
  autoCompactionInFlight: boolean;
  autoCompactionWatchdog: ReturnType<typeof setTimeout> | null;
  autoCompactionAttemptId: number;
  activeAutoCompactionAttemptId: number | null;
  autoCompactionConsecutiveFailures: number;
  autoCompactionBreakerOpen: boolean;
  autoCompactionBreakerSkipReason: string | null;
  deferredAutoCompactionReason: string | null;
}

export const DEFAULT_AUTO_COMPACTION_WATCHDOG_MS = 30_000;
export const AUTO_COMPACTION_BREAKER_THRESHOLD = 3;

const AUTO_COMPACTION_COMPLETED_EVENT_TYPE = "context_compaction_auto_completed";
const AUTO_COMPACTION_FAILED_EVENT_TYPE = "context_compaction_auto_failed";
const SESSION_COMPACT_EVENT_TYPE = "session_compact";

function normalizeUsageTokens(usage: ContextBudgetUsage | undefined): number | null {
  return typeof usage?.tokens === "number" && Number.isFinite(usage.tokens) && usage.tokens >= 0
    ? Math.max(0, Math.trunc(usage.tokens))
    : null;
}

function extractSourceLeafEntryId(input: unknown): string | null {
  const compactionEntry = (
    input as { compactionEntry?: { sourceLeafEntryId?: unknown } } | undefined
  )?.compactionEntry;
  if (!compactionEntry || typeof compactionEntry.sourceLeafEntryId !== "string") {
    return null;
  }
  const normalized = compactionEntry.sourceLeafEntryId.trim();
  return normalized.length > 0 ? normalized : null;
}

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function getOrCreateGateState(
  store: Map<string, CompactionGateState>,
  sessionId: string,
): CompactionGateState {
  const existing = store.get(sessionId);
  if (existing) {
    return existing;
  }
  const created: CompactionGateState = {
    hydrated: false,
    turnIndex: 0,
    lastObservedUsageTokens: null,
    lastRuntimeGateRequired: false,
    autoCompactionInFlight: false,
    autoCompactionWatchdog: null,
    autoCompactionAttemptId: 0,
    activeAutoCompactionAttemptId: null,
    autoCompactionConsecutiveFailures: 0,
    autoCompactionBreakerOpen: false,
    autoCompactionBreakerSkipReason: null,
    deferredAutoCompactionReason: null,
  };
  store.set(sessionId, created);
  return created;
}

function clearAutoCompactionExecutionState(state: CompactionGateState): void {
  state.autoCompactionInFlight = false;
  state.deferredAutoCompactionReason = null;
  state.activeAutoCompactionAttemptId = null;
  if (state.autoCompactionWatchdog) {
    clearTimeout(state.autoCompactionWatchdog);
    state.autoCompactionWatchdog = null;
  }
}

function resetAutoCompactionBreaker(state: CompactionGateState): void {
  state.autoCompactionConsecutiveFailures = 0;
  state.autoCompactionBreakerOpen = false;
  state.autoCompactionBreakerSkipReason = null;
}

function recordAutoCompactionFailure(state: CompactionGateState): void {
  state.autoCompactionConsecutiveFailures += 1;
  state.autoCompactionBreakerSkipReason = null;
  if (state.autoCompactionConsecutiveFailures >= AUTO_COMPACTION_BREAKER_THRESHOLD) {
    state.autoCompactionBreakerOpen = true;
  }
}

function resolveCompactionLadderDecision(input: {
  runtime: BrewvaHostedRuntimePort;
  sessionId: string;
  usage?: ContextBudgetUsage;
  hasUI: boolean;
  idle: boolean;
  state: CompactionGateState;
}): CompactionLadderDecision {
  if (!input.runtime.maintain.context.checkAndRequestCompaction(input.sessionId, input.usage)) {
    return {
      step: "no_request",
      compactionReason: null,
    };
  }

  const compactionReason =
    input.runtime.inspect.context.getPendingCompactionReason(input.sessionId) ?? "usage_threshold";

  if (!input.hasUI) {
    return {
      step: "non_interactive_mode",
      compactionReason,
    };
  }

  if (!input.idle) {
    return {
      step: "agent_active_manual_compaction_unsafe",
      compactionReason,
    };
  }

  if (input.state.autoCompactionBreakerOpen) {
    return {
      step: "auto_compaction_breaker_open",
      compactionReason,
    };
  }

  if (input.state.autoCompactionInFlight) {
    return {
      step: "auto_compaction_in_flight",
      compactionReason,
    };
  }

  return {
    step: "execute_auto_compaction",
    compactionReason,
  };
}

export function createHostedCompactionController(
  runtime: BrewvaHostedRuntimePort,
  telemetry: HostedContextTelemetry,
  turnClock: RuntimeTurnClockStore = createRuntimeTurnClockStore(),
  options: HostedCompactionControllerOptions = {},
): HostedCompactionController {
  const gateStateBySession = new Map<string, CompactionGateState>();
  const autoCompactionWatchdogMs = Math.max(
    1,
    Math.trunc(options.autoCompactionWatchdogMs ?? DEFAULT_AUTO_COMPACTION_WATCHDOG_MS),
  );
  const queryStructured = runtime.inspect.events.queryStructured.bind(runtime.inspect.events);

  const ensureHydrated = (sessionId: string, state: CompactionGateState): void => {
    if (state.hydrated) {
      return;
    }
    state.hydrated = true;
    const events = queryStructured(sessionId);
    for (const event of events) {
      if (event.type === AUTO_COMPACTION_FAILED_EVENT_TYPE) {
        recordAutoCompactionFailure(state);
        continue;
      }
      if (
        event.type === AUTO_COMPACTION_COMPLETED_EVENT_TYPE ||
        event.type === SESSION_COMPACT_EVENT_TYPE
      ) {
        resetAutoCompactionBreaker(state);
      }
    }
  };

  const getSessionState = (sessionId: string): CompactionGateState => {
    const state = getOrCreateGateState(gateStateBySession, sessionId);
    ensureHydrated(sessionId, state);
    return state;
  };

  return {
    getTurnIndex(sessionId) {
      return getSessionState(sessionId).turnIndex;
    },
    setLastRuntimeGateRequired(sessionId, required) {
      getSessionState(sessionId).lastRuntimeGateRequired = required;
    },
    turnStart(input) {
      const state = getSessionState(input.sessionId);
      const runtimeTurn = turnClock.observeTurnStart(
        input.sessionId,
        input.turnIndex,
        input.timestamp,
      );
      state.turnIndex = runtimeTurn;
      runtime.maintain.context.onTurnStart(input.sessionId, runtimeTurn);
    },
    context(input) {
      const state = getSessionState(input.sessionId);
      state.lastObservedUsageTokens = normalizeUsageTokens(input.usage);
      runtime.maintain.context.observeUsage(input.sessionId, input.usage);
      const decision = resolveCompactionLadderDecision({
        runtime,
        sessionId: input.sessionId,
        usage: input.usage,
        hasUI: input.hasUI,
        idle: input.idle,
        state,
      });

      if (decision.step === "no_request") {
        return;
      }

      if (decision.step === "non_interactive_mode") {
        telemetry.emitCompactionSkipped({
          sessionId: input.sessionId,
          turn: state.turnIndex,
          reason: "non_interactive_mode",
        });
        return;
      }

      if (decision.step === "agent_active_manual_compaction_unsafe") {
        if (state.deferredAutoCompactionReason === decision.compactionReason) {
          return;
        }
        state.deferredAutoCompactionReason = decision.compactionReason;
        telemetry.emitCompactionSkipped({
          sessionId: input.sessionId,
          turn: state.turnIndex,
          reason: "agent_active_manual_compaction_unsafe",
        });
        return;
      }

      state.deferredAutoCompactionReason = null;

      if (decision.step === "auto_compaction_breaker_open") {
        if (state.autoCompactionBreakerSkipReason !== decision.compactionReason) {
          state.autoCompactionBreakerSkipReason = decision.compactionReason;
          telemetry.emitCompactionSkipped({
            sessionId: input.sessionId,
            turn: state.turnIndex,
            reason: "auto_compaction_breaker_open",
          });
        }
        return;
      }

      if (decision.step === "auto_compaction_in_flight") {
        telemetry.emitCompactionSkipped({
          sessionId: input.sessionId,
          turn: state.turnIndex,
          reason: "auto_compaction_in_flight",
        });
        return;
      }

      const compactionReason = decision.compactionReason ?? "usage_threshold";
      state.autoCompactionAttemptId += 1;
      const attemptId = state.autoCompactionAttemptId;
      state.autoCompactionInFlight = true;
      state.activeAutoCompactionAttemptId = attemptId;
      state.autoCompactionBreakerSkipReason = null;
      if (state.autoCompactionWatchdog) {
        clearTimeout(state.autoCompactionWatchdog);
      }
      state.autoCompactionWatchdog = setTimeout(() => {
        if (!state.autoCompactionInFlight || state.activeAutoCompactionAttemptId !== attemptId) {
          return;
        }
        clearAutoCompactionExecutionState(state);
        recordAutoCompactionFailure(state);
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
        usagePercent: runtime.inspect.context.getUsageRatio(input.usage),
        tokens: input.usage?.tokens ?? null,
      });

      const clearInFlight = () => {
        clearAutoCompactionExecutionState(state);
      };
      const recordAutoFailure = (error: unknown) => {
        if (state.activeAutoCompactionAttemptId !== attemptId) {
          return;
        }
        telemetry.emitAutoFailed({
          sessionId: input.sessionId,
          turn: state.turnIndex,
          reason: compactionReason,
          error: telemetry.normalizeRuntimeError(error),
        });
        recordAutoCompactionFailure(state);
        clearInFlight();
      };

      try {
        const compact = input.compact as NonNullable<HostedManualCompact>;
        compact({
          customInstructions: runtime.inspect.context.getCompactionInstructions(),
          onComplete: () => {
            if (state.activeAutoCompactionAttemptId !== attemptId) {
              return;
            }
            clearInFlight();
            resetAutoCompactionBreaker(state);
            telemetry.emitAutoCompleted({
              sessionId: input.sessionId,
              turn: state.turnIndex,
              reason: compactionReason,
            });
          },
          onError: (error) => {
            recordAutoFailure(error);
          },
        });
      } catch (error) {
        recordAutoFailure(error);
      }
    },
    sessionCompact(input) {
      const state = getSessionState(input.sessionId);
      const wasGated = state.lastRuntimeGateRequired;
      state.lastRuntimeGateRequired = false;
      clearAutoCompactionExecutionState(state);
      resetAutoCompactionBreaker(state);
      const sanitizedSummary =
        extractCompactionSummary({
          compactionEntry: input.compactionEntry,
        }) ?? "";
      const compactId =
        extractCompactionEntryId({
          compactionEntry: input.compactionEntry,
        }) ?? `compact:${input.sessionId}:${state.turnIndex}`;
      const toTokens = normalizeUsageTokens(input.usage);

      runtime.authority.session.commitCompaction(input.sessionId, {
        compactId,
        sanitizedSummary,
        summaryDigest: sha256(sanitizedSummary),
        sourceTurn: state.turnIndex,
        leafEntryId:
          extractSourceLeafEntryId({
            compactionEntry: input.compactionEntry,
          }) ??
          resolveInjectionScopeId(input.sessionManager) ??
          null,
        referenceContextDigest:
          runtime.inspect.context.getPromptStability(input.sessionId)?.stablePrefixHash ?? null,
        fromTokens: state.lastObservedUsageTokens,
        toTokens,
        origin: input.fromExtension === true ? "extension_api" : "auto_compaction",
      });
      state.lastObservedUsageTokens = toTokens;

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
        clearAutoCompactionExecutionState(state);
      }
      gateStateBySession.delete(input.sessionId);
      turnClock.clearSession(input.sessionId);
    },
  };
}

export const HOSTED_COMPACTION_LADDER_TEST_ONLY = {
  resolveCompactionLadderDecision,
};
