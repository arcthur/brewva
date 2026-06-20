import { sha256Hex } from "@brewva/brewva-std/hash";
import { readAutoCompactionBreakerOpen } from "@brewva/brewva-substrate/context-budget";
import {
  CONTEXT_COMPACTION_AUTO_COMPLETED_EVENT_TYPE,
  CONTEXT_COMPACTION_AUTO_FAILED_EVENT_TYPE,
  type ContextBudgetUsage,
} from "@brewva/brewva-vocabulary/context";
import { RECALL_RESULTS_SURFACED_EVENT_TYPE } from "@brewva/brewva-vocabulary/iteration";
import type {
  SessionCompactionCacheImpact,
  SessionCompactionCacheImpactSnapshot,
  SessionCompactionGenerationMetadata,
  SessionCompactionInputProvenance,
} from "@brewva/brewva-vocabulary/session";
import {
  SOURCE_PATCH_APPLIED_EVENT_TYPE,
  SOURCE_RESOURCE_READ_EVENT_TYPE,
  SOURCE_SNAPSHOT_RECORDED_EVENT_TYPE,
} from "@brewva/brewva-vocabulary/workbench";
import {
  commitRuntimeSessionCompaction,
  getRuntimeCompactionGateStatus,
  getRuntimeContextCompactionInstructions,
  getRuntimeContextEvidenceLatest,
  getRuntimeContextPromptHistoryViewBaseline,
  getRuntimeContextUsage,
  getRuntimeContextUsageRatio,
  getRuntimePendingCompactionReason,
  listRuntimeWorkbenchEntries,
  queryRuntimeEvents,
  type HostedRuntimeAdapterPort,
} from "../session/runtime-ports.js";
import {
  createRuntimeTurnClockStore,
  type RuntimeTurnClockStore,
} from "../turn/runtime-turn-clock.js";
import {
  ATTENTION_METRIC_EVENT_TYPE,
  buildCompactionInputProvenance,
  RECALL_USAGE_EVENT_TYPES,
} from "./compaction-input-provenance.js";
import {
  createContextNudgeCadenceTracker,
  decideAutoCompactionEligibility,
  type ContextNudgeCadenceTracker,
} from "./context-lifecycle.js";
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
  readonly nudgeTracker: ContextNudgeCadenceTracker;
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
      toTokens?: unknown;
      cutPointReason?: unknown;
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

function extractToTokens(compactionEntry: unknown): number | null {
  if (!compactionEntry || typeof compactionEntry !== "object" || Array.isArray(compactionEntry)) {
    return null;
  }
  const value = (compactionEntry as { toTokens?: unknown }).toTokens;
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.max(0, Math.trunc(value))
    : null;
}

