import type { BrewvaConfig } from "../config/types.js";
import type { VerificationLevel } from "../core/shared.js";
import type { VerificationOutcomeSnapshot } from "../domain/context/api.js";
import type { ToolOutputDistillationEntry } from "../domain/context/api.js";
import type { SessionCostSummary } from "../domain/cost/api.js";
import type { GovernancePort } from "../domain/governance/api.js";
import type { ResolvedToolAuthority } from "../domain/governance/api.js";
import type { SessionLifecycleSnapshot } from "../domain/sessions/api.js";
import type { VerificationReport } from "../domain/verification/api.js";
import { registerRuntimeCoreDependencies, type RuntimeCoreDependencies } from "./core-registrar.js";
import { registerRuntimeKernelContext } from "./kernel-registrar.js";
import type { RuntimeKernelContext } from "./runtime-kernel.js";
import {
  registerRuntimeLazyServiceFactories,
  registerRuntimeServiceDependencies,
  type RuntimeLazyServiceFactories,
  type RuntimeServiceDependencies,
} from "./services-registrar.js";

export type { RuntimeCoreDependencies } from "./core-registrar.js";
export type {
  RuntimeLazyServiceFactories,
  RuntimeServiceDependencies,
} from "./services-registrar.js";

export interface RuntimeCompositionInput {
  cwd: string;
  workspaceRoot: string;
  agentId: string;
  config: BrewvaConfig;
  governancePort?: GovernancePort;
  sessionState: RuntimeKernelContext["sessionState"];
  resolveToolAuthority: (toolName: string, args?: Record<string, unknown>) => ResolvedToolAuthority;
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
  resolveCheckpointCostSummary(sessionId: string): SessionCostSummary;
  resolveCheckpointCostSkillLastTurnByName(sessionId: string): Record<string, number>;
  evaluateCompletion(sessionId: string, level?: VerificationLevel): VerificationReport;
  getSessionLifecycleSnapshot(sessionId: string): SessionLifecycleSnapshot;
}

export interface RuntimeComposition {
  coreDependencies: RuntimeCoreDependencies;
  kernel: RuntimeKernelContext;
  serviceDependencies: RuntimeServiceDependencies;
  lazyServiceFactories: RuntimeLazyServiceFactories;
}

export function composeRuntimeDependencies(options: RuntimeCompositionInput): RuntimeComposition {
  const coreDependencies = registerRuntimeCoreDependencies({
    cwd: options.cwd,
    workspaceRoot: options.workspaceRoot,
    config: options.config,
    recordEvent: options.recordEvent,
    getCurrentTurn: (sessionId) => options.getCurrentTurn(sessionId),
  });
  const kernel = registerRuntimeKernelContext({
    cwd: options.cwd,
    workspaceRoot: options.workspaceRoot,
    agentId: options.agentId,
    config: options.config,
    governancePort: options.governancePort,
    coreDependencies,
    sessionState: options.sessionState,
    getCurrentTurn: (sessionId) => options.getCurrentTurn(sessionId),
    getTaskState: (sessionId) => options.getTaskState(sessionId),
    getTruthState: (sessionId) => options.getTruthState(sessionId),
    recordEvent: options.recordEvent,
    sanitizeInput: options.sanitizeInput,
    getRecentToolOutputDistillations: (sessionId, maxEntries) =>
      options.getRecentToolOutputDistillations(sessionId, maxEntries),
    getLatestVerificationOutcome: (sessionId) => options.getLatestVerificationOutcome(sessionId),
    isContextBudgetEnabled: () => options.isContextBudgetEnabled(),
  });
  const serviceDependencies = registerRuntimeServiceDependencies({
    cwd: options.cwd,
    workspaceRoot: options.workspaceRoot,
    agentId: options.agentId,
    config: options.config,
    governancePort: options.governancePort,
    kernel,
    coreDependencies,
    sessionState: options.sessionState,
    resolveToolAuthority: options.resolveToolAuthority,
    resolveCheckpointCostSummary: (sessionId) => options.resolveCheckpointCostSummary(sessionId),
    resolveCheckpointCostSkillLastTurnByName: (sessionId) =>
      options.resolveCheckpointCostSkillLastTurnByName(sessionId),
    evaluateCompletion: (sessionId, level) => options.evaluateCompletion(sessionId, level),
  });
  const lazyServiceFactories = registerRuntimeLazyServiceFactories({
    cwd: options.cwd,
    workspaceRoot: options.workspaceRoot,
    config: options.config,
    governancePort: options.governancePort,
    kernel,
    coreDependencies,
    sessionState: options.sessionState,
    eventPipeline: serviceDependencies.eventPipeline,
    contextService: serviceDependencies.contextService,
    getProposalAdmissionService: () => serviceDependencies.getProposalAdmissionService(),
    getEffectCommitmentDeskService: () => serviceDependencies.getEffectCommitmentDeskService(),
    skillLifecycleService: serviceDependencies.skillLifecycleService,
    ledgerService: serviceDependencies.ledgerService,
    reversibleMutationService: serviceDependencies.reversibleMutationService,
    resolveToolAuthority: options.resolveToolAuthority,
    getSessionLifecycleSnapshot: (sessionId) => options.getSessionLifecycleSnapshot(sessionId),
  });

  return {
    coreDependencies,
    kernel,
    serviceDependencies,
    lazyServiceFactories,
  };
}
