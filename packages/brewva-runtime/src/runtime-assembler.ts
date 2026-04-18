import { resolve } from "node:path";
import { RecoveryWalStore } from "./channels/recovery-wal.js";
import { ContextBudgetManager } from "./context/budget.js";
import { registerBuiltInContextSourceProviders } from "./context/builtins.js";
import { ContextInjectionCollector } from "./context/injection.js";
import { ContextSourceProviderRegistry } from "./context/provider.js";
import type { VerificationOutcomeSnapshot } from "./context/runtime-status.js";
import type { ToolOutputDistillationEntry } from "./context/tool-output-distilled.js";
import type {
  BrewvaConfig,
  SessionCostSummary,
  ToolGovernanceDescriptor,
  VerificationLevel,
  VerificationReport,
} from "./contracts/index.js";
import { SessionCostTracker } from "./cost/tracker.js";
import { DECISION_RECEIPT_RECORDED_EVENT_TYPE } from "./events/event-types.js";
import { BrewvaEventStore } from "./events/store.js";
import type { GovernancePort } from "./governance/port.js";
import type { ResolvedToolAuthority } from "./governance/tool-governance.js";
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
import { EventPipelineService, type RuntimeRecordEvent } from "./services/event-pipeline.js";
import { FileChangeService } from "./services/file-change.js";
import { LedgerService } from "./services/ledger.js";
import { MutationRollbackService } from "./services/mutation-rollback.js";
import { ParallelService } from "./services/parallel.js";
import type { EffectCommitmentAuthorizationDecision } from "./services/proposal-admission-effect-commitment.js";
import { ProposalAdmissionService } from "./services/proposal-admission.js";
import { ReasoningService } from "./services/reasoning.js";
import { ResourceLeaseService } from "./services/resource-lease.js";
import { ReversibleMutationService } from "./services/reversible-mutation.js";
import { ScheduleIntentService } from "./services/schedule-intent.js";
import { SessionLifecycleService } from "./services/session-lifecycle.js";
import type { RuntimeSessionStateStore } from "./services/session-state.js";
import { SessionWireService } from "./services/session-wire.js";
import { SkillLifecycleService } from "./services/skill-lifecycle.js";
import { TapeService } from "./services/tape.js";
import { TaskWatchdogService } from "./services/task-watchdog.js";
import { TaskService } from "./services/task.js";
import { ToolAccessPolicyService } from "./services/tool-access-policy.js";
import { ToolGateService } from "./services/tool-gate.js";
import { ToolInvocationSpine } from "./services/tool-invocation-spine.js";
import { ToolLifecycleRecoveryWalService } from "./services/tool-lifecycle-recovery-wal.js";
import { ToolStartReadinessService } from "./services/tool-start-readiness.js";
import { TruthProjectorService } from "./services/truth-projector.js";
import { TruthService } from "./services/truth.js";
import { VerificationProjectorService } from "./services/verification-projector.js";
import { VerificationService } from "./services/verification.js";
import { SkillRegistry } from "./skills/registry.js";
import { SkillValidationContextBuilder } from "./skills/validation/builders/validation-context-builder.js";
import { SkillOutputValidationPipeline } from "./skills/validation/pipeline.js";
import { ConsumedOutputBlockingValidator } from "./skills/validation/validators/consumed-output-blocking-validator.js";
import { ContractValidator } from "./skills/validation/validators/contract-validator.js";
import { ImplementationOutputValidator } from "./skills/validation/validators/implementation-validator.js";
import { PlanningOutputValidator } from "./skills/validation/validators/planning-validator.js";
import { QaOutputValidator } from "./skills/validation/validators/qa-validator.js";
import { ReviewOutputValidator } from "./skills/validation/validators/review-validator.js";
import { ShipOutputValidator } from "./skills/validation/validators/ship-validator.js";
import { FileChangeTracker } from "./state/file-change-tracker.js";
import { ReasoningReplayEngine } from "./tape/reasoning-replay.js";
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
  recoveryWalStore: RecoveryWalStore;
  contextBudget: ContextBudgetManager;
  contextInjection: ContextInjectionCollector;
  turnReplay: TurnReplayEngine;
  reasoningReplay: ReasoningReplayEngine;
  fileChanges: FileChangeTracker;
  costTracker: SessionCostTracker;
  projectionEngine: ProjectionEngine;
}

