import { resolve } from "node:path";
import { TurnWALStore } from "./channels/turn-wal.js";
import { ContextBudgetManager } from "./context/budget.js";
import { registerBuiltInContextSourceProviders } from "./context/builtins.js";
import { ContextInjectionCollector } from "./context/injection.js";
import { ContextSourceProviderRegistry } from "./context/provider.js";
import type { VerificationOutcomeSnapshot } from "./context/runtime-status.js";
import type { ToolOutputDistillationEntry } from "./context/tool-output-distilled.js";
import type {
  BrewvaConfig,
  BrewvaEventRecord,
  SessionCostSummary,
  ToolExecutionBoundary,
  ToolGovernanceDescriptor,
  VerificationLevel,
  VerificationReport,
} from "./contracts/index.js";
import { SessionCostTracker } from "./cost/tracker.js";
import { DECISION_RECEIPT_RECORDED_EVENT_TYPE } from "./events/event-types.js";
import { BrewvaEventStore } from "./events/store.js";
import type { GovernancePort } from "./governance/port.js";
import type { ToolGovernanceDescriptorSource } from "./governance/tool-governance.js";
import { EvidenceLedger } from "./ledger/evidence-ledger.js";
import { ParallelBudgetManager } from "./parallel/budget.js";
import { ParallelResultStore } from "./parallel/results.js";
import { ProjectionEngine } from "./projection/engine.js";
import { inferEventCategory } from "./runtime-helpers.js";
import type { RuntimeKernelContext } from "./runtime-kernel.js";
import { SchedulerService } from "./schedule/service.js";
import {
  CONTEXT_CRITICAL_ALLOWED_TOOLS,
  CONTROL_PLANE_TOOLS,
} from "./security/control-plane-tools.js";
import { ContextService } from "./services/context.js";
import { CostService } from "./services/cost.js";
import { createCredentialVaultServiceFromSecurityConfig } from "./services/credential-vault.js";
import type { CredentialVaultService } from "./services/credential-vault.js";
import { EffectCommitmentDeskService } from "./services/effect-commitment-desk.js";
import { EventPipelineService, type RuntimeRecordEventInput } from "./services/event-pipeline.js";
import { FileChangeService } from "./services/file-change.js";
import { LedgerService } from "./services/ledger.js";
import { MutationRollbackService } from "./services/mutation-rollback.js";
import { ParallelService } from "./services/parallel.js";
import type { EffectCommitmentAuthorizationDecision } from "./services/proposal-admission-effect-commitment.js";
import { ProposalAdmissionService } from "./services/proposal-admission.js";
import { ResourceLeaseService } from "./services/resource-lease.js";
import { ReversibleMutationService } from "./services/reversible-mutation.js";
import { ScheduleIntentService } from "./services/schedule-intent.js";
import { SessionLifecycleService } from "./services/session-lifecycle.js";
import type { RuntimeSessionStateStore } from "./services/session-state.js";
import { SkillLifecycleService } from "./services/skill-lifecycle.js";
import { TapeService } from "./services/tape.js";
import { TaskWatchdogService } from "./services/task-watchdog.js";
import { TaskService } from "./services/task.js";
import { ToolGateService } from "./services/tool-gate.js";
import { ToolInvocationSpine } from "./services/tool-invocation-spine.js";
import { TruthProjectorService } from "./services/truth-projector.js";
import { TruthService } from "./services/truth.js";
import { VerificationProjectorService } from "./services/verification-projector.js";
import { VerificationService } from "./services/verification.js";
import { SkillRegistry } from "./skills/registry.js";
import { FileChangeTracker } from "./state/file-change-tracker.js";
import { TurnReplayEngine } from "./tape/replay-engine.js";
import { resolveTaskTargetRoots } from "./task/targeting.js";
import { VerificationGate } from "./verification/gate.js";

export interface RuntimeCoreDependencies {
  skillRegistry: SkillRegistry;
  evidenceLedger: EvidenceLedger;
  verificationGate: VerificationGate;
  parallel: ParallelBudgetManager;
  parallelResults: ParallelResultStore;
  eventStore: BrewvaEventStore;
  turnWalStore: TurnWALStore;
  contextBudget: ContextBudgetManager;
  contextInjection: ContextInjectionCollector;
  turnReplay: TurnReplayEngine;
  fileChanges: FileChangeTracker;
  costTracker: SessionCostTracker;
  projectionEngine: ProjectionEngine;
}

