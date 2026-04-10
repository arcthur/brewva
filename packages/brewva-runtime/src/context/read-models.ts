import type {
  ContextBudgetUsage,
  RecoveryPostureSnapshot,
  RecoveryWorkingSetSnapshot,
} from "../contracts/index.js";
import {
  deriveOpenToolCallsFromEvents,
  deriveRecoveryPosture,
  deriveRecoveryWorkingSet,
} from "../recovery/read-model.js";
import type { RuntimeKernelContext } from "../runtime-kernel.js";
import { deriveHistoryViewBaselineState } from "./history-view-baseline.js";
import { CONTEXT_SOURCES, resolveReservedContextSourceBudget } from "./sources.js";

export interface HistoryViewBaselineStateResolution {
  snapshot?: ReturnType<typeof deriveHistoryViewBaselineState>["snapshot"];
  degradedReason: string | null;
  postureMode: "degraded" | "diagnostic_only" | null;
}

export interface RecoveryContextReadModels {
  baselineState: HistoryViewBaselineStateResolution;
  posture: RecoveryPostureSnapshot;
  workingSet: RecoveryWorkingSetSnapshot | undefined;
}

function normalizeNullableString(value: string | null | undefined): string | null {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized.length > 0 ? normalized : null;
}

function resolveHistoryViewBaselineTokenBudget(
  kernel: RuntimeKernelContext,
  sessionId: string,
  usage?: ContextBudgetUsage,
): number | null {
  if (!kernel.isContextBudgetEnabled()) {
    return null;
  }
  const totalBudget = kernel.contextBudget.getEffectiveInjectionTokenBudget(sessionId, usage);
  return resolveReservedContextSourceBudget(CONTEXT_SOURCES.historyViewBaseline, totalBudget);
}

export function resolveHistoryViewBaselineStateFromKernel(
  kernel: RuntimeKernelContext,
  input: {
    sessionId: string;
    usage?: ContextBudgetUsage;
    referenceContextDigest?: string | null;
  },
): HistoryViewBaselineStateResolution {
  const events = kernel.eventStore.list(input.sessionId);
  const latestEventId = events.at(-1)?.id ?? null;
  const referenceContextDigest = normalizeNullableString(input.referenceContextDigest);
  const maxBaselineTokens = resolveHistoryViewBaselineTokenBudget(
    kernel,
    input.sessionId,
    input.usage,
  );
  const cached = kernel.sessionState.getHistoryViewBaselineCache(input.sessionId);
  if (
    cached &&
    cached.eventCount === events.length &&
    cached.latestEventId === latestEventId &&
    cached.referenceContextDigest === referenceContextDigest &&
    cached.maxBaselineTokens === maxBaselineTokens
  ) {
    return {
      snapshot: cached.snapshot
        ? {
            ...cached.snapshot,
            rebuildSource: "cache",
          }
        : undefined,
      degradedReason: cached.degradedReason,
      postureMode: cached.postureMode,
    };
  }
  const derived = deriveHistoryViewBaselineState(events, {
    referenceContextDigest,
    maxBaselineTokens,
  });
  kernel.sessionState.setHistoryViewBaselineCache(input.sessionId, {
    snapshot: derived.snapshot,
    latestEventId,
    eventCount: events.length,
    degradedReason: derived.degradedReason,
    postureMode: derived.postureMode,
    referenceContextDigest,
    maxBaselineTokens,
  });
  return derived;
}

export function resolveRecoveryContextReadModels(
  kernel: RuntimeKernelContext,
  input: {
    sessionId: string;
    usage?: ContextBudgetUsage;
    referenceContextDigest?: string | null;
  },
): RecoveryContextReadModels {
  const events = kernel.eventStore.list(input.sessionId);
  const baselineState = resolveHistoryViewBaselineStateFromKernel(kernel, input);
  const posture = deriveRecoveryPosture({
    events,
    historyViewDegradedReason: baselineState.degradedReason,
    historyViewPostureMode: baselineState.postureMode,
  });
  return {
    baselineState,
    posture,
    workingSet: deriveRecoveryWorkingSet({
      posture,
      taskState: kernel.getTaskState(input.sessionId),
      openToolCalls: deriveOpenToolCallsFromEvents(events),
    }),
  };
}