export interface RuntimeServiceDependencies {
  skillLifecycleService: SkillLifecycleService;
  taskService: TaskService;
  truthService: TruthService;
  ledgerService: LedgerService;
  costService: CostService;
  contextService: ContextService;
  taskWatchdogService: TaskWatchdogService;
  eventPipeline: EventPipelineService;
  toolLifecycleRecoveryWalService: ToolLifecycleRecoveryWalService;
  sessionLifecycleService: SessionLifecycleService;
  reversibleMutationService: ReversibleMutationService;
  getTapeService(): TapeService;
  getEffectCommitmentDeskService(): EffectCommitmentDeskService;
  getProposalAdmissionService(): ProposalAdmissionService;
  clearEffectCommitmentDeskState(sessionId: string): void;
}

export interface RuntimeLazyServiceFactories {
  createCredentialVaultService(): CredentialVaultService;
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

interface RuntimeCoreAssemblyOptions {
  cwd: string;
  workspaceRoot: string;
  config: BrewvaConfig;
  recordEvent: RuntimeRecordEvent;
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
  resolveToolAuthority: (toolName: string, args?: Record<string, unknown>) => ResolvedToolAuthority;
  resolveCheckpointCostSummary(sessionId: string): SessionCostSummary;
  resolveCheckpointCostSkillLastTurnByName(sessionId: string): Record<string, number>;
  evaluateCompletion(sessionId: string, level?: VerificationLevel): VerificationReport;
}

interface RuntimeLazyServiceAssemblyOptions {
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
  skillLifecycleService: SkillLifecycleService;
  ledgerService: LedgerService;
  reversibleMutationService: ReversibleMutationService;
  resolveToolAuthority: (toolName: string, args?: Record<string, unknown>) => ResolvedToolAuthority;
}

interface RuntimeProjectionSubscriberBootstrapOptions {
  cwd: string;
  kernel: RuntimeKernelContext;
  verificationGate: VerificationGate;
  eventPipeline: EventPipelineService;
  taskService: TaskService;
  truthService: TruthService;
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

function initializeProjectionSubscribers(
  options: RuntimeProjectionSubscriberBootstrapOptions,
): void {
  const truthProjector = new TruthProjectorService({
    cwd: options.cwd,
    getTaskState: (sessionId) => options.kernel.getTaskState(sessionId),
    getTruthState: (sessionId) => options.kernel.getTruthState(sessionId),
    eventPipeline: options.eventPipeline,
    taskService: options.taskService,
    truthService: options.truthService,
  });
  const verificationProjector = new VerificationProjectorService({
    getTaskState: (sessionId) => options.kernel.getTaskState(sessionId),
    getTruthState: (sessionId) => options.kernel.getTruthState(sessionId),
    verificationStateStore: options.verificationGate.stateStore,
    eventPipeline: options.eventPipeline,
    taskService: options.taskService,
    truthService: options.truthService,
  });

  void truthProjector;
  void verificationProjector;
}

export function createRuntimeCoreDependencies(
  options: RuntimeCoreAssemblyOptions,
): RuntimeCoreDependencies {
  const skillRegistry = new SkillRegistry({
    workspaceRoot: options.workspaceRoot,
    config: options.config,
  });

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
  const recoveryWalStore = new RecoveryWalStore({
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
  const reasoningReplay = new ReasoningReplayEngine({
    listEvents: (sessionId) => eventStore.list(sessionId),
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
    recoveryWalStore,
    contextBudget,
    contextInjection,
    turnReplay,
    reasoningReplay,
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

export function createRuntimeServiceDependencies(
  options: RuntimeServiceAssemblyOptions,
): RuntimeServiceDependencies {
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
    evaluateCompletion: (sessionId) => options.evaluateCompletion(sessionId),
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
  const skillValidationContextBuilder = new SkillValidationContextBuilder({
    skills: options.coreDependencies.skillRegistry,
    sessionState: options.sessionState,
    listEvents: (sessionId) => options.coreDependencies.eventStore.list(sessionId),
  });
  const skillValidationPipeline = new SkillOutputValidationPipeline([
    new ContractValidator(),
    new PlanningOutputValidator(),
    new ConsumedOutputBlockingValidator(),
    new ImplementationOutputValidator(),
    new ReviewOutputValidator(),
    new QaOutputValidator(),
    new ShipOutputValidator(),
  ]);
  const skillLifecycleService = new SkillLifecycleService({
    skills: options.coreDependencies.skillRegistry,
    sessionState: options.sessionState,
    getCurrentTurn: (sessionId) => options.kernel.getCurrentTurn(sessionId),
    getTaskState: (sessionId) => options.kernel.getTaskState(sessionId),
    validationContextBuilder: skillValidationContextBuilder,
    validationPipeline: skillValidationPipeline,
    recordEvent: (input) => options.kernel.recordEvent(input),
    setTaskSpec: (sessionId, spec) => taskService.setTaskSpec(sessionId, spec),
  });
  const truthService = new TruthService({
    getTruthState: (sessionId) => options.kernel.getTruthState(sessionId),
    recordEvent: (input) => options.kernel.recordEvent(input),
  });
  let effectCommitmentDeskService: EffectCommitmentDeskService | undefined;
  const getEffectCommitmentDeskService = (): EffectCommitmentDeskService => {
    effectCommitmentDeskService ??= new EffectCommitmentDeskService({
      getCurrentTurn: (sessionId) => options.kernel.getCurrentTurn(sessionId),
      listEvents: (sessionId) => options.coreDependencies.eventStore.list(sessionId),
      recordEvent: (input) => options.kernel.recordEvent(input),
    });
    return effectCommitmentDeskService;
  };
  const ledgerService = new LedgerService({
    config: options.config,
    evidenceLedger: options.coreDependencies.evidenceLedger,
    sessionState: options.sessionState,
    getCurrentTurn: (sessionId) => options.kernel.getCurrentTurn(sessionId),
    recordEvent: (input) => options.kernel.recordEvent(input),
    skillLifecycleService,
    effectCommitmentDeskService: {
      observeToolOutcome: (input) => getEffectCommitmentDeskService().observeToolOutcome(input),
    },
  });
  const costService = new CostService({
    costTracker: options.coreDependencies.costTracker,
    getCurrentTurn: (sessionId) => options.kernel.getCurrentTurn(sessionId),
    recordEvent: (input) => options.kernel.recordEvent(input),
    ledgerService,
    skillLifecycleService,
    governancePort: options.governancePort,
  });
  let proposalAdmissionService: ProposalAdmissionService | undefined;
  const getProposalAdmissionService = (): ProposalAdmissionService => {
    proposalAdmissionService ??= new ProposalAdmissionService({
      listDecisionReceiptEvents: (sessionId) =>
        options.coreDependencies.eventStore.list(sessionId, {
          type: DECISION_RECEIPT_RECORDED_EVENT_TYPE,
        }),
      recordEvent: (input) => options.kernel.recordEvent(input),
      getCurrentTurn: (sessionId) => options.kernel.getCurrentTurn(sessionId),
      resolveToolAuthority: (toolName) => options.resolveToolAuthority(toolName),
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
          if (decision === "defer") {
            const deskDecision = getEffectCommitmentDeskService().authorize({
              sessionId,
              proposal,
              descriptor,
              turn,
            });
            const combinedDecision =
              deskDecision.decision === "accept" || deskDecision.decision === "reject"
                ? deskDecision.decision
                : "defer";
            return {
              decision: combinedDecision,
              requestId: deskDecision.requestId,
              policyBasis: normalizePolicyBasis(
                [...(governanceDecision.policyBasis ?? []), ...(deskDecision.policyBasis ?? [])],
                "effect_commitment_governance_port",
              ),
              reasons: normalizePolicyBasis(
                [
                  ...normalizeReasonList(governanceDecision, `effect_commitment_defer:${toolName}`),
                  ...(deskDecision.reasons ?? []),
                ],
                `effect_commitment_${combinedDecision}:${toolName}`,
              ),
              committedEffects: deskDecision.committedEffects,
            };
          }
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
        return getEffectCommitmentDeskService().authorize({
          sessionId,
          proposal,
          descriptor,
          turn,
        });
      },
    });
    return proposalAdmissionService;
  };
  const contextSourceProviders = new ContextSourceProviderRegistry();
  registerBuiltInContextSourceProviders(contextSourceProviders, {
    workspaceRoot: options.workspaceRoot,
    agentId: options.agentId,
    kernel: options.kernel,
    skillLifecycleService,
    skillRegistry: options.coreDependencies.skillRegistry,
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
    resolveToolAuthority: (toolName) => options.resolveToolAuthority(toolName),
  });
  let tapeService: TapeService | undefined;
  const getTapeService = (): TapeService => {
    tapeService ??= new TapeService({
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
    return tapeService;
  };
  const eventPipeline = new EventPipelineService({
    events: options.coreDependencies.eventStore,
    level: options.config.infrastructure.events.level,
    inferEventCategory,
    observeReplayEvent: (event) => {
      options.coreDependencies.turnReplay.observeEvent(event);
      options.coreDependencies.reasoningReplay.observeEvent(event);
    },
    ingestProjectionEvent: (event) => options.coreDependencies.projectionEngine.ingestEvent(event),
    maybeRecordTapeCheckpoint: (event) => getTapeService().maybeRecordTapeCheckpoint(event),
  });
  initializeProjectionSubscribers({
    cwd: options.cwd,
    kernel: options.kernel,
    verificationGate: options.coreDependencies.verificationGate,
    eventPipeline,
    taskService,
    truthService,
  });
  const toolLifecycleRecoveryWalService = new ToolLifecycleRecoveryWalService({
    recoveryWalStore: options.coreDependencies.recoveryWalStore,
    eventPipeline,
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
    recoveryWalStore: options.coreDependencies.recoveryWalStore,
    reversibleMutationService,
    recordEvent: (input) => options.kernel.recordEvent(input),
    contextService,
  });
  sessionLifecycleService.onClearState((sessionId) => {
    toolLifecycleRecoveryWalService.clearSession(sessionId);
    reversibleMutationService.clear(sessionId);
    effectCommitmentDeskService?.clear(sessionId);
    options.coreDependencies.reasoningReplay.clear(sessionId);
  });

  return {
    skillLifecycleService,
    taskService,
    truthService,
    ledgerService,
    costService,
    contextService,
    taskWatchdogService,
    eventPipeline,
    toolLifecycleRecoveryWalService,
    reversibleMutationService,
    sessionLifecycleService,
    getTapeService,
    getEffectCommitmentDeskService,
    getProposalAdmissionService,
    clearEffectCommitmentDeskState: (sessionId: string) => {
      effectCommitmentDeskService?.clear(sessionId);
    },
  };
}

export function createRuntimeLazyServiceFactories(
  options: RuntimeLazyServiceAssemblyOptions,
): RuntimeLazyServiceFactories {
  let resourceLeaseService: ResourceLeaseService | undefined;
  const getResourceLeaseService = (): ResourceLeaseService => {
    resourceLeaseService ??= new ResourceLeaseService({
      sessionState: options.sessionState,
      getCurrentTurn: (sessionId) => options.kernel.getCurrentTurn(sessionId),
      recordEvent: (input) => options.kernel.recordEvent(input),
      skillLifecycleService: options.skillLifecycleService,
    });
    return resourceLeaseService;
  };

  let fileChangeService: FileChangeService | undefined;
  const getFileChangeService = (): FileChangeService => {
    fileChangeService ??= new FileChangeService({
      sessionState: options.sessionState,
      fileChanges: options.coreDependencies.fileChanges,
      costTracker: options.coreDependencies.costTracker,
      getCurrentTurn: (sessionId) => options.kernel.getCurrentTurn(sessionId),
      recordEvent: (input) => options.kernel.recordEvent(input),
      ledgerService: options.ledgerService,
      skillLifecycleService: options.skillLifecycleService,
      reversibleMutationService: options.reversibleMutationService,
    });
    return fileChangeService;
  };

  let parallelService: ParallelService | undefined;
  const getParallelService = (): ParallelService => {
    parallelService ??= new ParallelService({
      workspaceRoot: options.workspaceRoot,
      securityConfig: options.config.security,
      parallel: options.coreDependencies.parallel,
      parallelResults: options.coreDependencies.parallelResults,
      sessionState: options.sessionState,
      eventStore: options.coreDependencies.eventStore,
      subscribeEvents: (listener) => options.eventPipeline.subscribeEvents(listener),
      getCurrentTurn: (sessionId) => options.kernel.getCurrentTurn(sessionId),
      recordEvent: (input) => options.kernel.recordEvent(input),
      fileChangeService: getFileChangeService(),
      resourceLeaseService: getResourceLeaseService(),
      skillLifecycleService: options.skillLifecycleService,
    });
    return parallelService;
  };

  let mutationRollbackService: MutationRollbackService | undefined;
  const getMutationRollbackService = (): MutationRollbackService => {
    mutationRollbackService ??= new MutationRollbackService({
      getCurrentTurn: (sessionId) => options.kernel.getCurrentTurn(sessionId),
      recordEvent: (input) => options.kernel.recordEvent(input),
      reversibleMutationService: options.reversibleMutationService,
      fileChangeService: getFileChangeService(),
    });
    return mutationRollbackService;
  };

  let toolAccessPolicyService: ToolAccessPolicyService | undefined;
  const getToolAccessPolicyService = (): ToolAccessPolicyService => {
    toolAccessPolicyService ??= new ToolAccessPolicyService({
      securityConfig: options.config.security,
      costTracker: options.coreDependencies.costTracker,
      sessionState: options.sessionState,
      getCurrentTurn: (sessionId) => options.kernel.getCurrentTurn(sessionId),
      recordEvent: (input) => options.kernel.recordEvent(input),
      alwaysAllowedTools: CONTROL_PLANE_TOOLS,
      resolveToolAuthority: (toolName, args) => options.resolveToolAuthority(toolName, args),
      resourceLeaseService: getResourceLeaseService(),
      skillLifecycleService: options.skillLifecycleService,
      hasRoutingScope: (scope) => options.config.skills.routing.scopes.includes(scope),
    });
    return toolAccessPolicyService;
  };

  let toolStartReadinessService: ToolStartReadinessService | undefined;
  const getToolStartReadinessService = (): ToolStartReadinessService => {
    toolStartReadinessService ??= new ToolStartReadinessService({
      contextService: options.contextService,
    });
    return toolStartReadinessService;
  };

  let toolGateService: ToolGateService | undefined;
  const getToolGateService = (): ToolGateService => {
    toolGateService ??= new ToolGateService({
      workspaceRoot: options.workspaceRoot,
      securityConfig: options.config.security,
      sessionState: options.sessionState,
      getCurrentTurn: (sessionId) => options.kernel.getCurrentTurn(sessionId),
      recordEvent: (input) => options.kernel.recordEvent(input),
      resolveToolAuthority: (toolName, args) => options.resolveToolAuthority(toolName, args),
      toolAccessPolicyService: getToolAccessPolicyService(),
      skillLifecycleService: options.skillLifecycleService,
      proposalAdmissionService: {
        submitProposal: (sessionId, proposal) =>
          options.getProposalAdmissionService().submitProposal(sessionId, proposal),
      },
      effectCommitmentDeskService: {
        prepareResume: (input) => options.getEffectCommitmentDeskService().prepareResume(input),
        getRequestIdForProposal: (sessionId, proposalId) =>
          options.getEffectCommitmentDeskService().getRequestIdForProposal(sessionId, proposalId),
      },
    });
    return toolGateService;
  };

  let toolInvocationSpine: ToolInvocationSpine | undefined;
  const getToolInvocationSpine = (): ToolInvocationSpine => {
    toolInvocationSpine ??= new ToolInvocationSpine({
      toolStartReadinessService: getToolStartReadinessService(),
      toolGateService: getToolGateService(),
      fileChangeService: getFileChangeService(),
      ledgerService: options.ledgerService,
      reversibleMutationService: options.reversibleMutationService,
    });
    return toolInvocationSpine;
  };

  return {
    createCredentialVaultService: () =>
      createCredentialVaultServiceFromSecurityConfig(
        options.workspaceRoot,
        options.config.security,
      ),
    createFileChangeService: () => getFileChangeService(),
    createMutationRollbackService: () => getMutationRollbackService(),
    createParallelService: () => getParallelService(),
    createReasoningService: () =>
      new ReasoningService({
        replay: options.coreDependencies.reasoningReplay,
        getCurrentTurn: (sessionId) => options.kernel.getCurrentTurn(sessionId),
        recordEvent: (input) => options.kernel.recordEvent(input),
      }),
    createResourceLeaseService: () => getResourceLeaseService(),
    createScheduleIntentService: () =>
      new ScheduleIntentService({
        createManager: () =>
          new SchedulerService({
            runtime: {
              workspaceRoot: options.workspaceRoot,
              scheduleConfig: options.config.schedule,
              listSessionIds: () => options.coreDependencies.eventStore.listSessionIds(),
              listEvents: (sessionId, query) =>
                options.coreDependencies.eventStore.list(sessionId, query),
              recordEvent: (input) => options.eventPipeline.recordEvent(input),
              subscribeEvents: (listener) => options.eventPipeline.subscribeEvents(listener),
              getTruthState: (sessionId) => options.kernel.getTruthState(sessionId),
              getTaskState: (sessionId) => options.kernel.getTaskState(sessionId),
              recoveryWal: {
                appendPending: (envelope, source, walOptions) =>
                  options.coreDependencies.recoveryWalStore.appendPending(
                    envelope,
                    source,
                    walOptions,
                  ),
                markInflight: (walId) =>
                  options.coreDependencies.recoveryWalStore.markInflight(walId),
                markDone: (walId) => options.coreDependencies.recoveryWalStore.markDone(walId),
                markFailed: (walId, error) =>
                  options.coreDependencies.recoveryWalStore.markFailed(walId, error),
                markExpired: (walId) =>
                  options.coreDependencies.recoveryWalStore.markExpired(walId),
                listPending: () => options.coreDependencies.recoveryWalStore.listPending(),
              },
            },
            enableExecution: false,
          }),
      }),
    createSessionWireService: () =>
      new SessionWireService({
        queryStructuredEvents: (sessionId) =>
          options.eventPipeline.queryStructuredEvents(sessionId),
        subscribeEvents: (listener) => options.eventPipeline.subscribeEvents(listener),
      }),
    createToolGateService: () => getToolGateService(),
    createToolInvocationSpine: () => getToolInvocationSpine(),
    createVerificationService: () =>
      new VerificationService({
        cwd: options.cwd,
        config: options.config,
        verificationGate: options.coreDependencies.verificationGate,
        getTaskState: (sessionId) => options.kernel.getTaskState(sessionId),
        recordEvent: (input) => options.kernel.recordEvent(input),
        governancePort: options.governancePort,
        skillLifecycleService: options.skillLifecycleService,
        ledgerService: options.ledgerService,
      }),
  };
}
