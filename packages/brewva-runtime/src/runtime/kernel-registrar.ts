import type { BrewvaConfig } from "../config/types.js";
import type { VerificationOutcomeSnapshot } from "../domain/context/api.js";
import type { ToolOutputDistillationEntry } from "../domain/context/api.js";
import type { GovernancePort } from "../domain/governance/api.js";
import type { RuntimeSessionStateStore } from "../domain/sessions/api.js";
import type { RuntimeCoreDependencies } from "./core-registrar.js";
import type { RuntimeKernelContext } from "./runtime-kernel.js";

export interface RuntimeKernelRegistrarOptions {
  cwd: string;
  workspaceRoot: string;
  agentId: string;
  config: BrewvaConfig;
  governancePort?: GovernancePort;
  sessionState: RuntimeSessionStateStore;
  coreDependencies: RuntimeCoreDependencies;
  getCurrentTurn(sessionId: string): number;
  getTaskState(sessionId: string): ReturnType<RuntimeKernelContext["getTaskState"]>;
  getTruthState(sessionId: string): ReturnType<RuntimeKernelContext["getTruthState"]>;
  recordEvent: RuntimeKernelContext["recordEvent"];
  sanitizeInput: RuntimeKernelContext["sanitizeInput"];
  getRecentToolOutputDistillations(
    sessionId: string,
    maxEntries?: number,
  ): ToolOutputDistillationEntry[];
  getLatestVerificationOutcome(sessionId: string): VerificationOutcomeSnapshot | undefined;
  isContextBudgetEnabled(): boolean;
}

export function registerRuntimeKernelContext(
  options: RuntimeKernelRegistrarOptions,
): RuntimeKernelContext {
  return {
    cwd: options.cwd,
    workspaceRoot: options.workspaceRoot,
    agentId: options.agentId,
    config: options.config,
    governancePort: options.governancePort,
    sessionState: options.sessionState,
    contextBudget: options.coreDependencies.contextBudget,
    contextInjection: options.coreDependencies.contextInjection,
    projectionEngine: options.coreDependencies.projectionEngine,
    turnReplay: options.coreDependencies.turnReplay,
    reasoningReplay: options.coreDependencies.reasoningReplay,
    eventStore: options.coreDependencies.eventStore,
    evidenceLedger: options.coreDependencies.evidenceLedger,
    verificationGate: options.coreDependencies.verificationGate,
    parallel: options.coreDependencies.parallel,
    parallelResults: options.coreDependencies.parallelResults,
    fileChanges: options.coreDependencies.fileChanges,
    costTracker: options.coreDependencies.costTracker,
    getCurrentTurn: (sessionId) => options.getCurrentTurn(sessionId),
    getTaskState: (sessionId) => options.getTaskState(sessionId),
    getTruthState: (sessionId) => options.getTruthState(sessionId),
    recordEvent: (input) => options.recordEvent(input),
    sanitizeInput: (text) => options.sanitizeInput(text),
    getRecentToolOutputDistillations: (sessionId, maxEntries) =>
      options.getRecentToolOutputDistillations(sessionId, maxEntries),
    getLatestVerificationOutcome: (sessionId) => options.getLatestVerificationOutcome(sessionId),
    isContextBudgetEnabled: () => options.isContextBudgetEnabled(),
  };
}
