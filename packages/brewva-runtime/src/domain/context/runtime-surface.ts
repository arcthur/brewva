import {
  defineRuntimeSurfaceModule,
  type SurfaceContribution,
} from "../../runtime/surface-descriptor.js";
import type { SessionLifecycleService } from "../sessions/api.js";
import type { TaskWatchdogService } from "../task/api.js";
import type { ContextService } from "./context.js";
import type { ContextInjectionCollector } from "./injection.js";
import type { HistoryViewBaselineSnapshot } from "./types.js";

export interface ContextSurfaceDependencies {
  contextInjection: ContextInjectionCollector;
  getContextService(): ContextService;
  getSessionLifecycleService(): SessionLifecycleService;
  getTaskWatchdogService(): TaskWatchdogService;
  sanitizeInput(text: string): string;
  getHistoryViewBaseline(sessionId: string): HistoryViewBaselineSnapshot | undefined;
  invalidateSessionLifecycleSnapshot(sessionId: string): void;
}

export function createContextSurfaceMethods(deps: ContextSurfaceDependencies) {
  return {
    onTurnStart: (sessionId: string, turnIndex: number) => {
      deps.getSessionLifecycleService().onTurnStart(sessionId, turnIndex);
      deps.getTaskWatchdogService().onTurnStart(sessionId);
    },
    onTurnEnd: (sessionId: string) => {
      deps.getSessionLifecycleService().ensureHydrated(sessionId);
      deps.contextInjection.clearPending(sessionId);
      deps.getContextService().clearReservedInjectionTokensForSession(sessionId);
    },
    onUserInput: (sessionId: string) => {
      deps.getSessionLifecycleService().ensureHydrated(sessionId);
    },
    sanitizeInput: (text: string) => deps.sanitizeInput(text),
    observeUsage: (
      sessionId: string,
      usage: Parameters<ContextService["observeContextUsage"]>[1],
    ) => deps.getContextService().observeContextUsage(sessionId, usage),
    observePromptStability: (
      sessionId: string,
      input: Parameters<ContextService["observePromptStability"]>[1],
    ) => {
      const observed = deps.getContextService().observePromptStability(sessionId, input);
      deps.invalidateSessionLifecycleSnapshot(sessionId);
      return observed;
    },
    observeTransientReduction: (
      sessionId: string,
      input: Parameters<ContextService["observeTransientReduction"]>[1],
    ) => deps.getContextService().observeTransientReduction(sessionId, input),
    observeProviderCache: (
      sessionId: string,
      input: Parameters<ContextService["observeProviderCache"]>[1],
    ) => deps.getContextService().observeProviderCache(sessionId, input),
    getUsage: (sessionId: string) => deps.getContextService().getContextUsage(sessionId),
    getPromptStability: (sessionId: string) =>
      deps.getContextService().getPromptStability(sessionId),
    getTransientReduction: (sessionId: string) =>
      deps.getContextService().getTransientReduction(sessionId),
    getProviderCacheObservation: (sessionId: string) =>
      deps.getContextService().getProviderCacheObservation(sessionId),
    getVisibleReadEpoch: (sessionId: string) =>
      deps.getContextService().getVisibleReadEpoch(sessionId),
    advanceVisibleReadEpoch: (
      sessionId: string,
      reason: Parameters<ContextService["advanceVisibleReadEpoch"]>[1],
    ) => deps.getContextService().advanceVisibleReadEpoch(sessionId, reason),
    rememberVisibleReadState: (
      sessionId: string,
      state: Parameters<ContextService["rememberVisibleReadState"]>[1],
    ) => deps.getContextService().rememberVisibleReadState(sessionId, state),
    isVisibleReadStateCurrent: (
      sessionId: string,
      state: Parameters<ContextService["isVisibleReadStateCurrent"]>[1],
    ) => deps.getContextService().isVisibleReadStateCurrent(sessionId, state),
    getReservedPrimaryTokens: (
      sessionId: string,
      injectionScopeId?: Parameters<ContextService["getReservedPrimaryTokens"]>[1],
    ) => deps.getContextService().getReservedPrimaryTokens(sessionId, injectionScopeId),
    getReservedSupplementalTokens: (
      sessionId: string,
      injectionScopeId?: Parameters<ContextService["getReservedSupplementalTokens"]>[1],
    ) => deps.getContextService().getReservedSupplementalTokens(sessionId, injectionScopeId),
    getUsageRatio: (usage: Parameters<ContextService["getContextUsageRatio"]>[0]) =>
      deps.getContextService().getContextUsageRatio(usage),
    getHardLimitRatio: (
      sessionId: string,
      usage?: Parameters<ContextService["getContextHardLimitRatio"]>[1],
    ) => deps.getContextService().getContextHardLimitRatio(sessionId, usage),
    getCompactionThresholdRatio: (
      sessionId: string,
      usage?: Parameters<ContextService["getContextCompactionThresholdRatio"]>[1],
    ) => deps.getContextService().getContextCompactionThresholdRatio(sessionId, usage),
    getPressureStatus: (
      sessionId: string,
      usage?: Parameters<ContextService["getContextPressureStatus"]>[1],
    ) => deps.getContextService().getContextPressureStatus(sessionId, usage),
    getPressureLevel: (
      sessionId: string,
      usage?: Parameters<ContextService["getContextPressureLevel"]>[1],
    ) => deps.getContextService().getContextPressureLevel(sessionId, usage),
    getCompactionGateStatus: (
      sessionId: string,
      usage?: Parameters<ContextService["getContextCompactionGateStatus"]>[1],
    ) => deps.getContextService().getContextCompactionGateStatus(sessionId, usage),
    checkCompactionGate: (
      sessionId: string,
      toolName: Parameters<ContextService["checkContextCompactionGate"]>[1],
      usage?: Parameters<ContextService["checkContextCompactionGate"]>[2],
    ) => deps.getContextService().checkContextCompactionGate(sessionId, toolName, usage),
    getHistoryViewBaseline: (sessionId: string) => deps.getHistoryViewBaseline(sessionId),
    registerProvider: (provider: Parameters<ContextService["registerContextSourceProvider"]>[0]) =>
      deps.getContextService().registerContextSourceProvider(provider),
    unregisterProvider: (
      source: Parameters<ContextService["unregisterContextSourceProvider"]>[0],
    ) => deps.getContextService().unregisterContextSourceProvider(source),
    listProviders: () => deps.getContextService().listContextSourceProviders(),
    buildInjection: (
      sessionId: string,
      prompt: Parameters<ContextService["buildContextInjection"]>[1],
      usage?: Parameters<ContextService["buildContextInjection"]>[2],
      options?: Parameters<ContextService["buildContextInjection"]>[3],
    ) => deps.getContextService().buildContextInjection(sessionId, prompt, usage, options),
    appendGuardedSupplementalBlocks: (
      sessionId: string,
      blocks: Parameters<ContextService["appendGuardedSupplementalBlocks"]>[1],
      usage?: Parameters<ContextService["appendGuardedSupplementalBlocks"]>[2],
      injectionScopeId?: Parameters<ContextService["appendGuardedSupplementalBlocks"]>[3],
    ) =>
      deps
        .getContextService()
        .appendGuardedSupplementalBlocks(sessionId, blocks, usage, injectionScopeId),
    checkAndRequestCompaction: (
      sessionId: string,
      usage: Parameters<ContextService["checkAndRequestCompaction"]>[1],
    ) => deps.getContextService().checkAndRequestCompaction(sessionId, usage),
    requestCompaction: (
      sessionId: string,
      reason: Parameters<ContextService["requestCompaction"]>[1],
    ) => deps.getContextService().requestCompaction(sessionId, reason),
    getPendingCompactionReason: (sessionId: string) =>
      deps.getContextService().getPendingCompactionReason(sessionId),
    getCompactionInstructions: () => deps.getContextService().getCompactionInstructions(),
    getCompactionWindowTurns: () => deps.getContextService().getRecentCompactionWindowTurns(),
  };
}