export interface RuntimeServiceDependencies {
  credentialVaultService: CredentialVaultService;
  proposalAdmissionService: ProposalAdmissionService;
  skillLifecycleService: SkillLifecycleService;
  taskService: TaskService;
  truthService: TruthService;
  ledgerService: LedgerService;
  resourceLeaseService: ResourceLeaseService;
  parallelService: ParallelService;
  costService: CostService;
  verificationService: VerificationService;
  contextService: ContextService;
  taskWatchdogService: TaskWatchdogService;
  tapeService: TapeService;
  eventPipeline: EventPipelineService;
  truthProjectorService: TruthProjectorService;
  verificationProjectorService: VerificationProjectorService;
  scheduleIntentService: ScheduleIntentService;
  fileChangeService: FileChangeService;
  mutationRollbackService: MutationRollbackService;
  sessionLifecycleService: SessionLifecycleService;
  toolGateService: ToolGateService;
  toolInvocationSpine: ToolInvocationSpine;
  effectCommitmentDeskService: EffectCommitmentDeskService;
}

interface RuntimeCoreAssemblyOptions {
  cwd: string;
  workspaceRoot: string;
  config: BrewvaConfig;
  recordEvent(input: RuntimeRecordEventInput): BrewvaEventRecord | undefined;
  getCurrentTurn(sessionId: string): number;
}

