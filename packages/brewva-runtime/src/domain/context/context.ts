import type { BrewvaEventRecord } from "../../events/types.js";
import type { RuntimeKernelContext } from "../../runtime/runtime-kernel.js";
import type { GovernancePort } from "../governance/api.js";
import type { LedgerService } from "../ledger/api.js";
import type { WorkbenchService } from "../workbench/api.js";
import {
  checkAndRequestContextCompaction,
  evaluateContextCompactionGate,
  requestContextCompaction,
} from "./context-compaction-gate.js";
import { commitSessionCompaction, type ContextCompactionDeps } from "./context-compaction.js";
import {
  getContextCompactionGateStatus,
  getContextCompactionThresholdRatio,
  getContextHardLimitRatio,
  getContextStatus,
  getContextUsage,
  getContextUsageRatio,
  getRecentCompactionWindowTurns,
} from "./context-pressure.js";
import type {
  ContextBudgetUsage,
  ContextCompactionGateStatus,
  ContextCompactionReason,
  ContextStatus,
  PromptStabilityObservationInput,
  PromptStabilityState,
  ProviderCacheObservationInput,
  ProviderCacheObservationState,
  TransientReductionObservationInput,
  TransientReductionState,
  VisibleReadState,
} from "./types.js";

export interface ContextServiceDeps {
  config: RuntimeKernelContext["config"];
  contextBudget: RuntimeKernelContext["contextBudget"];
  sessionState: RuntimeKernelContext["sessionState"];
  getCurrentTurn: RuntimeKernelContext["getCurrentTurn"];
  recordEvent: RuntimeKernelContext["recordEvent"];
  ledgerService: Pick<LedgerService, "recordInfrastructureRow">;
  workbenchService?: Pick<WorkbenchService, "commitBaseline">;
  governancePort?: GovernancePort;
}

export type ContextServiceOptions = ContextServiceDeps;

export interface ContextService {
  observeContextUsage(sessionId: string, usage: ContextBudgetUsage | undefined): void;
  getContextUsage(sessionId: string): ContextBudgetUsage | undefined;
  getContextStatus(sessionId: string, usage?: ContextBudgetUsage): ContextStatus;
  getContextUsageRatio(usage: ContextBudgetUsage | undefined): number | null;
  getContextHardLimitRatio(sessionId: string, usage?: ContextBudgetUsage): number;
  getContextCompactionThresholdRatio(sessionId: string, usage?: ContextBudgetUsage): number;
  observePromptStability(
    sessionId: string,
    input: PromptStabilityObservationInput,
  ): PromptStabilityState;
  getPromptStability(sessionId: string): PromptStabilityState | undefined;
  observeTransientReduction(
    sessionId: string,
    input: TransientReductionObservationInput,
  ): TransientReductionState;
  getTransientReduction(sessionId: string): TransientReductionState | undefined;
  observeProviderCache(
    sessionId: string,
    input: ProviderCacheObservationInput,
  ): ProviderCacheObservationState;
  getProviderCacheObservation(sessionId: string): ProviderCacheObservationState | undefined;
  getVisibleReadEpoch(sessionId: string): number;
  advanceVisibleReadEpoch(sessionId: string, reason: string): number;
  rememberVisibleReadState(sessionId: string, state: VisibleReadState): void;
  isVisibleReadStateCurrent(sessionId: string, state: VisibleReadState): boolean;
  getRecentCompactionWindowTurns(): number;
  getContextCompactionGateStatus(
    sessionId: string,
    usage?: ContextBudgetUsage,
  ): ContextCompactionGateStatus;
  checkContextCompactionGate(
    sessionId: string,
    toolName: string,
    usage?: ContextBudgetUsage,
  ): { allowed: boolean; reason?: string };
  explainContextCompactionGate(
    sessionId: string,
    toolName: string,
    usage?: ContextBudgetUsage,
  ): { allowed: boolean; reason?: string };
  checkAndRequestCompaction(sessionId: string, usage: ContextBudgetUsage | undefined): boolean;
  requestCompaction(
    sessionId: string,
    reason: ContextCompactionReason,
    usage?: ContextBudgetUsage,
  ): void;
  getPendingCompactionReason(sessionId: string): ContextCompactionReason | null;
  getCompactionInstructions(): string;
  markContextCompacted(
    sessionId: string,
    input: {
      compactId: string;
      sanitizedSummary: string;
      summaryDigest: string;
      sourceTurn: number;
      leafEntryId: string | null;
      referenceContextDigest: string | null;
      fromTokens: number | null;
      toTokens: number | null;
      origin: "extension_api" | "auto_compaction" | "hosted_recovery";
    },
  ): BrewvaEventRecord;
  isContextBudgetEnabled(): boolean;
}

