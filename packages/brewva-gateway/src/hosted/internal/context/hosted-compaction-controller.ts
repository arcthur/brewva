import type { BrewvaHostedRuntimePort } from "@brewva/brewva-runtime";
import type {
  ContextBudgetUsage,
  SessionCompactionCacheImpact,
  SessionCompactionCacheImpactSnapshot,
  SessionCompactionGenerationMetadata,
} from "@brewva/brewva-runtime/context";
import { sha256Hex } from "@brewva/brewva-std/hash";
import { decideCompaction } from "../compaction/policy.js";
import {
  createRuntimeTurnClockStore,
  type RuntimeTurnClockStore,
} from "../thread-loop/lifecycle/runtime-turn-clock.js";
import {
  extractCompactionEntryId,
  extractCompactionSummary,
  resolveContextScopeId,
} from "./context-shared.js";
import {
  AUTO_COMPACTION_WATCHDOG_ERROR,
  type HostedContextTelemetry,
} from "./hosted-context-telemetry.js";

export interface HostedManualCompactOptions {
  customInstructions?: string;
  onComplete?: () => void;
  onError?: (error: unknown) => void;
}

export type HostedManualCompact = ((options: HostedManualCompactOptions) => void) | undefined;

export interface HostedContextGateStatePort {
  getTurnIndex: (sessionId: string) => number;
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
      firstKeptEntryId?: unknown;
      summaryGeneration?: unknown;
    };
    fromExtension?: unknown;
  }) => Promise<void>;
  sessionShutdown: (input: { sessionId: string }) => void;
}

export interface HostedCompactionControllerOptions {
  autoCompactionWatchdogMs?: number;
}

interface CompactionGateState {
  turnIndex: number;
  autoCompactionInFlight: boolean;
  autoCompactionWatchdog: ReturnType<typeof setTimeout> | null;
  autoCompactionAttemptId: number;
  activeAutoCompactionAttemptId: number | null;
}

export const DEFAULT_AUTO_COMPACTION_WATCHDOG_MS = 30_000;
export const AUTO_COMPACTION_BREAKER_THRESHOLD = 3;

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

function extractFirstKeptEntryId(input: unknown): string | null {
  const compactionEntry = (
    input as { compactionEntry?: { firstKeptEntryId?: unknown } } | undefined
  )?.compactionEntry;
  if (!compactionEntry || typeof compactionEntry.firstKeptEntryId !== "string") {
    return null;
  }
  const normalized = compactionEntry.firstKeptEntryId.trim();
  return normalized.length > 0 ? normalized : null;
}

function extractSummaryGeneration(
  compactionEntry: unknown,
): SessionCompactionGenerationMetadata | undefined {
  if (!compactionEntry || typeof compactionEntry !== "object" || Array.isArray(compactionEntry)) {
    return undefined;
  }
  const summaryGeneration = (compactionEntry as { summaryGeneration?: unknown }).summaryGeneration;
  if (
    !summaryGeneration ||
    typeof summaryGeneration !== "object" ||
    Array.isArray(summaryGeneration)
  ) {
    return undefined;
  }
  const strategy = (summaryGeneration as { strategy?: unknown }).strategy;
  if (typeof strategy !== "string" || strategy.trim().length === 0) {
    return undefined;
  }
  return summaryGeneration as SessionCompactionGenerationMetadata;
}

function readOptionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readNonNegativeInteger(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

function buildCompactionCacheImpact(
  runtime: BrewvaHostedRuntimePort,
  sessionId: string,
): SessionCompactionCacheImpact {
  const sample = runtime.inspect.context.evidence.latest(sessionId, "provider_cache_observation");
  const payload = sample?.payload;
  const before: SessionCompactionCacheImpactSnapshot | null = payload
    ? {
        cacheReadTokens: readNonNegativeInteger(payload.cacheReadTokens),
        cacheWriteTokens: readNonNegativeInteger(payload.cacheWriteTokens),
        bucketKey: readOptionalString(payload.bucketKey),
        stablePrefixHash: readOptionalString(payload.stablePrefixHash),
        dynamicTailHash: readOptionalString(payload.dynamicTailHash),
        visibleHistoryReductionHash: readOptionalString(payload.visibleHistoryReductionHash),
        workbenchContextHash: readOptionalString(payload.workbenchContextHash),
      }
    : null;
  return {
    before,
    after: null,
    explicitEpochChanges: 1,
    prefixBytesChanged: null,
    degradedReason: null,
  };
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
    turnIndex: 0,
    autoCompactionInFlight: false,
    autoCompactionWatchdog: null,
    autoCompactionAttemptId: 0,
    activeAutoCompactionAttemptId: null,
  };
  store.set(sessionId, created);
  return created;
}

