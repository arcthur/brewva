import type { SessionLifecycleService } from "../sessions/api.js";
import type { TaskWatchdogService } from "../task/api.js";
import type { ContextService } from "./context.js";
import type { HistoryViewBaselineSnapshot } from "./types.js";

export interface ContextSurfaceDependencies {
  getContextService(): ContextService;
  getSessionLifecycleService(): SessionLifecycleService;
  getTaskWatchdogService(): TaskWatchdogService;
  sanitizeInput(text: string): string;
  getHistoryViewBaseline(sessionId: string): HistoryViewBaselineSnapshot | undefined;
  invalidateSessionLifecycleSnapshot(sessionId: string): void;
}

export function createContextSurfaceMethods(deps: ContextSurfaceDependencies) {
  return {
    inspect: {
      sanitizeInput: (text: string) => deps.sanitizeInput(text),
      usage: {
        get: (sessionId: string) => deps.getContextService().getContextUsage(sessionId),
        getStatus: (sessionId: string, usage?: Parameters<ContextService["getContextStatus"]>[1]) =>
          deps.getContextService().getContextStatus(sessionId, usage),
        getRatio: (usage: Parameters<ContextService["getContextUsageRatio"]>[0]) =>
          deps.getContextService().getContextUsageRatio(usage),
      },
      prompt: {
        getHistoryViewBaseline: (sessionId: string) => deps.getHistoryViewBaseline(sessionId),
      },
      evidence: {
        latest: (sessionId: string, kind: Parameters<ContextService["latestEvidence"]>[1]) =>
          deps.getContextService().latestEvidence(sessionId, kind),
      },
      visibleRead: {
        getEpoch: (sessionId: string) => deps.getContextService().getVisibleReadEpoch(sessionId),
        isCurrent: (
          sessionId: string,
          state: Parameters<ContextService["isVisibleReadStateCurrent"]>[1],
        ) => deps.getContextService().isVisibleReadStateCurrent(sessionId, state),
      },
      compaction: {
        resolveEligibility: (
          input: Parameters<ContextService["resolveCompactionEligibility"]>[0],
        ) => deps.getContextService().resolveCompactionEligibility(input),
        getHardLimitRatio: (
          sessionId: string,
          usage?: Parameters<ContextService["getContextHardLimitRatio"]>[1],
        ) => deps.getContextService().getContextHardLimitRatio(sessionId, usage),
        getThresholdRatio: (
          sessionId: string,
          usage?: Parameters<ContextService["getContextCompactionThresholdRatio"]>[1],
        ) => deps.getContextService().getContextCompactionThresholdRatio(sessionId, usage),
        getGateStatus: (
          sessionId: string,
          usage?: Parameters<ContextService["getContextCompactionGateStatus"]>[1],
        ) => deps.getContextService().getContextCompactionGateStatus(sessionId, usage),
        checkGate: (
          sessionId: string,
          toolName: Parameters<ContextService["checkContextCompactionGate"]>[1],
          usage?: Parameters<ContextService["checkContextCompactionGate"]>[2],
        ) => deps.getContextService().checkContextCompactionGate(sessionId, toolName, usage),
        getPendingReason: (sessionId: string) =>
          deps.getContextService().getPendingCompactionReason(sessionId),
        getAutoPolicyState: (sessionId: string) =>
          deps.getContextService().getAutoCompactionPolicyState(sessionId),
        getInstructions: () => deps.getContextService().getCompactionInstructions(),
        getWindowTurns: () => deps.getContextService().getRecentCompactionWindowTurns(),
      },
    },
    operator: {
      lifecycle: {
        onTurnStart: (sessionId: string, turnIndex: number) => {
          deps.getSessionLifecycleService().onTurnStart(sessionId, turnIndex);
          deps.getTaskWatchdogService().onTurnStart(sessionId);
        },
        onTurnEnd: (sessionId: string) => {
          deps.getSessionLifecycleService().ensureHydrated(sessionId);
        },
        onUserInput: (sessionId: string) => {
          deps.getSessionLifecycleService().ensureHydrated(sessionId);
        },
      },
      usage: {
        observe: (sessionId: string, usage: Parameters<ContextService["observeContextUsage"]>[1]) =>
          deps.getContextService().observeContextUsage(sessionId, usage),
      },
      evidence: {
        append: (sessionId: string, sample: Parameters<ContextService["appendEvidence"]>[1]) =>
          deps.getContextService().appendEvidence(sessionId, sample),
      },
      visibleRead: {
        advanceEpoch: (
          sessionId: string,
          reason: Parameters<ContextService["advanceVisibleReadEpoch"]>[1],
        ) => deps.getContextService().advanceVisibleReadEpoch(sessionId, reason),
        rememberState: (
          sessionId: string,
          state: Parameters<ContextService["rememberVisibleReadState"]>[1],
        ) => deps.getContextService().rememberVisibleReadState(sessionId, state),
      },
      compaction: {
        checkAndRequest: (
          sessionId: string,
          usage: Parameters<ContextService["checkAndRequestCompaction"]>[1],
        ) => deps.getContextService().checkAndRequestCompaction(sessionId, usage),
        request: (sessionId: string, reason: Parameters<ContextService["requestCompaction"]>[1]) =>
          deps.getContextService().requestCompaction(sessionId, reason),
        recordAutoFailure: (sessionId: string) =>
          deps.getContextService().recordAutoCompactionFailure(sessionId),
        recordAutoSuccess: (sessionId: string) =>
          deps.getContextService().recordAutoCompactionSuccess(sessionId),
        rememberDeferredReason: (sessionId: string, reason: string | null) =>
          deps.getContextService().rememberDeferredAutoCompactionReason(sessionId, reason),
      },
    },
  };
}

export type RuntimeContextSurfaceMethods = ReturnType<typeof createContextSurfaceMethods>;

export function createContextInspectSurface(deps: ContextSurfaceDependencies) {
  return createContextSurfaceMethods(deps).inspect;
}

export function createContextOperatorSurface(deps: ContextSurfaceDependencies) {
  return createContextSurfaceMethods(deps).operator;
}