export function createContextService(options: ContextServiceDeps): ContextService {
  const contextCompactionDeps: ContextCompactionDeps = {
    sessionState: options.sessionState,
    recordInfrastructureRow: (input) => options.ledgerService.recordInfrastructureRow(input),
    governancePort: options.governancePort,
    markPressureCompacted: (sessionId) => options.contextBudget.markCompacted(sessionId),
    commitWorkbenchBaseline: options.workbenchService
      ? (sessionId) => options.workbenchService?.commitBaseline(sessionId)
      : undefined,
    getCurrentTurn: (sessionId) => options.getCurrentTurn(sessionId),
    recordEvent: (input) => options.recordEvent(input),
  };

  const service: ContextService = {
    observeContextUsage(sessionId, usage) {
      options.contextBudget.observeUsage(sessionId, usage);
      if (!usage) return;
      options.recordEvent({
        sessionId,
        type: "context_usage",
        payload: {
          tokens: usage.tokens,
          contextWindow: usage.contextWindow,
          percent: getContextUsageRatio(usage),
        },
      });
    },

    getContextUsage(sessionId) {
      return getContextUsage(options.contextBudget, sessionId);
    },

    getContextStatus(sessionId, usage) {
      return getContextStatus({
        contextBudget: options.contextBudget,
        sessionId,
        usage,
      });
    },

    getContextUsageRatio(usage) {
      return getContextUsageRatio(usage);
    },

    getContextHardLimitRatio(sessionId, usage) {
      return getContextHardLimitRatio(options.contextBudget, sessionId, usage);
    },

    getContextCompactionThresholdRatio(sessionId, usage) {
      return getContextCompactionThresholdRatio(options.contextBudget, sessionId, usage);
    },

    observePromptStability(sessionId, input) {
      const scopeKey = options.sessionState.buildContextScopeKey(sessionId, input.contextScopeId);
      const previous = options.sessionState.getPromptStability(sessionId);
      const scopeChanged = previous !== undefined && previous.scopeKey !== scopeKey;
      const nextState: PromptStabilityState = {
        turn: input.turn ?? options.getCurrentTurn(sessionId),
        updatedAt: input.timestamp ?? Date.now(),
        scopeKey,
        stablePrefixHash: input.stablePrefixHash,
        dynamicTailHash: input.dynamicTailHash,
        stablePrefix:
          previous === undefined ||
          scopeChanged ||
          previous.stablePrefixHash === input.stablePrefixHash,
        stableTail:
          previous === undefined ||
          (previous.dynamicTailHash === input.dynamicTailHash && previous.scopeKey === scopeKey),
      };
      options.sessionState.setPromptStability(sessionId, nextState);
      return nextState;
    },

    getPromptStability(sessionId) {
      return options.sessionState.getPromptStability(sessionId);
    },

    observeTransientReduction(sessionId, input) {
      const nextState: TransientReductionState = {
        turn: input.turn ?? options.getCurrentTurn(sessionId),
        updatedAt: input.timestamp ?? Date.now(),
        status: input.status,
        reason: input.reason ?? null,
        eligibleToolResults: Math.max(0, Math.trunc(input.eligibleToolResults)),
        clearedToolResults: Math.max(0, Math.trunc(input.clearedToolResults)),
        clearedChars: Math.max(0, Math.trunc(input.clearedChars ?? 0)),
        estimatedTokenSavings: Math.max(0, Math.trunc(input.estimatedTokenSavings ?? 0)),
        compactionAdvised: input.compactionAdvised ?? false,
        forcedCompaction: input.forcedCompaction ?? false,
        classification: input.classification ?? null,
        expectedCacheBreak: input.expectedCacheBreak ?? false,
      };
      options.sessionState.setTransientReduction(sessionId, nextState);
      return nextState;
    },

    getTransientReduction(sessionId) {
      return options.sessionState.getTransientReduction(sessionId);
    },

    observeProviderCache(sessionId, input) {
      const nextState: ProviderCacheObservationState = {
        turn: input.turn ?? options.getCurrentTurn(sessionId),
        updatedAt: input.timestamp ?? Date.now(),
        source: input.source,
        fingerprint: structuredClone(input.fingerprint),
        render: structuredClone(input.render),
        breakObservation: structuredClone(input.breakObservation),
      };
      options.sessionState.setProviderCacheObservation(sessionId, nextState);
      return nextState;
    },

    getProviderCacheObservation(sessionId) {
      const state = options.sessionState.getProviderCacheObservation(sessionId);
      return state ? structuredClone(state) : undefined;
    },

    getVisibleReadEpoch(sessionId) {
      return options.sessionState.getVisibleReadEpoch(sessionId);
    },

    advanceVisibleReadEpoch(sessionId, _reason) {
      return options.sessionState.advanceVisibleReadEpoch(sessionId);
    },

    rememberVisibleReadState(sessionId, state) {
      options.sessionState.rememberVisibleReadState(sessionId, state);
    },

    isVisibleReadStateCurrent(sessionId, state) {
      return options.sessionState.isVisibleReadStateCurrent(sessionId, state);
    },

    getRecentCompactionWindowTurns() {
      return getRecentCompactionWindowTurns(options.config);
    },

    getContextCompactionGateStatus(sessionId, usage) {
      return getContextCompactionGateStatus({
        config: options.config,
        contextBudget: options.contextBudget,
        sessionId,
        usage,
        getCurrentTurn: (targetSessionId) => options.getCurrentTurn(targetSessionId),
      });
    },

    checkContextCompactionGate(sessionId, toolName, usage) {
      return evaluateContextCompactionGate({
        config: options.config,
        contextBudget: options.contextBudget,
        sessionId,
        toolName,
        usage,
        getCurrentTurn: (targetSessionId) => options.getCurrentTurn(targetSessionId),
        recordEvent: (input) => options.recordEvent(input),
      });
    },

    explainContextCompactionGate(sessionId, toolName, usage) {
      return evaluateContextCompactionGate({
        config: options.config,
        contextBudget: options.contextBudget,
        sessionId,
        toolName,
        usage,
        getCurrentTurn: (targetSessionId) => options.getCurrentTurn(targetSessionId),
      });
    },

    checkAndRequestCompaction(sessionId, usage) {
      return checkAndRequestContextCompaction({
        contextBudget: options.contextBudget,
        sessionId,
        usage,
        recordEvent: (input) => options.recordEvent(input),
      });
    },

    requestCompaction(sessionId, reason, usage) {
      requestContextCompaction({
        contextBudget: options.contextBudget,
        sessionId,
        reason,
        usage,
        recordEvent: (input) => options.recordEvent(input),
      });
    },

    getPendingCompactionReason(sessionId) {
      return options.contextBudget.getPendingCompactionReason(sessionId);
    },

    getCompactionInstructions() {
      return options.contextBudget.getCompactionInstructions();
    },

    markContextCompacted(sessionId, input) {
      const event = commitSessionCompaction(contextCompactionDeps, sessionId, input);
      service.advanceVisibleReadEpoch(sessionId, "session_compact");
      return event;
    },

    isContextBudgetEnabled() {
      return options.config.infrastructure.contextBudget.enabled;
    },
  };

  return service;
}
