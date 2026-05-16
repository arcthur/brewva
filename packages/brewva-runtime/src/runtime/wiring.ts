import { resolve } from "node:path";
import type { BrewvaConfig } from "../config/types.js";
import type { VerificationLevel } from "../core/shared.js";
import { registerClaimDomain, type ClaimService } from "../domain/claim/api.js";
import {
  ContextBudgetManager,
  registerContextDomain,
  type ContextService,
  type VerificationOutcomeSnapshot,
} from "../domain/context/api.js";
import {
  registerConventionsDomain,
  type ConventionAdmissionService,
} from "../domain/conventions/api.js";
import {
  registerCostDomain,
  SessionCostTracker,
  type CostService,
  type SessionCostSummary,
} from "../domain/cost/api.js";
import {
  registerCredentialsDomain,
  type CredentialVaultService,
} from "../domain/credentials/api.js";
import {
  registerGovernanceDomain,
  type GovernancePort,
  type MutationRollbackService,
  type ResolvedToolAuthority,
  type ReversibleMutationService,
} from "../domain/governance/api.js";
import { EvidenceLedger, registerLedgerDomain, type LedgerService } from "../domain/ledger/api.js";
import {
  ParallelBudgetManager,
  ParallelResultStore,
  registerParallelDomain,
  type ParallelService,
  type ResourceLeaseService,
} from "../domain/parallel/api.js";
import {
  FileChangeTracker,
  registerPatchingDomain,
  type FileChangeService,
} from "../domain/patching/api.js";
import { ProjectionEngine } from "../domain/projection/api.js";
import {
  registerProposalsDomain,
  type EffectCommitmentDeskService,
  type ProposalAdmissionService,
} from "../domain/proposals/api.js";
import { registerReasoningDomain, type ReasoningService } from "../domain/reasoning/api.js";
import { RecoveryWalStore, type ToolLifecycleRecoveryWalService } from "../domain/recovery/api.js";
import { registerScheduleDomain, type ScheduleIntentService } from "../domain/schedule/api.js";
import {
  registerSessionsDomain,
  registerSessionsLazyDomain,
  RuntimeSessionStateStore,
  type EventPipelineService,
  type RuntimeRecordEvent,
  type SessionLifecycleService,
  type SessionTitleService,
  type SessionLifecycleSnapshot,
  type SessionLineageService,
  type SessionRewindService,
  type SessionWireService,
} from "../domain/sessions/api.js";
import { registerSkillsDomain, SkillRegistry } from "../domain/skills/api.js";
import { ReasoningReplayEngine, TurnReplayEngine, type TapeService } from "../domain/tape/api.js";
import {
  registerTaskDomain,
  type TaskService,
  type TaskWatchdogService,
} from "../domain/task/api.js";
import {
  registerToolsDomain,
  type ToolGateService,
  type ToolInvocationSpine,
} from "../domain/tools/api.js";
import {
  registerVerificationDomain,
  VerificationGate,
  type VerificationReport,
  type VerificationService,
} from "../domain/verification/api.js";
import { registerWorkbenchDomain, type WorkbenchService } from "../domain/workbench/api.js";
import { BrewvaEventStore } from "../events/store.js";
import type { RuntimeKernelContext } from "./runtime-kernel.js";

export interface RuntimeCoreDependencies {
  skillRegistry: SkillRegistry;
  evidenceLedger: EvidenceLedger;
  verificationGate: VerificationGate;
  parallel: ParallelBudgetManager;
  parallelResults: ParallelResultStore;
  eventStore: BrewvaEventStore;
  recoveryWalStore: RecoveryWalStore;
  contextBudget: ContextBudgetManager;
  turnReplay: TurnReplayEngine;
  reasoningReplay: ReasoningReplayEngine;
  fileChanges: FileChangeTracker;
  costTracker: SessionCostTracker;
  projectionEngine: ProjectionEngine;
}

export interface RuntimeServiceDependencies {
  taskService: TaskService;
  claimService: ClaimService;
  ledgerService: LedgerService;
  costService: CostService;
  contextService: ContextService;
  workbenchService: WorkbenchService;
  taskWatchdogService: TaskWatchdogService;
  eventPipeline: EventPipelineService;
  toolLifecycleRecoveryWalService: ToolLifecycleRecoveryWalService;
  sessionLifecycleService: SessionLifecycleService;
  sessionTitleService: SessionTitleService;
  sessionLineageService: SessionLineageService;
  reversibleMutationService: ReversibleMutationService;
  getTapeService(): TapeService;
  getEffectCommitmentDeskService(): EffectCommitmentDeskService;
  getProposalAdmissionService(): ProposalAdmissionService;
  getConventionAdmissionService(): ConventionAdmissionService;
  clearEffectCommitmentDeskState(sessionId: string): void;
}