function extractCutPointReason(compactionEntry: unknown): string | null {
  if (!compactionEntry || typeof compactionEntry !== "object" || Array.isArray(compactionEntry)) {
    return null;
  }
  const value = (compactionEntry as { cutPointReason?: unknown }).cutPointReason;
  return typeof value === "string" && value.trim().length > 0 ? value : null;
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
  runtime: HostedRuntimeAdapterPort,
  sessionId: string,
): SessionCompactionCacheImpact {
  const sample = getRuntimeContextEvidenceLatest(runtime, sessionId, "provider_cache_observation");
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

function resolveRecallTokenBudget(usage: ContextBudgetUsage | undefined): number | null {
  const tokens =
    typeof usage?.tokens === "number" && Number.isFinite(usage.tokens) && usage.tokens >= 0
      ? usage.tokens
      : null;
  const contextWindow =
    typeof usage?.contextWindow === "number" &&
    Number.isFinite(usage.contextWindow) &&
    usage.contextWindow > 0
      ? usage.contextWindow
      : null;
  if (tokens === null || contextWindow === null) {
    return null;
  }
  return Math.max(0, Math.trunc(contextWindow - tokens));
}

function readEventTimestamp(event: { readonly timestamp?: unknown }): number {
  return typeof event.timestamp === "number" && Number.isFinite(event.timestamp)
    ? event.timestamp
    : 0;
}

function readEventId(event: { readonly id?: unknown }): string {
  return typeof event.id === "string" ? event.id : "";
}

const COMPACTION_INPUT_PROVENANCE_EVENT_TYPES = [
  ...RECALL_USAGE_EVENT_TYPES,
  SOURCE_PATCH_APPLIED_EVENT_TYPE,
  SOURCE_RESOURCE_READ_EVENT_TYPE,
  SOURCE_SNAPSHOT_RECORDED_EVENT_TYPE,
] as const;

function queryCompactionInputProvenanceEvents(input: {
  readonly runtime: HostedRuntimeAdapterPort;
  readonly sessionId: string;
  readonly compactBaseline?: { readonly timestamp?: unknown } | null;
}): ReturnType<typeof queryRuntimeEvents> {
  const baselineTimestamp = input.compactBaseline?.timestamp;
  const since =
    typeof baselineTimestamp === "number" && Number.isFinite(baselineTimestamp)
      ? baselineTimestamp
      : undefined;
  return COMPACTION_INPUT_PROVENANCE_EVENT_TYPES.flatMap((type) =>
    queryRuntimeEvents(input.runtime, input.sessionId, {
      type,
      ...(since === undefined ? {} : { since }),
    }),
  ).toSorted(
    (left, right) =>
      readEventTimestamp(left) - readEventTimestamp(right) ||
      readEventId(left).localeCompare(readEventId(right)),
  );
}

function isAutoCompactionBreakerOpen(
  runtime: HostedRuntimeAdapterPort,
  sessionId: string,
): boolean {
  const events = [
    ...queryRuntimeEvents(runtime, sessionId, {
      type: CONTEXT_COMPACTION_AUTO_FAILED_EVENT_TYPE,
    }),
    ...queryRuntimeEvents(runtime, sessionId, {
      type: CONTEXT_COMPACTION_AUTO_COMPLETED_EVENT_TYPE,
    }),
  ];
  return readAutoCompactionBreakerOpen(events);
}

function buildRuntimeCompactionInputProvenance(input: {
  readonly runtime: HostedRuntimeAdapterPort;
  readonly sessionId: string;
  readonly usage?: ContextBudgetUsage;
}): SessionCompactionInputProvenance {
  const compactBaseline =
    getRuntimeContextPromptHistoryViewBaseline(input.runtime, input.sessionId) ?? null;
  return buildCompactionInputProvenance({
    workbenchEntries: listRuntimeWorkbenchEntries(input.runtime, input.sessionId),
    skillSelection: input.runtime.ops.skills.selection.latest(input.sessionId),
    capabilitySelection: input.runtime.ops.tools.capabilitySelection.latest(input.sessionId),
    recallEvents: queryRuntimeEvents(input.runtime, input.sessionId, {
      type: RECALL_RESULTS_SURFACED_EVENT_TYPE,
    }),
    usageEvents: queryCompactionInputProvenanceEvents({
      runtime: input.runtime,
      sessionId: input.sessionId,
      compactBaseline,
    }),
    attentionEvents: queryRuntimeEvents(input.runtime, input.sessionId, {
      type: ATTENTION_METRIC_EVENT_TYPE,
    }),
    compactBaseline,
    recallTokenBudget: resolveRecallTokenBudget(input.usage),
  });
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
  runtime: HostedRuntimeAdapterPort,
  telemetry: HostedContextTelemetry,
  turnClock: RuntimeTurnClockStore = createRuntimeTurnClockStore(),
  options: HostedCompactionControllerOptions = {},
): HostedCompactionController {
  const gateStateBySession = new Map<string, CompactionGateState>();
  const nudgeTracker = createContextNudgeCadenceTracker();
  const autoCompactionWatchdogMs = Math.max(
    1,
    Math.trunc(options.autoCompactionWatchdogMs ?? DEFAULT_AUTO_COMPACTION_WATCHDOG_MS),
  );
  const getSessionState = (sessionId: string): CompactionGateState => {
    return getOrCreateGateState(gateStateBySession, sessionId);
  };

  return {
    nudgeTracker,
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
      runtime.ops.context.lifecycle.onTurnStart(input.sessionId, runtimeTurn);
    },
    context(input) {
      const state = getSessionState(input.sessionId);
      runtime.ops.context.usage.observe(input.sessionId, input.usage);
      runtime.ops.context.compaction.checkAndRequest(input.sessionId, input.usage);
      const gateStatus = getRuntimeCompactionGateStatus(runtime, input.sessionId, input.usage);
      const pendingReason = getRuntimePendingCompactionReason(runtime, input.sessionId);
      const eligibility = decideAutoCompactionEligibility({
        gateStatus,
        pendingCompactionReason: pendingReason,
        hasUI: input.hasUI,
        idle: input.idle,
        recoveryPosture: "idle",
        autoCompactionInFlight: state.autoCompactionInFlight,
        autoCompactionBreakerOpen: isAutoCompactionBreakerOpen(runtime, input.sessionId),
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
          !runtime.ops.context.compaction.rememberDeferredReason(input.sessionId, pendingReason)
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

      runtime.ops.context.compaction.rememberDeferredReason(input.sessionId, null);

      if (eligibility.decision === "skip" && eligibility.reason === "auto_compaction_in_flight") {
        telemetry.emitCompactionSkipped({
          sessionId: input.sessionId,
          turn: state.turnIndex,
          reason: "auto_compaction_in_flight",
        });
        return;
      }

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
        runtime.ops.context.compaction.rememberDeferredReason(input.sessionId, null);
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
        usagePercent: getRuntimeContextUsageRatio(runtime, input.usage),
        tokens: input.usage?.tokens ?? null,
      });

      const clearInFlight = () => {
        clearAutoCompactionExecutionState(state);
      };
      const recordCompactionFailure = (error: unknown) => {
        if (state.activeAutoCompactionAttemptId !== attemptId) {
          return;
        }
        telemetry.emitAutoFailed({
          sessionId: input.sessionId,
          turn: state.turnIndex,
          reason: compactionReason,
          error: telemetry.normalizeRuntimeError(error),
        });
        runtime.ops.context.compaction.rememberDeferredReason(input.sessionId, null);
        clearInFlight();
      };

      try {
        const compact = input.compact as NonNullable<HostedManualCompact>;
        compact({
          customInstructions: getRuntimeContextCompactionInstructions(runtime),
          onComplete: () => {
            if (state.activeAutoCompactionAttemptId !== attemptId) {
              return;
            }
            clearInFlight();
            runtime.ops.context.compaction.rememberDeferredReason(input.sessionId, null);
            telemetry.emitAutoCompleted({
              sessionId: input.sessionId,
              turn: state.turnIndex,
              reason: compactionReason,
            });
          },
          onError: (error) => {
            recordCompactionFailure(error);
          },
        });
      } catch (error) {
        recordCompactionFailure(error);
      }
    },
    async sessionCompact(input) {
      const state = getSessionState(input.sessionId);
      const previousUsage = getRuntimeContextUsage(runtime, input.sessionId);
      const wasGated = getRuntimeCompactionGateStatus(
        runtime,
        input.sessionId,
        previousUsage,
      ).required;
      clearAutoCompactionExecutionState(state);
      runtime.ops.context.compaction.rememberDeferredReason(input.sessionId, null);
      const sanitizedSummary =
        extractCompactionSummary({
          compactionEntry: input.compactionEntry,
        }) ?? "";
      const compactId =
        extractCompactionEntryId({
          compactionEntry: input.compactionEntry,
        }) ?? `compact:${input.sessionId}:${state.turnIndex}`;
      const toTokens = extractToTokens(input.compactionEntry);
      const cutPointReason = extractCutPointReason(input.compactionEntry);
      const summaryGeneration = extractSummaryGeneration(input.compactionEntry);
      const latestPromptEvidence = getRuntimeContextEvidenceLatest(
        runtime,
        input.sessionId,
        "prompt_stability",
      );
      const referenceContextDigest = readOptionalString(
        latestPromptEvidence?.payload.stablePrefixHash,
      );

      commitRuntimeSessionCompaction(runtime, input.sessionId, {
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
        fromTokens: getRuntimeContextUsage(runtime, input.sessionId)?.tokens ?? null,
        toTokens,
        ...(cutPointReason ? { cutPointReason } : {}),
        origin: input.fromExtension === true ? "extension_api" : "auto_compaction",
        ...(summaryGeneration ? { summaryGeneration } : {}),
        inputProvenance: buildRuntimeCompactionInputProvenance({
          runtime,
          sessionId: input.sessionId,
          usage: input.usage,
        }),
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
      nudgeTracker.clearSession(input.sessionId);
      turnClock.clearSession(input.sessionId);
    },
  };
}
