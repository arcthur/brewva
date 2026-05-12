import type { BrewvaEventRecord } from "../../events/types.js";
import type { RuntimeKernelContext } from "../../runtime/runtime-kernel.js";
import {
  deriveDuplicateSideEffectSuppressionCount,
  deriveRecoveryCanonicalization,
  deriveRecoveryPosture,
  deriveRecoveryWorkingSet,
  deriveTransitionState,
  type RecoveryCanonicalizationResult,
  type RecoveryTransitionState,
} from "../recovery/api.js";
import {
  deleteHistoryViewBaselineArtifact,
  readHistoryViewBaselineArtifact,
  writeHistoryViewBaselineArtifact,
} from "./history-view-baseline-artifact.js";
import { deriveHistoryViewBaselineState } from "./history-view-baseline.js";
import type {
  ContextBudgetUsage,
  RecoveryPostureSnapshot,
  RecoveryWorkingSetSnapshot,
} from "./types.js";

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

export interface RecoveryContextPipelineResult extends RecoveryContextReadModels {
  events: readonly BrewvaEventRecord[];
  canonicalization: RecoveryCanonicalizationResult;
  transitionState: RecoveryTransitionState;
  duplicateSideEffectSuppressionCount: number;
}

function normalizeNullableString(value: string | null | undefined): string | null {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized.length > 0 ? normalized : null;
}

export function resolveHistoryViewBaselineStateFromKernel(
  kernel: RuntimeKernelContext,
  input: {
    sessionId: string;
    usage?: ContextBudgetUsage;
    referenceContextDigest?: string | null;
    maxBaselineTokens?: number | null;
  },
): HistoryViewBaselineStateResolution {
  const events = kernel.eventStore.list(input.sessionId);
  return resolveHistoryViewBaselineStateFromEvents(kernel, input, events);
}

function resolveHistoryViewBaselineStateFromEvents(
  kernel: RuntimeKernelContext,
  input: {
    sessionId: string;
    usage?: ContextBudgetUsage;
    referenceContextDigest?: string | null;
    maxBaselineTokens?: number | null;
  },
  events: readonly BrewvaEventRecord[],
): HistoryViewBaselineStateResolution {
  const latestEventId = events.at(-1)?.id ?? null;
  const referenceContextDigest = normalizeNullableString(input.referenceContextDigest);
  const maxBaselineTokens = input.maxBaselineTokens ?? null;
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
  const artifact = readHistoryViewBaselineArtifact(kernel.workspaceRoot, input.sessionId);
  const derived = deriveHistoryViewBaselineState(events, {
    referenceContextDigest,
    maxBaselineTokens,
  });
  const snapshot =
    artifact &&
    derived.snapshot?.rebuildSource === "receipt" &&
    artifact.eventId === derived.snapshot.eventId &&
    artifact.summaryDigest === derived.snapshot.summaryDigest &&
    artifact.leafEntryId === derived.snapshot.leafEntryId &&
    artifact.referenceContextDigest === derived.snapshot.referenceContextDigest
      ? artifact
      : derived.snapshot;
  kernel.sessionState.setHistoryViewBaselineCache(input.sessionId, {
    snapshot,
    latestEventId,
    eventCount: events.length,
    degradedReason: derived.degradedReason,
    postureMode: derived.postureMode,
    referenceContextDigest,
    maxBaselineTokens,
  });
  if (derived.snapshot?.rebuildSource === "receipt") {
    writeHistoryViewBaselineArtifact(kernel.workspaceRoot, input.sessionId, derived.snapshot);
  } else {
    deleteHistoryViewBaselineArtifact(kernel.workspaceRoot, input.sessionId);
  }
  return {
    snapshot,
    degradedReason: derived.degradedReason,
    postureMode: derived.postureMode,
  };
}

export function resolveRecoveryContextReadModels(
  kernel: RuntimeKernelContext,
  input: {
    sessionId: string;
    usage?: ContextBudgetUsage;
    referenceContextDigest?: string | null;
    maxBaselineTokens?: number | null;
  },
): RecoveryContextPipelineResult {
  return runRecoveryContextPipeline(kernel, input);
}

export function runRecoveryContextPipeline(
  kernel: RuntimeKernelContext,
  input: {
    sessionId: string;
    usage?: ContextBudgetUsage;
    referenceContextDigest?: string | null;
    maxBaselineTokens?: number | null;
  },
): RecoveryContextPipelineResult {
  const events = kernel.eventStore.list(input.sessionId);
  const canonicalization = deriveRecoveryCanonicalization(events);
  const baselineState = resolveHistoryViewBaselineStateFromEvents(kernel, input, events);
  const transitionState = deriveTransitionState(events);
  const duplicateSideEffectSuppressionCount = deriveDuplicateSideEffectSuppressionCount(events);
  const posture = deriveRecoveryPosture({
    events,
    canonicalization,
    transitionState,
    duplicateSideEffectSuppressionCount,
    historyViewDegradedReason: baselineState.degradedReason,
    historyViewPostureMode: baselineState.postureMode,
  });
  return {
    events,
    canonicalization,
    transitionState,
    duplicateSideEffectSuppressionCount,
    baselineState,
    posture,
    workingSet: deriveRecoveryWorkingSet({
      posture,
      taskState: kernel.getTaskState(input.sessionId),
      openToolCalls: canonicalization.openToolCalls,
    }),
  };
}
