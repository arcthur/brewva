import type { BrewvaEventRecord } from "../../events/types.js";
import type { RuntimeKernelContext } from "../../runtime/runtime-kernel.js";
import type { GovernancePort } from "../governance/api.js";
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
import {
  resolveContextCompactionEligibility,
  type ContextCompactionEligibility,
  type ContextCompactionEligibilityInput,
} from "./eligibility.js";
import type {
  ContextBudgetUsage,
  ContextCompactionGateStatus,
  ContextCompactionReason,
  ContextEvidenceKind,
  ContextEvidenceSample,
  ContextStatus,
  SessionCompactionCommitInput,
  VisibleReadState,
} from "./types.js";

export interface ContextServiceDeps {
  config: RuntimeKernelContext["config"];
  contextBudget: RuntimeKernelContext["contextBudget"];
  sessionState: RuntimeKernelContext["sessionState"];
  getCurrentTurn: RuntimeKernelContext["getCurrentTurn"];
  recordEvent: RuntimeKernelContext["recordEvent"];
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
  appendEvidence(sessionId: string, sample: ContextEvidenceSample): void;
  latestEvidence(sessionId: string, kind: ContextEvidenceKind): ContextEvidenceSample | undefined;
  getVisibleReadEpoch(sessionId: string): number;
  advanceVisibleReadEpoch(sessionId: string, reason: string): number;
  rememberVisibleReadState(sessionId: string, state: VisibleReadState): void;
  isVisibleReadStateCurrent(sessionId: string, state: VisibleReadState): boolean;
  getRecentCompactionWindowTurns(): number;
  getContextCompactionGateStatus(
    sessionId: string,
    usage?: ContextBudgetUsage,
  ): ContextCompactionGateStatus;
  resolveCompactionEligibility(
    input: Omit<ContextCompactionEligibilityInput, "enabled">,
  ): ContextCompactionEligibility;
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
  recordAutoCompactionFailure(sessionId: string): void;
  recordAutoCompactionSuccess(sessionId: string): void;
  getAutoCompactionPolicyState(sessionId: string): {
    consecutiveFailures: number;
    breakerOpen: boolean;
    deferredReason: string | null;
  };
  rememberDeferredAutoCompactionReason(sessionId: string, reason: string | null): boolean;
  getPendingCompactionReason(sessionId: string): ContextCompactionReason | null;
  getCompactionInstructions(): string;
  markContextCompacted(
    sessionId: string,
    input: SessionCompactionCommitInput,
  ): Promise<BrewvaEventRecord>;
  isContextBudgetEnabled(): boolean;
}

export function createContextService(options: ContextServiceDeps): ContextService {
  const latestEvidenceBySession = new Map<
    string,
    Map<ContextEvidenceKind, ContextEvidenceSample>
  >();
  const contextCompactionDeps: ContextCompactionDeps = {
    governancePort: options.governancePort,
    markPressureCompacted: (sessionId) => options.contextBudget.markCompacted(sessionId),
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

    appendEvidence(sessionId, sample) {
      const byKind = latestEvidenceBySession.get(sessionId) ?? new Map();
      byKind.set(sample.kind, {
        kind: sample.kind,
        turn: Math.max(0, Math.trunc(sample.turn)),
        timestamp: Math.max(0, Math.trunc(sample.timestamp)),
        payload: structuredClone(sample.payload),
      });
      latestEvidenceBySession.set(sessionId, byKind);
    },

    latestEvidence(sessionId, kind) {
      const sample = latestEvidenceBySession.get(sessionId)?.get(kind);
      return sample
        ? {
            kind: sample.kind,
            turn: sample.turn,
            timestamp: sample.timestamp,
            payload: structuredClone(sample.payload),
          }
        : undefined;
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

    resolveCompactionEligibility(input) {
      return resolveContextCompactionEligibility({
        ...input,
        enabled: options.config.infrastructure.contextBudget.enabled,
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

    recordAutoCompactionFailure(sessionId) {
      options.contextBudget.recordAutoCompactionFailure(sessionId);
    },

    recordAutoCompactionSuccess(sessionId) {
      options.contextBudget.recordAutoCompactionSuccess(sessionId);
    },

    getAutoCompactionPolicyState(sessionId) {
      return options.contextBudget.getAutoCompactionPolicyState(sessionId);
    },

    rememberDeferredAutoCompactionReason(sessionId, reason) {
      return options.contextBudget.rememberDeferredAutoCompactionReason(sessionId, reason);
    },

    getPendingCompactionReason(sessionId) {
      return options.contextBudget.getPendingCompactionReason(sessionId);
    },

    getCompactionInstructions() {
      return options.contextBudget.getCompactionInstructions();
    },

    async markContextCompacted(sessionId, input) {
      const event = await commitSessionCompaction(contextCompactionDeps, sessionId, input);
      service.advanceVisibleReadEpoch(sessionId, "session_compact");
      return event;
    },

    isContextBudgetEnabled() {
      return options.config.infrastructure.contextBudget.enabled;
    },
  };

  return service;
}