function clearAutoCompactionExecutionState(state: CompactionGateState): void {
  state.autoCompactionInFlight = false;
  state.activeAutoCompactionAttemptId = null;
  if (state.autoCompactionWatchdog) {
    clearTimeout(state.autoCompactionWatchdog);
    state.autoCompactionWatchdog = null;
  }
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
  const getSessionState = (sessionId: string): CompactionGateState => {
    return getOrCreateGateState(gateStateBySession, sessionId);
  };

  return {
    getTurnIndex(sessionId) {
      return getSessionState(sessionId).turnIndex;
    },
    turnStart(input) {
      const state = getSessionState(input.sessionId);
      const runtimeTurn = turnClock.observeTurnStart(
        input.sessionId,
        input.turnIndex,
        input.timestamp,
      );
      state.turnIndex = runtimeTurn;
      runtime.operator.context.lifecycle.onTurnStart(input.sessionId, runtimeTurn);
    },
    context(input) {
      const state = getSessionState(input.sessionId);
      runtime.operator.context.usage.observe(input.sessionId, input.usage);
      runtime.operator.context.compaction.checkAndRequest(input.sessionId, input.usage);
      const gateStatus = runtime.inspect.context.compaction.getGateStatus(
        input.sessionId,
        input.usage,
      );
      const autoPolicy = runtime.inspect.context.compaction.getAutoPolicyState(input.sessionId);
      const pendingReason = runtime.inspect.context.compaction.getPendingReason(input.sessionId);
      const eligibility = decideCompaction({
        caller: "auto",
        gateStatus,
        pendingReason,
        hasUI: input.hasUI,
        idle: input.idle,
        recoveryPosture: "idle",
        autoCompactionInFlight: state.autoCompactionInFlight,
        autoCompactionBreakerOpen: autoPolicy.breakerOpen,
      });

      if (eligibility.decision === "skip" && eligibility.reason === "no_request") {
        return;
      }

      if (eligibility.decision === "skip" && eligibility.reason === "non_interactive_mode") {
        telemetry.emitCompactionSkipped({
          sessionId: input.sessionId,
          turn: state.turnIndex,
          reason: "non_interactive_mode",
        });
        return;
      }

      if (
        eligibility.decision === "skip" &&
        eligibility.reason === "agent_active_manual_compaction_unsafe"
      ) {
        if (
          !runtime.operator.context.compaction.rememberDeferredReason(
            input.sessionId,
            pendingReason,
          )
        ) {
          return;
        }
        telemetry.emitCompactionSkipped({
          sessionId: input.sessionId,
          turn: state.turnIndex,
          reason: "agent_active_manual_compaction_unsafe",
        });
        return;
      }

      runtime.operator.context.compaction.rememberDeferredReason(input.sessionId, null);

      if (
        eligibility.decision === "skip" &&
        eligibility.reason === "auto_compaction_breaker_open"
      ) {
        telemetry.emitCompactionSkipped({
          sessionId: input.sessionId,
          turn: state.turnIndex,
          reason: "auto_compaction_breaker_open",
        });
        return;
      }

      if (eligibility.decision === "skip" && eligibility.reason === "auto_compaction_in_flight") {
        telemetry.emitCompactionSkipped({
          sessionId: input.sessionId,
          turn: state.turnIndex,
          reason: "auto_compaction_in_flight",
        });
        return;
      }

      if (eligibility.decision !== "execute") {
        return;
      }

      const compactionReason = eligibility.reason;
      state.autoCompactionAttemptId += 1;
      const attemptId = state.autoCompactionAttemptId;
      state.autoCompactionInFlight = true;
      state.activeAutoCompactionAttemptId = attemptId;
      if (state.autoCompactionWatchdog) {
        clearTimeout(state.autoCompactionWatchdog);
      }
      state.autoCompactionWatchdog = setTimeout(() => {
        if (!state.autoCompactionInFlight || state.activeAutoCompactionAttemptId !== attemptId) {
          return;
        }
        clearAutoCompactionExecutionState(state);
        runtime.operator.context.compaction.recordAutoFailure(input.sessionId);
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
        usagePercent: runtime.inspect.context.usage.getRatio(input.usage),
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
        runtime.operator.context.compaction.recordAutoFailure(input.sessionId);
        clearInFlight();
      };

      try {
        const compact = input.compact as NonNullable<HostedManualCompact>;
        compact({
          customInstructions: runtime.inspect.context.compaction.getInstructions(),
          onComplete: () => {
            if (state.activeAutoCompactionAttemptId !== attemptId) {
              return;
            }
            clearInFlight();
            runtime.operator.context.compaction.recordAutoSuccess(input.sessionId);
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
    async sessionCompact(input) {
      const state = getSessionState(input.sessionId);
      const previousUsage = runtime.inspect.context.usage.get(input.sessionId);
      const wasGated = runtime.inspect.context.compaction.getGateStatus(
        input.sessionId,
        previousUsage,
      ).required;
      clearAutoCompactionExecutionState(state);
      runtime.operator.context.compaction.recordAutoSuccess(input.sessionId);
      const sanitizedSummary =
        extractCompactionSummary({
          compactionEntry: input.compactionEntry,
        }) ?? "";
      const compactId =
        extractCompactionEntryId({
          compactionEntry: input.compactionEntry,
        }) ?? `compact:${input.sessionId}:${state.turnIndex}`;
      const toTokens = normalizeUsageTokens(input.usage);
      const summaryGeneration = extractSummaryGeneration(input.compactionEntry);
      const latestPromptEvidence = runtime.inspect.context.evidence.latest(
        input.sessionId,
        "prompt_stability",
      );
      const referenceContextDigest = readOptionalString(
        latestPromptEvidence?.payload.stablePrefixHash,
      );

      await runtime.authority.session.compaction.commit(input.sessionId, {
        compactId,
        sanitizedSummary,
        summaryDigest: sha256Hex(sanitizedSummary),
        sourceTurn: state.turnIndex,
        leafEntryId:
          extractSourceLeafEntryId({
            compactionEntry: input.compactionEntry,
          }) ??
          resolveContextScopeId(input.sessionManager) ??
          null,
        firstKeptEntryId: extractFirstKeptEntryId({
          compactionEntry: input.compactionEntry,
        }),
        referenceContextDigest,
        fromTokens: runtime.inspect.context.usage.get(input.sessionId)?.tokens ?? null,
        toTokens,
        origin: input.fromExtension === true ? "extension_api" : "auto_compaction",
        ...(summaryGeneration ? { summaryGeneration } : {}),
        cacheImpact: buildCompactionCacheImpact(runtime, input.sessionId),
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
        clearAutoCompactionExecutionState(state);
      }
      gateStateBySession.delete(input.sessionId);
      turnClock.clearSession(input.sessionId);
    },
  };
}