export interface RuntimeLazyServiceFactories {
  createCredentialVaultService(): CredentialVaultService;
  createSessionRewindService(): SessionRewindService;
  createFileChangeService(): FileChangeService;
  createMutationRollbackService(): MutationRollbackService;
  createParallelService(): ParallelService;
  createReasoningService(): ReasoningService;
  createResourceLeaseService(): ResourceLeaseService;
  createScheduleIntentService(): ScheduleIntentService;
  createSessionWireService(): SessionWireService;
  createToolGateService(): ToolGateService;
  createToolInvocationSpine(): ToolInvocationSpine;
  createVerificationService(): VerificationService;
}

export interface RuntimeServiceRegistrarOptions {
  cwd: string;
  workspaceRoot: string;
  agentId: string;
  config: BrewvaConfig;
  governancePort?: GovernancePort;
  kernel: RuntimeKernelContext;
  coreDependencies: RuntimeCoreDependencies;
  sessionState: RuntimeSessionStateStore;
  resolveToolAuthority: (toolName: string, args?: Record<string, unknown>) => ResolvedToolAuthority;
  resolveCheckpointCostSummary(sessionId: string): SessionCostSummary;
  resolveCheckpointCostSkillLastTurnByName(sessionId: string): Record<string, number>;
  evaluateCompletion(sessionId: string, level?: VerificationLevel): VerificationReport;
}

export interface RuntimeLazyServiceRegistrarOptions {
  cwd: string;
  workspaceRoot: string;
  config: BrewvaConfig;
  governancePort?: GovernancePort;
  kernel: RuntimeKernelContext;
  coreDependencies: RuntimeCoreDependencies;
  sessionState: RuntimeSessionStateStore;
  eventPipeline: EventPipelineService;
  contextService: ContextService;
  getProposalAdmissionService(): ProposalAdmissionService;
  getEffectCommitmentDeskService(): EffectCommitmentDeskService;
  getConventionAdmissionService(): ConventionAdmissionService;
  ledgerService: LedgerService;
  reversibleMutationService: ReversibleMutationService;
  resolveToolAuthority: (toolName: string, args?: Record<string, unknown>) => ResolvedToolAuthority;
  getSessionLifecycleSnapshot(sessionId: string): SessionLifecycleSnapshot;
}

export interface RuntimeSessionServices {
  eventPipeline: EventPipelineService;
  toolLifecycleRecoveryWalService: ToolLifecycleRecoveryWalService;
  sessionLifecycleService: SessionLifecycleService;
  sessionTitleService: SessionTitleService;
  sessionLineageService: SessionLineageService;
  getTapeService(): TapeService;
}

export interface RuntimeCoreRegistrarOptions {
  cwd: string;
  workspaceRoot: string;
  config: BrewvaConfig;
  recordEvent: RuntimeRecordEvent;
  getCurrentTurn(sessionId: string): number;
}

export function registerRuntimeCoreDependencies(
  options: RuntimeCoreRegistrarOptions,
): RuntimeCoreDependencies {
  const skillRegistry = new SkillRegistry({
    workspaceRoot: options.workspaceRoot,
    config: options.config,
  });

  const eventStore = new BrewvaEventStore(
    options.config.infrastructure.events,
    options.workspaceRoot,
  );
  const projectionEngine = new ProjectionEngine({
    enabled: options.config.projection.enabled,
    rootDir: resolve(options.workspaceRoot, options.config.projection.dir),
    workingFile: options.config.projection.workingFile,
    maxWorkingChars: options.config.projection.maxWorkingChars,
    listEvents: (sessionId: string) => eventStore.list(sessionId),
    recordEvent: (eventInput: Parameters<RuntimeRecordEvent>[0]) => options.recordEvent(eventInput),
  });

  return {
    skillRegistry,
    evidenceLedger: new EvidenceLedger(resolve(options.workspaceRoot, options.config.ledger.path)),
    verificationGate: new VerificationGate(options.config),
    parallel: new ParallelBudgetManager(options.config.parallel),
    parallelResults: new ParallelResultStore(),
    eventStore,
    recoveryWalStore: new RecoveryWalStore({
      workspaceRoot: options.workspaceRoot,
      config: options.config.infrastructure.recoveryWal,
      scope: "runtime",
      recordEvent: (input) => {
        options.recordEvent({
          sessionId: input.sessionId,
          type: input.type,
          payload: input.payload,
          skipTapeCheckpoint: true,
        });
      },
    }),
    contextBudget: new ContextBudgetManager(options.config.infrastructure.contextBudget),
    turnReplay: new TurnReplayEngine({
      listEvents: (sessionId) => eventStore.list(sessionId),
      getTurn: (sessionId) => options.getCurrentTurn(sessionId),
    }),
    reasoningReplay: new ReasoningReplayEngine({
      listEvents: (sessionId) => eventStore.list(sessionId),
    }),
    fileChanges: new FileChangeTracker(options.cwd, {
      artifactsBaseDir: options.workspaceRoot,
    }),
    costTracker: new SessionCostTracker(options.config.infrastructure.costTracking),
    projectionEngine,
  };
}

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
  getClaimState(sessionId: string): ReturnType<RuntimeKernelContext["getClaimState"]>;
  recordEvent: RuntimeKernelContext["recordEvent"];
  sanitizeInput: RuntimeKernelContext["sanitizeInput"];
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
    getClaimState: (sessionId) => options.getClaimState(sessionId),
    recordEvent: (input) => options.recordEvent(input),
    sanitizeInput: (text) => options.sanitizeInput(text),
    getLatestVerificationOutcome: (sessionId) => options.getLatestVerificationOutcome(sessionId),
    isContextBudgetEnabled: () => options.isContextBudgetEnabled(),
  };
}