export type RuntimeContextSurfaceMethods = ReturnType<typeof createContextSurfaceMethods>;

export const contextSurfaceContribution = {
  inspect: [
    "sanitizeInput",
    "getUsage",
    "getPromptStability",
    "getTransientReduction",
    "getProviderCacheObservation",
    "getVisibleReadEpoch",
    "isVisibleReadStateCurrent",
    "getReservedPrimaryTokens",
    "getReservedSupplementalTokens",
    "getUsageRatio",
    "getHardLimitRatio",
    "getCompactionThresholdRatio",
    "getPressureStatus",
    "getPressureLevel",
    "getCompactionGateStatus",
    "checkCompactionGate",
    "getHistoryViewBaseline",
    "listProviders",
    "getPendingCompactionReason",
    "getCompactionInstructions",
    "getCompactionWindowTurns",
  ],
  maintain: [
    "onTurnStart",
    "onTurnEnd",
    "onUserInput",
    "observeUsage",
    "observePromptStability",
    "observeTransientReduction",
    "observeProviderCache",
    "advanceVisibleReadEpoch",
    "rememberVisibleReadState",
    "registerProvider",
    "unregisterProvider",
    "buildInjection",
    "appendGuardedSupplementalBlocks",
    "checkAndRequestCompaction",
    "requestCompaction",
  ],
} as const satisfies SurfaceContribution<RuntimeContextSurfaceMethods>;

export const contextRuntimeSurface = defineRuntimeSurfaceModule({
  name: "context",
  createMethods: createContextSurfaceMethods,
  contribution: contextSurfaceContribution,
});