interface RuntimeKernelAssemblyOptions {
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

interface RuntimeServiceAssemblyOptions {
  cwd: string;
  workspaceRoot: string;
  agentId: string;
  config: BrewvaConfig;
  governancePort?: GovernancePort;
  kernel: RuntimeKernelContext;
  coreDependencies: RuntimeCoreDependencies;
  sessionState: RuntimeSessionStateStore;
  resolveToolGovernanceDescriptor: (toolName: string) => ToolGovernanceDescriptor | undefined;
  resolveToolGovernanceSource: (toolName: string) => ToolGovernanceDescriptorSource;
  resolveToolExecutionBoundary: (toolName: string) => ToolExecutionBoundary;
  resolveCheckpointCostSummary(sessionId: string): SessionCostSummary;
  resolveCheckpointCostSkillLastTurnByName(sessionId: string): Record<string, number>;
  evaluateCompletion(sessionId: string, level?: VerificationLevel): VerificationReport;
}

function normalizeReasonList(
  input: { reason?: string; reasons?: string[] } | undefined,
  fallback: string,
): string[] {
  const values = [
    ...(input?.reasons ?? []),
    ...(typeof input?.reason === "string" ? [input.reason] : []),
  ]
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  if (values.length === 0) {
    return [fallback];
  }
  return [...new Set(values)];
}

function normalizePolicyBasis(values: readonly string[] | undefined, fallback: string): string[] {
  const normalized = (values ?? [])
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  if (normalized.length === 0) {
    return [fallback];
  }
  return [...new Set(normalized)];
}

function buildKernelEffectCommitmentDecision(input: {
  descriptor: ToolGovernanceDescriptor;
  toolName: string;
}): EffectCommitmentAuthorizationDecision {
  const effectSet = new Set(input.descriptor.effects);
  const toolName = input.toolName;
  const policySuffix =
    effectSet.has("external_network") || effectSet.has("external_side_effect")
      ? "effect_commitment_external_requires_port"
      : effectSet.has("schedule_mutation")
        ? "effect_commitment_schedule_requires_port"
        : effectSet.has("local_exec")
          ? "effect_commitment_local_exec_requires_port"
          : "effect_commitment_unknown_requires_port";

  return {
    decision: "defer",
    policyBasis: ["effect_commitment_kernel_policy", policySuffix],
    reasons: [`effect_commitment_requires_governance_port:${toolName}`],
  };
}

export function createRuntimeCoreDependencies(
  options: RuntimeCoreAssemblyOptions,
): RuntimeCoreDependencies {
  const skillRegistry = new SkillRegistry({
    rootDir: options.cwd,
    config: options.config,
  });
  skillRegistry.load();
  skillRegistry.writeIndex();

  const evidenceLedger = new EvidenceLedger(
    resolve(options.workspaceRoot, options.config.ledger.path),
  );
  const verificationGate = new VerificationGate(options.config);
  const parallel = new ParallelBudgetManager(options.config.parallel);
  const parallelResults = new ParallelResultStore();
  const eventStore = new BrewvaEventStore(
    options.config.infrastructure.events,
    options.workspaceRoot,
  );
  const turnWalStore = new TurnWALStore({
    workspaceRoot: options.workspaceRoot,
    config: options.config.infrastructure.turnWal,
    scope: "runtime",
    recordEvent: (input) => {
      options.recordEvent({
        sessionId: input.sessionId,
        type: input.type,
        payload: input.payload,
        skipTapeCheckpoint: true,
      });
    },
  });
  const contextBudget = new ContextBudgetManager(options.config.infrastructure.contextBudget);
  const contextInjection = new ContextInjectionCollector({
    sourceTokenLimits: {},
    maxEntriesPerSession: options.config.infrastructure.contextBudget.arena.maxEntriesPerSession,
  });
  const turnReplay = new TurnReplayEngine({
    listEvents: (sessionId) => eventStore.list(sessionId),
    getTurn: (sessionId) => options.getCurrentTurn(sessionId),
  });
  const fileChanges = new FileChangeTracker(options.cwd, {
    artifactsBaseDir: options.workspaceRoot,
  });
  const costTracker = new SessionCostTracker(options.config.infrastructure.costTracking);
  const projectionEngine = new ProjectionEngine({
    enabled: options.config.projection.enabled,
    rootDir: resolve(options.workspaceRoot, options.config.projection.dir),
    workingFile: options.config.projection.workingFile,
    maxWorkingChars: options.config.projection.maxWorkingChars,
    listEvents: (sessionId) => eventStore.list(sessionId),
    recordEvent: (eventInput) => options.recordEvent(eventInput),
  });

  return {
    skillRegistry,
    evidenceLedger,
    verificationGate,
    parallel,
    parallelResults,
    eventStore,
    turnWalStore,
    contextBudget,
    contextInjection,
    turnReplay,
    fileChanges,
    costTracker,
    projectionEngine,
  };
}

export function createRuntimeKernelContext(
  options: RuntimeKernelAssemblyOptions,
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

export function createRuntimeServiceDependencies(
  options: RuntimeServiceAssemblyOptions,
): RuntimeServiceDependencies {
  const credentialVaultService = createCredentialVaultServiceFromSecurityConfig(
    options.workspaceRoot,
    options.config.security,
  );
  const taskService = new TaskService({
    config: options.config,
    isContextBudgetEnabled: () => options.kernel.isContextBudgetEnabled(),
    resolveContextBudgetThresholds: (sessionId, usage) => ({
      compactionThresholdPercent:
        options.kernel.contextBudget.getEffectiveCompactionThresholdPercent(sessionId, usage),
      hardLimitPercent: options.kernel.contextBudget.getEffectiveHardLimitPercent(sessionId, usage),
    }),
    getTaskState: (sessionId) => options.kernel.getTaskState(sessionId),
    getTruthState: (sessionId) => options.kernel.getTruthState(sessionId),
    evaluateCompletion: (sessionId, level) => options.evaluateCompletion(sessionId, level),
    recordEvent: (input) => options.kernel.recordEvent(input),
  });
  options.coreDependencies.verificationGate.bindSessionIntrospection({
    cwd: options.cwd,
    workspaceRoot: options.workspaceRoot,
    getTaskState: (sessionId) => options.kernel.getTaskState(sessionId),
    getTargetRoots: (sessionId) =>
      resolveTaskTargetRoots({
        cwd: options.cwd,
        workspaceRoot: options.workspaceRoot,
        spec: options.kernel.getTaskState(sessionId).spec,
      }),
  });
  const skillLifecycleService = new SkillLifecycleService({
    skills: options.coreDependencies.skillRegistry,
    sessionState: options.sessionState,
    getCurrentTurn: (sessionId) => options.kernel.getCurrentTurn(sessionId),
    getTaskState: (sessionId) => options.kernel.getTaskState(sessionId),
    recordEvent: (input) => options.kernel.recordEvent(input),
    setTaskSpec: (sessionId, spec) => taskService.setTaskSpec(sessionId, spec),
  });
  const truthService = new TruthService({
    getTruthState: (sessionId) => options.kernel.getTruthState(sessionId),
    recordEvent: (input) => options.kernel.recordEvent(input),
  });
  const effectCommitmentDeskService = new EffectCommitmentDeskService({
    getCurrentTurn: (sessionId) => options.kernel.getCurrentTurn(sessionId),
    listEvents: (sessionId) => options.coreDependencies.eventStore.list(sessionId),
    recordEvent: (input) => options.kernel.recordEvent(input),
  });
  const ledgerService = new LedgerService({
    config: options.config,
    evidenceLedger: options.coreDependencies.evidenceLedger,
    sessionState: options.sessionState,
    getCurrentTurn: (sessionId) => options.kernel.getCurrentTurn(sessionId),
    recordEvent: (input) => options.kernel.recordEvent(input),
    skillLifecycleService,
    effectCommitmentDeskService,
  });
  const resourceLeaseService = new ResourceLeaseService({
    sessionState: options.sessionState,
    getCurrentTurn: (sessionId) => options.kernel.getCurrentTurn(sessionId),
    recordEvent: (input) => options.kernel.recordEvent(input),
    skillLifecycleService,
  });
  const costService = new CostService({
    costTracker: options.coreDependencies.costTracker,
    getCurrentTurn: (sessionId) => options.kernel.getCurrentTurn(sessionId),
    recordEvent: (input) => options.kernel.recordEvent(input),
    ledgerService,
    skillLifecycleService,
    governancePort: options.governancePort,
  });
  const verificationService = new VerificationService({
    cwd: options.cwd,
    config: options.config,
    verificationGate: options.coreDependencies.verificationGate,
    getTaskState: (sessionId) => options.kernel.getTaskState(sessionId),
    recordEvent: (input) => options.kernel.recordEvent(input),
    governancePort: options.governancePort,
    skillLifecycleService,
    ledgerService,
  });
  const proposalAdmissionService = new ProposalAdmissionService({
    listDecisionReceiptEvents: (sessionId) =>
      options.coreDependencies.eventStore.list(sessionId, {
        type: DECISION_RECEIPT_RECORDED_EVENT_TYPE,
      }),
    recordEvent: (input) => options.kernel.recordEvent(input),
    getCurrentTurn: (sessionId) => options.kernel.getCurrentTurn(sessionId),
    resolveToolGovernanceDescriptor: (toolName) =>
      options.resolveToolGovernanceDescriptor(toolName),
    effectCommitmentAuthorizer: ({ sessionId, proposal, descriptor, turn }) => {
      const toolName = proposal.payload.toolName.trim() || proposal.subject.trim();
      const governanceDecision = options.governancePort?.authorizeEffectCommitment?.({
        sessionId,
        proposal,
        turn,
      });
      if (governanceDecision !== undefined) {
        const decision =
          governanceDecision.decision === "accept" ||
          governanceDecision.decision === "reject" ||
          governanceDecision.decision === "defer"
            ? governanceDecision.decision
            : "reject";
        return {
          decision,
          policyBasis: normalizePolicyBasis(
            governanceDecision.policyBasis,
            "effect_commitment_governance_port",
          ),
          reasons: normalizeReasonList(
            governanceDecision,
            `effect_commitment_${decision}:${toolName}`,
          ),
        };
      }
      if (options.governancePort) {
        return buildKernelEffectCommitmentDecision({
          descriptor,
          toolName,
        });
      }
      return effectCommitmentDeskService.authorize({
        sessionId,
        proposal,
        descriptor,
        turn,
      });
    },
  });
  const contextSourceProviders = new ContextSourceProviderRegistry();
  registerBuiltInContextSourceProviders(contextSourceProviders, {
    workspaceRoot: options.workspaceRoot,
    agentId: options.agentId,
    kernel: options.kernel,
    skillLifecycleService,
  });
  const contextService = new ContextService({
    config: options.config,
    contextBudget: options.coreDependencies.contextBudget,
    contextInjection: options.coreDependencies.contextInjection,
    sessionState: options.sessionState,
    getTruthState: (sessionId) => options.kernel.getTruthState(sessionId),
    getCurrentTurn: (sessionId) => options.kernel.getCurrentTurn(sessionId),
    sanitizeInput: (text) => options.kernel.sanitizeInput(text),
    recordEvent: (input) => options.kernel.recordEvent(input),
    alwaysAllowedTools: CONTEXT_CRITICAL_ALLOWED_TOOLS,
    contextSourceProviders,
    ledgerService,
    skillLifecycleService,
    taskService,
    governancePort: options.governancePort,
  });
  const taskWatchdogService = new TaskWatchdogService({
    listEvents: (sessionId, query) => options.coreDependencies.eventStore.list(sessionId, query),
    getTaskState: (sessionId) => options.kernel.getTaskState(sessionId),
    getCurrentTurn: (sessionId) => options.kernel.getCurrentTurn(sessionId),
    recordEvent: (input) => options.kernel.recordEvent(input),
  });
  const reversibleMutationService = new ReversibleMutationService({
    getCurrentTurn: (sessionId) => options.kernel.getCurrentTurn(sessionId),
    recordEvent: (input) => options.kernel.recordEvent(input),
    resolveToolGovernanceDescriptor: (toolName) =>
      options.resolveToolGovernanceDescriptor(toolName),
  });
  const tapeService = new TapeService({
    tapeConfig: options.config.tape,
    sessionState: options.sessionState,
    queryEvents: (sessionId, query) => options.coreDependencies.eventStore.list(sessionId, query),
    getCurrentTurn: (sessionId) => options.kernel.getCurrentTurn(sessionId),
    getTaskState: (sessionId) => options.kernel.getTaskState(sessionId),
    getTruthState: (sessionId) => options.kernel.getTruthState(sessionId),
    getCostSummary: (sessionId) => options.resolveCheckpointCostSummary(sessionId),
    getCostSkillLastTurnByName: (sessionId) =>
      options.resolveCheckpointCostSkillLastTurnByName(sessionId),
    getCheckpointEvidenceState: (sessionId) =>
      options.coreDependencies.turnReplay.getCheckpointEvidenceState(sessionId),
    getCheckpointProjectionState: (sessionId) =>
      options.coreDependencies.turnReplay.getCheckpointProjectionState(sessionId),
    recordEvent: (input) => options.kernel.recordEvent(input),
  });
  const eventPipeline = new EventPipelineService({
    events: options.coreDependencies.eventStore,
    level: options.config.infrastructure.events.level,
    inferEventCategory,
    observeReplayEvent: (event) => options.coreDependencies.turnReplay.observeEvent(event),
    ingestProjectionEvent: (event) => options.coreDependencies.projectionEngine.ingestEvent(event),
    maybeRecordTapeCheckpoint: (event) => tapeService.maybeRecordTapeCheckpoint(event),
  });
  const truthProjectorService = new TruthProjectorService({
    cwd: options.cwd,
    getTaskState: (sessionId) => options.kernel.getTaskState(sessionId),
    getTruthState: (sessionId) => options.kernel.getTruthState(sessionId),
    eventPipeline,
    taskService,
    truthService,
  });
  const verificationProjectorService = new VerificationProjectorService({
    getTaskState: (sessionId) => options.kernel.getTaskState(sessionId),
    getTruthState: (sessionId) => options.kernel.getTruthState(sessionId),
    verificationStateStore: options.coreDependencies.verificationGate.stateStore,
    eventPipeline,
    taskService,
    truthService,
  });
  const scheduleIntentService = new ScheduleIntentService({
    createManager: () =>
      new SchedulerService({
        runtime: {
          workspaceRoot: options.workspaceRoot,
          scheduleConfig: options.config.schedule,
          listSessionIds: () => options.coreDependencies.eventStore.listSessionIds(),
          listEvents: (sessionId, query) =>
            options.coreDependencies.eventStore.list(sessionId, query),
          recordEvent: (input) => eventPipeline.recordEvent(input),
          subscribeEvents: (listener) => eventPipeline.subscribeEvents(listener),
          getTruthState: (sessionId) => options.kernel.getTruthState(sessionId),
          getTaskState: (sessionId) => options.kernel.getTaskState(sessionId),
          turnWal: {
            appendPending: (envelope, source, walOptions) =>
              options.coreDependencies.turnWalStore.appendPending(envelope, source, walOptions),
            markInflight: (walId) => options.coreDependencies.turnWalStore.markInflight(walId),
            markDone: (walId) => options.coreDependencies.turnWalStore.markDone(walId),
            markFailed: (walId, error) =>
              options.coreDependencies.turnWalStore.markFailed(walId, error),
            markExpired: (walId) => options.coreDependencies.turnWalStore.markExpired(walId),
            listPending: () => options.coreDependencies.turnWalStore.listPending(),
          },
        },
        enableExecution: false,
      }),
  });
  const fileChangeService = new FileChangeService({
    sessionState: options.sessionState,
    fileChanges: options.coreDependencies.fileChanges,
    costTracker: options.coreDependencies.costTracker,
    getCurrentTurn: (sessionId) => options.kernel.getCurrentTurn(sessionId),
    recordEvent: (input) => options.kernel.recordEvent(input),
    ledgerService,
    skillLifecycleService,
    reversibleMutationService,
  });
  const parallelService = new ParallelService({
    workspaceRoot: options.workspaceRoot,
    securityConfig: options.config.security,
    parallel: options.coreDependencies.parallel,
    parallelResults: options.coreDependencies.parallelResults,
    sessionState: options.sessionState,
    eventStore: options.coreDependencies.eventStore,
    getCurrentTurn: (sessionId) => options.kernel.getCurrentTurn(sessionId),
    recordEvent: (input) => options.kernel.recordEvent(input),
    fileChangeService,
    resourceLeaseService,
    skillLifecycleService,
  });
  const mutationRollbackService = new MutationRollbackService({
    getCurrentTurn: (sessionId) => options.kernel.getCurrentTurn(sessionId),
    recordEvent: (input) => options.kernel.recordEvent(input),
    reversibleMutationService,
    fileChangeService,
  });
  const sessionLifecycleService = new SessionLifecycleService({
    sessionState: options.sessionState,
    contextBudget: options.coreDependencies.contextBudget,
    contextInjection: options.coreDependencies.contextInjection,
    fileChanges: options.coreDependencies.fileChanges,
    verificationGate: options.coreDependencies.verificationGate,
    parallel: options.coreDependencies.parallel,
    parallelResults: options.coreDependencies.parallelResults,
    costTracker: options.coreDependencies.costTracker,
    projectionEngine: options.coreDependencies.projectionEngine,
    turnReplay: options.coreDependencies.turnReplay,
    eventStore: options.coreDependencies.eventStore,
    evidenceLedger: options.coreDependencies.evidenceLedger,
    recordEvent: (input) => options.kernel.recordEvent(input),
    contextService,
  });
  const toolGateService = new ToolGateService({
    workspaceRoot: options.workspaceRoot,
    securityConfig: options.config.security,
    costTracker: options.coreDependencies.costTracker,
    sessionState: options.sessionState,
    getCurrentTurn: (sessionId) => options.kernel.getCurrentTurn(sessionId),
    recordEvent: (input) => options.kernel.recordEvent(input),
    alwaysAllowedTools: CONTROL_PLANE_TOOLS,
    resolveToolGovernanceDescriptor: (toolName) =>
      options.resolveToolGovernanceDescriptor(toolName),
    resolveToolGovernanceSource: (toolName) => options.resolveToolGovernanceSource(toolName),
    resolveToolExecutionBoundary: (toolName) => options.resolveToolExecutionBoundary(toolName),
    resourceLeaseService,
    skillLifecycleService,
    contextService,
    proposalAdmissionService,
    effectCommitmentDeskService,
  });
  const toolInvocationSpine = new ToolInvocationSpine({
    toolGateService,
    fileChangeService,
    ledgerService,
    reversibleMutationService,
  });
  sessionLifecycleService.onClearState((sessionId) => {
    reversibleMutationService.clear(sessionId);
    effectCommitmentDeskService.clear(sessionId);
  });

  return {
    credentialVaultService,
    proposalAdmissionService,
    skillLifecycleService,
    taskService,
    truthService,
    ledgerService,
    resourceLeaseService,
    parallelService,
    costService,
    verificationService,
    contextService,
    taskWatchdogService,
    tapeService,
    eventPipeline,
    effectCommitmentDeskService,
    truthProjectorService,
    verificationProjectorService,
    scheduleIntentService,
    fileChangeService,
    mutationRollbackService,
    sessionLifecycleService,
    toolGateService,
    toolInvocationSpine,
  };
}