export function registerRuntimeServiceDependencies(
  options: RuntimeServiceRegistrarOptions,
): RuntimeServiceDependencies {
  const governanceDomain = registerGovernanceDomain(options);
  const { reversibleMutationService } = governanceDomain.services;
  const proposalsDomain = registerProposalsDomain(options);
  const conventionsDomain = registerConventionsDomain(options, {
    reversibleMutationService,
  });

  const taskDomain = registerTaskDomain(options);
  const { taskService, taskWatchdogService } = taskDomain.services;
  registerSkillsDomain(options);
  const claimDomain = registerClaimDomain(options);
  const { claimService } = claimDomain.services;
  const ledgerDomain = registerLedgerDomain(options, {
    getEffectCommitmentDeskService: () => proposalsDomain.services.getEffectCommitmentDeskService(),
  });
  const { ledgerService } = ledgerDomain.services;
  const costDomain = registerCostDomain(options, {
    ledgerService,
  });
  const { costService } = costDomain.services;
  const workbenchDomain = registerWorkbenchDomain(options);
  const { workbenchService } = workbenchDomain.services;

  const contextDomain = registerContextDomain(options, {
    taskService,
  });
  const { contextService } = contextDomain.services;

  const sessionServices = registerSessionsDomain(options, {
    taskService,
    claimService,
    reversibleMutationService,
    workbenchService,
    clearEffectCommitmentDeskState: (sessionId) =>
      proposalsDomain.services.clearEffectCommitmentDeskState(sessionId),
  }).services;

  return {
    taskService,
    claimService,
    ledgerService,
    costService,
    contextService,
    workbenchService,
    taskWatchdogService,
    eventPipeline: sessionServices.eventPipeline,
    toolLifecycleRecoveryWalService: sessionServices.toolLifecycleRecoveryWalService,
    sessionLifecycleService: sessionServices.sessionLifecycleService,
    sessionTitleService: sessionServices.sessionTitleService,
    sessionLineageService: sessionServices.sessionLineageService,
    reversibleMutationService,
    getTapeService: () => sessionServices.getTapeService(),
    getEffectCommitmentDeskService: () => proposalsDomain.services.getEffectCommitmentDeskService(),
    getProposalAdmissionService: () => proposalsDomain.services.getProposalAdmissionService(),
    getConventionAdmissionService: () => conventionsDomain.services.getConventionAdmissionService(),
    clearEffectCommitmentDeskState: (sessionId: string) =>
      proposalsDomain.services.clearEffectCommitmentDeskState(sessionId),
  };
}

export function registerRuntimeLazyServiceFactories(
  options: RuntimeLazyServiceRegistrarOptions,
): RuntimeLazyServiceFactories {
  const patchingDomain = registerPatchingDomain(options, {
    ledgerService: options.ledgerService,
    reversibleMutationService: options.reversibleMutationService,
  });
  const reasoningDomain = registerReasoningDomain(options);
  const sessionsDomain = registerSessionsLazyDomain(options, {
    getReasoningService: () => reasoningDomain.lazyFactories.createReasoningService(),
    getFileChangeService: () => patchingDomain.lazyFactories.createFileChangeService(),
  });
  const parallelDomain = registerParallelDomain(options, {
    getFileChangeService: () => patchingDomain.lazyFactories.createFileChangeService(),
  });
  const credentialsDomain = registerCredentialsDomain(options);
  const scheduleDomain = registerScheduleDomain(options);
  const verificationDomain = registerVerificationDomain(options);
  const toolsDomain = registerToolsDomain(options, {
    getFileChangeService: () => patchingDomain.lazyFactories.createFileChangeService(),
    getResourceLeaseService: () => parallelDomain.lazyFactories.createResourceLeaseService(),
  });

  return {
    createCredentialVaultService: () =>
      credentialsDomain.lazyFactories.createCredentialVaultService(),
    createSessionRewindService: () => sessionsDomain.lazyFactories.createSessionRewindService(),
    createFileChangeService: () => patchingDomain.lazyFactories.createFileChangeService(),
    createMutationRollbackService: () =>
      patchingDomain.lazyFactories.createMutationRollbackService(),
    createParallelService: () => parallelDomain.lazyFactories.createParallelService(),
    createReasoningService: () => reasoningDomain.lazyFactories.createReasoningService(),
    createResourceLeaseService: () => parallelDomain.lazyFactories.createResourceLeaseService(),
    createScheduleIntentService: () => scheduleDomain.lazyFactories.createScheduleIntentService(),
    createSessionWireService: () => sessionsDomain.lazyFactories.createSessionWireService(),
    ...toolsDomain.lazyFactories,
    createVerificationService: () => verificationDomain.lazyFactories.createVerificationService(),
  };
}
