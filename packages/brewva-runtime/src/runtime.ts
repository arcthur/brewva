import { resolve } from "node:path";
import { RecoveryWalRecovery } from "./channels/recovery-wal-recovery.js";
import { RecoveryWalStore } from "./channels/recovery-wal.js";
import {
  loadBrewvaConfigResolution,
  normalizeExplicitBrewvaConfigResolution,
  type BrewvaConfigMetadata,
} from "./config/loader.js";
import { resolveWorkspaceRootDir } from "./config/paths.js";
import { ContextBudgetManager } from "./context/budget.js";
import {
  resolveHistoryViewBaselineView,
  resolveRecoveryWorkingSetView,
} from "./context/dependency-views.js";
import { normalizeAgentId } from "./context/identity.js";
import { ContextInjectionCollector } from "./context/injection.js";
import { HISTORY_VIEW_BASELINE_RESERVED_BUDGET_RATIO } from "./context/reserved-budget.js";
import type { ToolOutputDistillationEntry } from "./context/tool-output-distilled.js";
import type {
  BrewvaEventQuery,
  BrewvaEventRecord,
  BrewvaConfig,
  DeepReadonly,
  HistoryViewBaselineSnapshot,
  RecoveryPostureSnapshot,
  RecoveryWorkingSetSnapshot,
  SkillRefreshInput,
  SkillRefreshResult,
  SkillRoutingScope,
  SessionLifecycleSnapshot,
  SessionCostSummary,
  TaskTargetDescriptor,
  TaskState,
  VerificationLevel,
  VerificationReport,
  TruthState,
} from "./contracts/index.js";
import { SessionCostTracker } from "./cost/tracker.js";
import {
  EFFECT_COMMITMENT_APPROVAL_CONSUMED_EVENT_TYPE,
  EFFECT_COMMITMENT_APPROVAL_DECIDED_EVENT_TYPE,
  EFFECT_COMMITMENT_APPROVAL_REQUESTED_EVENT_TYPE,
  ITERATION_GUARD_RECORDED_EVENT_TYPE,
  ITERATION_METRIC_OBSERVED_EVENT_TYPE,
  SKILL_REFRESH_RECORDED_EVENT_TYPE,
  TOOL_OUTPUT_DISTILLED_EVENT_TYPE,
  VERIFICATION_OUTCOME_RECORDED_EVENT_TYPE,
} from "./events/event-types.js";
import { BrewvaEventStore } from "./events/store.js";
import type { GovernancePort } from "./governance/port.js";
import {
  createToolGovernanceRegistry,
  resolveToolAuthority,
} from "./governance/tool-governance.js";
import {
  applyFactWindow,
  buildGuardResultPayload,
  buildMetricObservationPayload,
  coerceGuardResultPayload,
  coerceMetricObservationPayload,
  filterGuardResultRecords,
  filterMetricObservationRecords,
  getGuardResultEventQuery,
  getMetricObservationEventQuery,
  toGuardResultRecord,
  toMetricObservationRecord,
  type GuardResultInput,
  type GuardResultQuery,
  type GuardResultRecord,
  type IterationFactSessionScope,
  type MetricObservationInput,
  type MetricObservationQuery,
  type MetricObservationRecord,
} from "./iteration/facts.js";
import { EvidenceLedger } from "./ledger/evidence-ledger.js";
import { buildSessionLifecycleSnapshot } from "./lifecycle/session-lifecycle-snapshot.js";
import { ParallelBudgetManager } from "./parallel/budget.js";
import { ParallelResultStore } from "./parallel/results.js";
import { ProjectionEngine } from "./projection/engine.js";
import { deriveOpenToolCallsFromEvents, deriveTransitionState } from "./recovery/read-model.js";
import {
  createRuntimeCoreDependencies as assembleRuntimeCoreDependencies,
  createRuntimeKernelContext as assembleRuntimeKernelContext,
  createRuntimeLazyServiceFactories as assembleRuntimeLazyServiceFactories,
  createRuntimeServiceDependencies as assembleRuntimeServiceDependencies,
  type RuntimeCoreDependencies,
  type RuntimeLazyServiceFactories,
  type RuntimeServiceDependencies,
} from "./runtime-assembler.js";
import type { RuntimeKernelContext } from "./runtime-kernel.js";
import {
  createRuntimeMethodGroups,
  type BrewvaRuntimeMethodGroups,
} from "./runtime-method-groups.js";
import { BREWVA_RUNTIME_METHOD_GROUPS } from "./runtime-symbols.js";
import { sanitizeContextText } from "./security/sanitize.js";
import { ContextService } from "./services/context.js";
import { CostService } from "./services/cost.js";
import type { CredentialVaultService } from "./services/credential-vault.js";
import { EffectCommitmentDeskService } from "./services/effect-commitment-desk.js";
import { EventPipelineService, type RuntimeRecordEventInput } from "./services/event-pipeline.js";
import { FileChangeService } from "./services/file-change.js";
import { LedgerService } from "./services/ledger.js";
import { MutationRollbackService } from "./services/mutation-rollback.js";
import { ParallelService } from "./services/parallel.js";
import { ProposalAdmissionService } from "./services/proposal-admission.js";
import { ReasoningService } from "./services/reasoning.js";
import { ResourceLeaseService } from "./services/resource-lease.js";
import { ReversibleMutationService } from "./services/reversible-mutation.js";
import { ScheduleIntentService } from "./services/schedule-intent.js";
import { SessionLifecycleService } from "./services/session-lifecycle.js";
import { RuntimeSessionStateStore } from "./services/session-state.js";
import { SessionWireService } from "./services/session-wire.js";
import { SkillLifecycleService } from "./services/skill-lifecycle.js";
import { TapeService } from "./services/tape.js";
import { TaskWatchdogService } from "./services/task-watchdog.js";
import { TaskService } from "./services/task.js";
import { ToolGateService } from "./services/tool-gate.js";
import { ToolInvocationSpine } from "./services/tool-invocation-spine.js";
import { ToolLifecycleRecoveryWalService } from "./services/tool-lifecycle-recovery-wal.js";
import { TruthService } from "./services/truth.js";
import { VerificationService } from "./services/verification.js";
import { SkillRegistry } from "./skills/registry.js";
import { ensureBundledSystemSkills } from "./skills/system-install.js";
import { FileChangeTracker } from "./state/file-change-tracker.js";
import { ReasoningReplayEngine } from "./tape/reasoning-replay.js";
import { TurnReplayEngine } from "./tape/replay-engine.js";
import { resolvePrimaryTaskTargetRoot, resolveTaskTargetRoots } from "./task/targeting.js";
import { normalizeToolResultVerdict } from "./utils/tool-result.js";
import { VerificationGate } from "./verification/gate.js";

export interface BrewvaRuntimeOptions {
  cwd?: string;
  configPath?: string;
  config?: BrewvaConfig;
  governancePort?: GovernancePort;
  agentId?: string;
  routingScopes?: SkillRoutingScope[];
  routingDefaultScopes?: SkillRoutingScope[];
}

export interface VerifyCompletionOptions {
  executeCommands?: boolean;
  timeoutMs?: number;
}

type RuntimeConfigState = {
  config: BrewvaConfig;
  readonlyConfig: DeepReadonly<BrewvaConfig>;
  metadata: DeepReadonly<BrewvaConfigMetadata>;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepFreezeValue<T>(value: T): DeepReadonly<T> {
  if (Array.isArray(value)) {
    for (const entry of value) {
      deepFreezeValue(entry);
    }
    return Object.freeze(value) as DeepReadonly<T>;
  }
  if (isPlainObject(value)) {
    for (const entry of Object.values(value)) {
      deepFreezeValue(entry);
    }
    return Object.freeze(value) as DeepReadonly<T>;
  }
  return value as DeepReadonly<T>;
}

function bindMethods<TObject extends object, const TKeys extends readonly (keyof TObject)[]>(
  owner: TObject,
  keys: TKeys,
): Pick<TObject, TKeys[number]> {
  const result = {} as Pick<TObject, TKeys[number]>;
  for (const key of keys) {
    const value = owner[key];
    if (typeof value !== "function") {
      throw new Error(`Expected method at key ${String(key)}`);
    }
    // These methods belong to semantic method groups, not to the BrewvaRuntime instance itself.
    // Binding here preserves the group receiver when callers destructure narrowed surface ports.
    (result as unknown as Record<string, unknown>)[String(key)] = value.bind(owner);
  }
  return result;
}

const LIFECYCLE_APPROVAL_CACHE_EVENT_TYPES = new Set<string>([
  EFFECT_COMMITMENT_APPROVAL_REQUESTED_EVENT_TYPE,
  EFFECT_COMMITMENT_APPROVAL_DECIDED_EVENT_TYPE,
  EFFECT_COMMITMENT_APPROVAL_CONSUMED_EVENT_TYPE,
]);

export interface BrewvaRuntimeIdentity {
  readonly cwd: string;
  readonly workspaceRoot: string;
  readonly agentId: string;
  readonly config: DeepReadonly<BrewvaConfig>;
}
export interface BrewvaAuthorityPort {
  readonly skills: Pick<
    BrewvaRuntimeMethodGroups["skills"],
    "activate" | "recordCompletionFailure" | "complete"
  >;
  readonly proposals: Pick<
    BrewvaRuntimeMethodGroups["proposals"],
    "submit" | "decideEffectCommitment"
  >;
  readonly reasoning: Pick<BrewvaRuntimeMethodGroups["reasoning"], "recordCheckpoint" | "revert">;
  readonly tools: Pick<
    BrewvaRuntimeMethodGroups["tools"],
    | "start"
    | "finish"
    | "acquireParallelSlot"
    | "acquireParallelSlotAsync"
    | "releaseParallelSlot"
    | "requestResourceLease"
    | "cancelResourceLease"
    | "markCall"
    | "trackCallStart"
    | "trackCallEnd"
    | "rollbackLastPatchSet"
    | "rollbackLastMutation"
    | "recordResult"
  >;
  readonly task: Pick<
    BrewvaRuntimeMethodGroups["task"],
    "setSpec" | "addItem" | "updateItem" | "recordBlocker" | "recordAcceptance" | "resolveBlocker"
  >;
  readonly truth: Pick<BrewvaRuntimeMethodGroups["truth"], "upsertFact" | "resolveFact">;
  readonly schedule: Pick<
    BrewvaRuntimeMethodGroups["schedule"],
    "createIntent" | "cancelIntent" | "updateIntent"
  >;
  readonly events: Pick<
    BrewvaRuntimeMethodGroups["events"],
    "recordMetricObservation" | "recordGuardResult" | "recordTapeHandoff"
  >;
  readonly verification: BrewvaRuntimeMethodGroups["verification"];
  readonly cost: Pick<BrewvaRuntimeMethodGroups["cost"], "recordAssistantUsage">;
  readonly session: Pick<
    BrewvaRuntimeMethodGroups["session"],
    "commitCompaction" | "applyMergedWorkerResults"
  >;
}

export interface BrewvaInspectionPort {
  readonly skills: Pick<
    BrewvaRuntimeMethodGroups["skills"],
    | "getLoadReport"
    | "list"
    | "get"
    | "getActive"
    | "getActiveState"
    | "getLatestFailure"
    | "validateOutputs"
    | "getRawOutputs"
    | "getNormalizedOutputs"
    | "getConsumedOutputs"
  >;
  readonly proposals: Pick<
    BrewvaRuntimeMethodGroups["proposals"],
    "list" | "listEffectCommitmentRequests" | "listPendingEffectCommitments"
  >;
  readonly reasoning: Pick<
    BrewvaRuntimeMethodGroups["reasoning"],
    "getActiveState" | "listCheckpoints" | "getCheckpoint" | "listReverts" | "canRevertTo"
  >;
  readonly context: Pick<
    BrewvaRuntimeMethodGroups["context"],
    | "sanitizeInput"
    | "getUsage"
    | "getPromptStability"
    | "getTransientReduction"
    | "getReservedPrimaryTokens"
    | "getReservedSupplementalTokens"
    | "getUsageRatio"
    | "getHardLimitRatio"
    | "getCompactionThresholdRatio"
    | "getPressureStatus"
    | "getPressureLevel"
    | "getCompactionGateStatus"
    | "checkCompactionGate"
    | "getHistoryViewBaseline"
    | "listProviders"
    | "getPendingCompactionReason"
    | "getCompactionInstructions"
    | "getCompactionWindowTurns"
  >;
  readonly tools: Pick<
    BrewvaRuntimeMethodGroups["tools"],
    | "checkAccess"
    | "explainAccess"
    | "getGovernanceDescriptor"
    | "listResourceLeases"
    | "resolveUndoSessionId"
  >;
  readonly task: Pick<BrewvaRuntimeMethodGroups["task"], "getTargetDescriptor" | "getState">;
  readonly truth: Pick<BrewvaRuntimeMethodGroups["truth"], "getState">;
  readonly ledger: BrewvaRuntimeMethodGroups["ledger"];
  readonly schedule: Pick<
    BrewvaRuntimeMethodGroups["schedule"],
    "listIntents" | "getProjectionSnapshot"
  >;
  readonly recovery: Pick<
    BrewvaRuntimeMethodGroups["recoveryWal"],
    "listPending" | "getPosture" | "getWorkingSet"
  >;
  readonly lifecycle: Pick<BrewvaRuntimeMethodGroups["lifecycle"], "getSnapshot">;
  readonly events: Pick<
    BrewvaRuntimeMethodGroups["events"],
    | "query"
    | "queryStructured"
    | "listMetricObservations"
    | "listGuardResults"
    | "getTapeStatus"
    | "getTapePressureThresholds"
    | "searchTape"
    | "listReplaySessions"
    | "subscribe"
    | "toStructured"
    | "list"
    | "listSessionIds"
  >;
  readonly cost: Pick<BrewvaRuntimeMethodGroups["cost"], "getSummary">;
  readonly session: Pick<
    BrewvaRuntimeMethodGroups["session"],
    | "listWorkerResults"
    | "getOpenToolCalls"
    | "getUncleanShutdownDiagnostic"
    | "mergeWorkerResults"
    | "getHydration"
    | "getIntegrity"
  >;
  readonly sessionWire: Pick<BrewvaRuntimeMethodGroups["sessionWire"], "query" | "subscribe">;
}

export interface BrewvaMaintenancePort {
  readonly skills: Pick<BrewvaRuntimeMethodGroups["skills"], "refresh">;
  readonly context: Pick<
    BrewvaRuntimeMethodGroups["context"],
    | "onTurnStart"
    | "onTurnEnd"
    | "onUserInput"
    | "observeUsage"
    | "observePromptStability"
    | "observeTransientReduction"
    | "registerProvider"
    | "unregisterProvider"
    | "buildInjection"
    | "appendGuardedSupplementalBlocks"
    | "checkAndRequestCompaction"
    | "requestCompaction"
  >;
  readonly tools: Pick<
    BrewvaRuntimeMethodGroups["tools"],
    "registerGovernanceDescriptor" | "registerGovernanceResolver" | "unregisterGovernanceDescriptor"
  >;
  readonly session: Pick<
    BrewvaRuntimeMethodGroups["session"],
    | "recordWorkerResult"
    | "clearWorkerResults"
    | "pollStall"
    | "clearState"
    | "onClearState"
    | "resolveCredentialBindings"
    | "resolveSandboxApiKey"
  >;
  // This is the public maintenance surface over the Recovery WAL implementation.
  readonly recovery: Pick<BrewvaRuntimeMethodGroups["recoveryWal"], "recover" | "compact">;
}

export interface BrewvaHostedRuntimePort extends BrewvaRuntimeIdentity {
  readonly authority: BrewvaAuthorityPort;
  readonly inspect: BrewvaInspectionPort;
  readonly maintain: BrewvaMaintenancePort;
}

export interface BrewvaToolRuntimePort extends BrewvaRuntimeIdentity {
  readonly authority: BrewvaAuthorityPort;
  readonly inspect: BrewvaInspectionPort;
}

export interface BrewvaOperatorRuntimePort extends BrewvaRuntimeIdentity {
  readonly inspect: BrewvaInspectionPort;
  readonly maintain: Pick<BrewvaMaintenancePort, "session" | "recovery">;
}

export class BrewvaRuntime implements BrewvaHostedRuntimePort {
  declare readonly cwd: string;
  declare readonly workspaceRoot: string;
  declare readonly agentId: string;
  declare readonly config: DeepReadonly<BrewvaConfig>;
  declare readonly authority: BrewvaAuthorityPort;
  declare readonly inspect: BrewvaInspectionPort;
  declare readonly maintain: BrewvaMaintenancePort;

  declare private readonly evidenceLedger: EvidenceLedger;
  declare private readonly parallel: ParallelBudgetManager;
  declare private readonly parallelResults: ParallelResultStore;
  declare private readonly contextBudget: ContextBudgetManager;
  declare private readonly contextInjection: ContextInjectionCollector;
  declare private readonly fileChanges: FileChangeTracker;
  declare private readonly costTracker: SessionCostTracker;

  declare private readonly skillRegistry: SkillRegistry;
  declare private readonly verificationGate: VerificationGate;
  declare private readonly eventStore: BrewvaEventStore;
  declare private readonly recoveryWalStore: RecoveryWalStore;
  declare private readonly projectionEngine: ProjectionEngine;

  private readonly sessionState = new RuntimeSessionStateStore();
  private readonly sessionLifecycleSnapshotCache = new Map<string, SessionLifecycleSnapshot>();
  private readonly kernel: RuntimeKernelContext;
  private readonly lazyServiceFactories: RuntimeLazyServiceFactories;
  private readonly clearEffectCommitmentDeskState: (sessionId: string) => void;
  declare private readonly contextService: ContextService;
  declare private readonly costService: CostService;
  declare private readonly eventPipeline: EventPipelineService;
  declare private readonly ledgerService: LedgerService;
  declare private readonly taskWatchdogService: TaskWatchdogService;
  declare private readonly sessionLifecycleService: SessionLifecycleService;
  declare private readonly skillLifecycleService: SkillLifecycleService;
  declare private readonly taskService: TaskService;
  declare private readonly truthService: TruthService;
  declare private readonly toolLifecycleRecoveryWalService: ToolLifecycleRecoveryWalService;
  private readonly tapeServiceGetter: () => TapeService;
  private readonly effectCommitmentDeskServiceGetter: () => EffectCommitmentDeskService;
  private readonly proposalAdmissionServiceGetter: () => ProposalAdmissionService;
  private verificationService: VerificationService | undefined;
  private fileChangeService: FileChangeService | undefined;
  private mutationRollbackService: MutationRollbackService | undefined;
  private parallelService: ParallelService | undefined;
  private resourceLeaseService: ResourceLeaseService | undefined;
  private toolGateService: ToolGateService | undefined;
  private toolInvocationSpine: ToolInvocationSpine | undefined;
  private credentialVaultService: CredentialVaultService | undefined;
  private scheduleIntentService: ScheduleIntentService | undefined;
  private sessionWireService: SessionWireService | undefined;
  private reasoningService: ReasoningService | undefined;
  declare private readonly runtimeConfig: BrewvaConfig;
  private readonly toolGovernanceRegistry = createToolGovernanceRegistry();
  declare private turnReplay: TurnReplayEngine;
  declare private reasoningReplay: ReasoningReplayEngine;

  constructor(options: BrewvaRuntimeOptions = {}) {
    const cwd = resolve(options.cwd ?? process.cwd());
    const workspaceRoot = resolveWorkspaceRootDir(cwd);
    const agentId = normalizeAgentId(options.agentId ?? process.env["BREWVA_AGENT_ID"]);
    this.cwd = cwd;
    this.workspaceRoot = workspaceRoot;
    this.agentId = agentId;

    const configState = this.resolveRuntimeConfig(options);
    this.runtimeConfig = configState.config;
    this.config = configState.readonlyConfig;

    const coreDependencies = this.createCoreDependencies(options);
    this.skillRegistry = coreDependencies.skillRegistry;
    this.evidenceLedger = coreDependencies.evidenceLedger;
    this.verificationGate = coreDependencies.verificationGate;
    this.parallel = coreDependencies.parallel;
    this.parallelResults = coreDependencies.parallelResults;
    this.eventStore = coreDependencies.eventStore;
    this.recoveryWalStore = coreDependencies.recoveryWalStore;
    this.contextBudget = coreDependencies.contextBudget;
    this.contextInjection = coreDependencies.contextInjection;
    this.turnReplay = coreDependencies.turnReplay;
    this.reasoningReplay = coreDependencies.reasoningReplay;
    this.fileChanges = coreDependencies.fileChanges;
    this.costTracker = coreDependencies.costTracker;
    this.projectionEngine = coreDependencies.projectionEngine;

    this.kernel = this.createKernelContext(options);

    const serviceDependencies = this.createServiceDependencies(options);
    this.skillLifecycleService = serviceDependencies.skillLifecycleService;
    this.taskService = serviceDependencies.taskService;
    this.truthService = serviceDependencies.truthService;
    this.ledgerService = serviceDependencies.ledgerService;
    this.costService = serviceDependencies.costService;
    this.contextService = serviceDependencies.contextService;
    this.taskWatchdogService = serviceDependencies.taskWatchdogService;
    this.eventPipeline = serviceDependencies.eventPipeline;
    this.toolLifecycleRecoveryWalService = serviceDependencies.toolLifecycleRecoveryWalService;
    this.sessionLifecycleService = serviceDependencies.sessionLifecycleService;
    this.tapeServiceGetter = () => serviceDependencies.getTapeService();
    this.effectCommitmentDeskServiceGetter = () =>
      serviceDependencies.getEffectCommitmentDeskService();
    this.proposalAdmissionServiceGetter = () => serviceDependencies.getProposalAdmissionService();
    this.clearEffectCommitmentDeskState = (sessionId) =>
      serviceDependencies.clearEffectCommitmentDeskState(sessionId);
    this.lazyServiceFactories = this.createLazyServiceFactories(
      serviceDependencies.reversibleMutationService,
    );

    this.sessionLifecycleService.onClearState((sessionId) => {
      this.invalidateSessionLifecycleSnapshot(sessionId);
    });
    this.refreshSkillsState();
    const methodGroups = this.createMethodGroups();
    attachRuntimeMethodGroupsCarrier(this, methodGroups);
    const surfacePorts = this.createSurfacePorts(methodGroups);
    this.authority = surfacePorts.authority;
    this.inspect = surfacePorts.inspect;
    this.maintain = surfacePorts.maintain;
  }

  private resolveRuntimeConfig(options: BrewvaRuntimeOptions): RuntimeConfigState {
    const resolution = options.config
      ? normalizeExplicitBrewvaConfigResolution(options.config)
      : loadBrewvaConfigResolution({
          cwd: this.cwd,
          configPath: options.configPath,
        });
    const config = resolution.config;

    if (options.routingScopes && options.routingScopes.length > 0) {
      config.skills.routing.enabled = true;
      config.skills.routing.scopes = [...new Set(options.routingScopes)];
    } else if (
      options.routingDefaultScopes &&
      options.routingDefaultScopes.length > 0 &&
      !resolution.metadata.skills.routing.enabledExplicit
    ) {
      config.skills.routing.enabled = true;
      if (!resolution.metadata.skills.routing.scopesExplicit) {
        config.skills.routing.scopes = [...new Set(options.routingDefaultScopes)];
      }
    }

    return {
      config,
      readonlyConfig: deepFreezeValue(config),
      metadata: deepFreezeValue(resolution.metadata),
    };
  }

  private createCoreDependencies(_options: BrewvaRuntimeOptions): RuntimeCoreDependencies {
    return assembleRuntimeCoreDependencies({
      cwd: this.cwd,
      workspaceRoot: this.workspaceRoot,
      config: this.runtimeConfig,
      recordEvent: (input) => this.recordEvent(input),
      getCurrentTurn: (sessionId) => this.getCurrentTurn(sessionId),
    });
  }

  private createKernelContext(options: BrewvaRuntimeOptions): RuntimeKernelContext {
    return assembleRuntimeKernelContext({
      cwd: this.cwd,
      workspaceRoot: this.workspaceRoot,
      agentId: this.agentId,
      config: this.runtimeConfig,
      governancePort: options.governancePort,
      coreDependencies: {
        skillRegistry: this.skillRegistry,
        evidenceLedger: this.evidenceLedger,
        verificationGate: this.verificationGate,
        parallel: this.parallel,
        parallelResults: this.parallelResults,
        eventStore: this.eventStore,
        recoveryWalStore: this.recoveryWalStore,
        contextBudget: this.contextBudget,
        contextInjection: this.contextInjection,
        turnReplay: this.turnReplay,
        reasoningReplay: this.reasoningReplay,
        fileChanges: this.fileChanges,
        costTracker: this.costTracker,
        projectionEngine: this.projectionEngine,
      },
      sessionState: this.sessionState,
      getCurrentTurn: (sessionId) => this.getCurrentTurn(sessionId),
      getTaskState: (sessionId) => this.getTaskState(sessionId),
      getTruthState: (sessionId) => this.getTruthState(sessionId),
      recordEvent: (input) => this.recordEvent(input),
      sanitizeInput: (text) => this.sanitizeInput(text),
      getRecentToolOutputDistillations: (sessionId, maxEntries) =>
        this.getRecentToolOutputDistillations(sessionId, maxEntries),
      getLatestVerificationOutcome: (sessionId) => this.getLatestVerificationOutcome(sessionId),
      isContextBudgetEnabled: () => this.isContextBudgetEnabled(),
    });
  }

  private createServiceDependencies(options: BrewvaRuntimeOptions): RuntimeServiceDependencies {
    return assembleRuntimeServiceDependencies({
      cwd: this.cwd,
      workspaceRoot: this.workspaceRoot,
      agentId: this.agentId,
      config: this.runtimeConfig,
      governancePort: options.governancePort,
      kernel: this.kernel,
      coreDependencies: {
        skillRegistry: this.skillRegistry,
        evidenceLedger: this.evidenceLedger,
        verificationGate: this.verificationGate,
        parallel: this.parallel,
        parallelResults: this.parallelResults,
        eventStore: this.eventStore,
        recoveryWalStore: this.recoveryWalStore,
        contextBudget: this.contextBudget,
        contextInjection: this.contextInjection,
        turnReplay: this.turnReplay,
        reasoningReplay: this.reasoningReplay,
        fileChanges: this.fileChanges,
        costTracker: this.costTracker,
        projectionEngine: this.projectionEngine,
      },
      sessionState: this.sessionState,
      resolveToolAuthority: (toolName, args) =>
        resolveToolAuthority(toolName, this.toolGovernanceRegistry, args),
      resolveCheckpointCostSummary: (sessionId) => this.resolveCheckpointCostSummary(sessionId),
      resolveCheckpointCostSkillLastTurnByName: (sessionId) =>
        this.resolveCheckpointCostSkillLastTurnByName(sessionId),
      evaluateCompletion: (sessionId, level) => this.evaluateCompletion(sessionId, level),
    });
  }

  private createLazyServiceFactories(
    reversibleMutationService: ReversibleMutationService,
  ): RuntimeLazyServiceFactories {
    return assembleRuntimeLazyServiceFactories({
      cwd: this.cwd,
      workspaceRoot: this.workspaceRoot,
      config: this.runtimeConfig,
      governancePort: this.kernel.governancePort,
      kernel: this.kernel,
      coreDependencies: {
        skillRegistry: this.skillRegistry,
        evidenceLedger: this.evidenceLedger,
        verificationGate: this.verificationGate,
        parallel: this.parallel,
        parallelResults: this.parallelResults,
        eventStore: this.eventStore,
        recoveryWalStore: this.recoveryWalStore,
        contextBudget: this.contextBudget,
        contextInjection: this.contextInjection,
        turnReplay: this.turnReplay,
        reasoningReplay: this.reasoningReplay,
        fileChanges: this.fileChanges,
        costTracker: this.costTracker,
        projectionEngine: this.projectionEngine,
      },
      sessionState: this.sessionState,
      eventPipeline: this.eventPipeline,
      contextService: this.contextService,
      getProposalAdmissionService: () => this.getProposalAdmissionService(),
      getEffectCommitmentDeskService: () => this.getEffectCommitmentDeskService(),
      skillLifecycleService: this.skillLifecycleService,
      ledgerService: this.ledgerService,
      reversibleMutationService,
      resolveToolAuthority: (toolName, args) =>
        resolveToolAuthority(toolName, this.toolGovernanceRegistry, args),
    });
  }

  private getCredentialVaultService(): CredentialVaultService {
    this.credentialVaultService ??= this.lazyServiceFactories.createCredentialVaultService();
    return this.credentialVaultService;
  }

  private getScheduleIntentService(): ScheduleIntentService {
    this.scheduleIntentService ??= this.lazyServiceFactories.createScheduleIntentService();
    return this.scheduleIntentService;
  }

  private getSessionWireService(): SessionWireService {
    this.sessionWireService ??= this.lazyServiceFactories.createSessionWireService();
    return this.sessionWireService;
  }

  private getTapeService(): TapeService {
    return this.tapeServiceGetter();
  }

  private getEffectCommitmentDeskService(): EffectCommitmentDeskService {
    return this.effectCommitmentDeskServiceGetter();
  }

  private getProposalAdmissionService(): ProposalAdmissionService {
    return this.proposalAdmissionServiceGetter();
  }

  private getVerificationService(): VerificationService {
    this.verificationService ??= this.lazyServiceFactories.createVerificationService();
    return this.verificationService;
  }

  private getReasoningService(): ReasoningService {
    this.reasoningService ??= this.lazyServiceFactories.createReasoningService();
    return this.reasoningService;
  }

  private getFileChangeService(): FileChangeService {
    this.fileChangeService ??= this.lazyServiceFactories.createFileChangeService();
    return this.fileChangeService;
  }

  private getMutationRollbackService(): MutationRollbackService {
    this.mutationRollbackService ??= this.lazyServiceFactories.createMutationRollbackService();
    return this.mutationRollbackService;
  }

  private getParallelService(): ParallelService {
    this.parallelService ??= this.lazyServiceFactories.createParallelService();
    return this.parallelService;
  }

  private getResourceLeaseService(): ResourceLeaseService {
    this.resourceLeaseService ??= this.lazyServiceFactories.createResourceLeaseService();
    return this.resourceLeaseService;
  }

  private getToolGateService(): ToolGateService {
    this.toolGateService ??= this.lazyServiceFactories.createToolGateService();
    return this.toolGateService;
  }

  private getToolInvocationSpine(): ToolInvocationSpine {
    this.toolInvocationSpine ??= this.lazyServiceFactories.createToolInvocationSpine();
    return this.toolInvocationSpine;
  }

  private createMethodGroups(): BrewvaRuntimeMethodGroups {
    return createRuntimeMethodGroups({
      runtimeConfig: this.runtimeConfig,
      skillRegistry: this.skillRegistry,
      skillLifecycleService: this.skillLifecycleService,
      getProposalAdmissionService: () => this.getProposalAdmissionService(),
      getEffectCommitmentDeskService: () => this.getEffectCommitmentDeskService(),
      contextInjection: this.contextInjection,
      contextService: this.contextService,
      sessionLifecycleService: this.sessionLifecycleService,
      taskWatchdogService: this.taskWatchdogService,
      taskService: this.taskService,
      truthService: this.truthService,
      ledgerService: this.ledgerService,
      recoveryWalStore: this.recoveryWalStore,
      eventStore: this.eventStore,
      eventPipeline: this.eventPipeline,
      costService: this.costService,
      toolGovernanceRegistry: this.toolGovernanceRegistry,
      getReasoningService: () => this.getReasoningService(),
      getToolGateService: () => this.getToolGateService(),
      getToolInvocationSpine: () => this.getToolInvocationSpine(),
      getParallelService: () => this.getParallelService(),
      getResourceLeaseService: () => this.getResourceLeaseService(),
      getFileChangeService: () => this.getFileChangeService(),
      getMutationRollbackService: () => this.getMutationRollbackService(),
      getScheduleIntentService: () => this.getScheduleIntentService(),
      getTapeService: () => this.getTapeService(),
      getVerificationService: () => this.getVerificationService(),
      getCredentialVaultService: () => this.getCredentialVaultService(),
      getSessionWireService: () => this.getSessionWireService(),
      refreshSkillsState: (input) => this.refreshSkillsState(input),
      sanitizeInput: (text) => this.sanitizeInput(text),
      getHistoryViewBaseline: (sessionId) => this.getHistoryViewBaseline(sessionId),
      getTaskTargetDescriptor: (sessionId) => this.getTaskTargetDescriptor(sessionId),
      getTaskState: (sessionId) => this.getTaskState(sessionId),
      getTruthState: (sessionId) => this.getTruthState(sessionId),
      getRecoveryPosture: (sessionId) => this.getRecoveryPosture(sessionId),
      getRecoveryWorkingSet: (sessionId) => this.getRecoveryWorkingSet(sessionId),
      recordEvent: (input) => this.recordEvent(input),
      recordMetricObservation: (sessionId, input) => this.recordMetricObservation(sessionId, input),
      listMetricObservations: (sessionId, query) => this.listMetricObservations(sessionId, query),
      recordGuardResult: (sessionId, input) => this.recordGuardResult(sessionId, input),
      listGuardResults: (sessionId, query) => this.listGuardResults(sessionId, query),
      evaluateCompletion: (sessionId, level) => this.evaluateCompletion(sessionId, level),
      getSessionLifecycleSnapshot: (sessionId) => this.getSessionLifecycleSnapshot(sessionId),
      invalidateSessionLifecycleSnapshot: (sessionId) =>
        this.invalidateSessionLifecycleSnapshot(sessionId),
      recoverRecoveryWal: async () => {
        const recovery = new RecoveryWalRecovery({
          workspaceRoot: this.workspaceRoot,
          config: this.runtimeConfig.infrastructure.recoveryWal,
          recordEvent: (input: { sessionId: string; type: string; payload?: object }) => {
            this.recordEvent({
              sessionId: input.sessionId,
              type: input.type,
              payload: input.payload,
              skipTapeCheckpoint: true,
            });
          },
        });
        return await recovery.recover();
      },
    });
  }

  private createSurfacePorts(methodGroups: BrewvaRuntimeMethodGroups): {
    authority: BrewvaAuthorityPort;
    inspect: BrewvaInspectionPort;
    maintain: BrewvaMaintenancePort;
  } {
    return {
      authority: {
        skills: bindMethods(methodGroups.skills, [
          "activate",
          "recordCompletionFailure",
          "complete",
        ] as const),
        proposals: bindMethods(methodGroups.proposals, [
          "submit",
          "decideEffectCommitment",
        ] as const),
        reasoning: bindMethods(methodGroups.reasoning, ["recordCheckpoint", "revert"] as const),
        tools: bindMethods(methodGroups.tools, [
          "start",
          "finish",
          "acquireParallelSlot",
          "acquireParallelSlotAsync",
          "releaseParallelSlot",
          "requestResourceLease",
          "cancelResourceLease",
          "markCall",
          "trackCallStart",
          "trackCallEnd",
          "rollbackLastPatchSet",
          "rollbackLastMutation",
          "recordResult",
        ] as const),
        task: bindMethods(methodGroups.task, [
          "setSpec",
          "addItem",
          "updateItem",
          "recordBlocker",
          "recordAcceptance",
          "resolveBlocker",
        ] as const),
        truth: bindMethods(methodGroups.truth, ["upsertFact", "resolveFact"] as const),
        schedule: bindMethods(methodGroups.schedule, [
          "createIntent",
          "cancelIntent",
          "updateIntent",
        ] as const),
        events: bindMethods(methodGroups.events, [
          "recordMetricObservation",
          "recordGuardResult",
          "recordTapeHandoff",
        ] as const),
        verification: methodGroups.verification,
        cost: bindMethods(methodGroups.cost, ["recordAssistantUsage"] as const),
        session: bindMethods(methodGroups.session, [
          "commitCompaction",
          "applyMergedWorkerResults",
        ] as const),
      },
      inspect: {
        skills: bindMethods(methodGroups.skills, [
          "getLoadReport",
          "list",
          "get",
          "getActive",
          "getActiveState",
          "getLatestFailure",
          "validateOutputs",
          "getRawOutputs",
          "getNormalizedOutputs",
          "getConsumedOutputs",
        ] as const),
        proposals: bindMethods(methodGroups.proposals, [
          "list",
          "listEffectCommitmentRequests",
          "listPendingEffectCommitments",
        ] as const),
        reasoning: bindMethods(methodGroups.reasoning, [
          "getActiveState",
          "listCheckpoints",
          "getCheckpoint",
          "listReverts",
          "canRevertTo",
        ] as const),
        context: bindMethods(methodGroups.context, [
          "sanitizeInput",
          "getUsage",
          "getPromptStability",
          "getTransientReduction",
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
        ] as const),
        tools: bindMethods(methodGroups.tools, [
          "checkAccess",
          "explainAccess",
          "getGovernanceDescriptor",
          "listResourceLeases",
          "resolveUndoSessionId",
        ] as const),
        task: bindMethods(methodGroups.task, ["getTargetDescriptor", "getState"] as const),
        truth: bindMethods(methodGroups.truth, ["getState"] as const),
        ledger: methodGroups.ledger,
        schedule: bindMethods(methodGroups.schedule, [
          "listIntents",
          "getProjectionSnapshot",
        ] as const),
        recovery: bindMethods(methodGroups.recoveryWal, [
          "listPending",
          "getPosture",
          "getWorkingSet",
        ] as const),
        lifecycle: bindMethods(methodGroups.lifecycle, ["getSnapshot"] as const),
        events: bindMethods(methodGroups.events, [
          "query",
          "queryStructured",
          "listMetricObservations",
          "listGuardResults",
          "getTapeStatus",
          "getTapePressureThresholds",
          "searchTape",
          "listReplaySessions",
          "subscribe",
          "toStructured",
          "list",
          "listSessionIds",
        ] as const),
        cost: bindMethods(methodGroups.cost, ["getSummary"] as const),
        session: bindMethods(methodGroups.session, [
          "listWorkerResults",
          "getOpenToolCalls",
          "getUncleanShutdownDiagnostic",
          "mergeWorkerResults",
          "getHydration",
          "getIntegrity",
        ] as const),
        sessionWire: bindMethods(methodGroups.sessionWire, ["query", "subscribe"] as const),
      },
      maintain: {
        skills: bindMethods(methodGroups.skills, ["refresh"] as const),
        context: bindMethods(methodGroups.context, [
          "onTurnStart",
          "onTurnEnd",
          "onUserInput",
          "observeUsage",
          "observePromptStability",
          "observeTransientReduction",
          "registerProvider",
          "unregisterProvider",
          "buildInjection",
          "appendGuardedSupplementalBlocks",
          "checkAndRequestCompaction",
          "requestCompaction",
        ] as const),
        tools: bindMethods(methodGroups.tools, [
          "registerGovernanceDescriptor",
          "registerGovernanceResolver",
          "unregisterGovernanceDescriptor",
        ] as const),
        session: bindMethods(methodGroups.session, [
          "recordWorkerResult",
          "clearWorkerResults",
          "pollStall",
          "clearState",
          "onClearState",
          "resolveCredentialBindings",
          "resolveSandboxApiKey",
        ] as const),
        recovery: bindMethods(methodGroups.recoveryWal, ["recover", "compact"] as const),
      },
    };
  }

  private getTaskState(sessionId: string): TaskState {
    return this.turnReplay.getTaskState(sessionId);
  }

  private resolveHistoryViewBaselineState(sessionId: string) {
    return resolveHistoryViewBaselineView(this.kernel, {
      sessionId,
      usage: this.contextService.getContextUsage(sessionId),
      referenceContextDigest: this.sessionState.getPromptStability(sessionId)?.stablePrefixHash,
      reservedBudgetRatio: HISTORY_VIEW_BASELINE_RESERVED_BUDGET_RATIO,
    });
  }

  private getHistoryViewBaseline(sessionId: string): HistoryViewBaselineSnapshot | undefined {
    this.sessionLifecycleService.ensureHydrated(sessionId);
    return this.resolveHistoryViewBaselineState(sessionId).snapshot;
  }

  private getRecoveryPosture(sessionId: string): RecoveryPostureSnapshot {
    this.sessionLifecycleService.ensureHydrated(sessionId);
    return resolveRecoveryWorkingSetView(this.kernel, {
      sessionId,
      usage: this.contextService.getContextUsage(sessionId),
      referenceContextDigest: this.sessionState.getPromptStability(sessionId)?.stablePrefixHash,
      reservedBudgetRatio: HISTORY_VIEW_BASELINE_RESERVED_BUDGET_RATIO,
    }).posture;
  }

  private getRecoveryWorkingSet(sessionId: string): RecoveryWorkingSetSnapshot | undefined {
    this.sessionLifecycleService.ensureHydrated(sessionId);
    return resolveRecoveryWorkingSetView(this.kernel, {
      sessionId,
      usage: this.contextService.getContextUsage(sessionId),
      referenceContextDigest: this.sessionState.getPromptStability(sessionId)?.stablePrefixHash,
      reservedBudgetRatio: HISTORY_VIEW_BASELINE_RESERVED_BUDGET_RATIO,
    }).workingSet;
  }

  private invalidateSessionLifecycleSnapshot(sessionId: string): void {
    this.sessionLifecycleSnapshotCache.delete(sessionId);
  }

  private getSessionLifecycleSnapshot(sessionId: string): SessionLifecycleSnapshot {
    const cached = this.sessionLifecycleSnapshotCache.get(sessionId);
    if (cached) {
      return structuredClone(cached);
    }
    this.sessionLifecycleService.ensureHydrated(sessionId);
    const events = this.eventStore.list(sessionId);
    const usage = this.contextService.getContextUsage(sessionId);
    const referenceContextDigest =
      this.sessionState.getPromptStability(sessionId)?.stablePrefixHash;
    const recoveryContext = resolveRecoveryWorkingSetView(this.kernel, {
      sessionId,
      usage,
      referenceContextDigest,
      reservedBudgetRatio: HISTORY_VIEW_BASELINE_RESERVED_BUDGET_RATIO,
    });
    const transitionState = deriveTransitionState(events);
    const snapshot = buildSessionLifecycleSnapshot({
      sessionId,
      hydration: this.sessionLifecycleService.getHydrationState(sessionId),
      integrity: this.sessionLifecycleService.getIntegrityStatus(sessionId),
      recovery: {
        ...recoveryContext.posture,
        latestSourceEventId: transitionState.latestSourceEventId,
        latestSourceEventType: transitionState.latestSourceEventType,
        recentTransitions: transitionState.recentTransitions,
      },
      activeSkillState: this.skillLifecycleService.getActiveSkillState(sessionId),
      latestSkillFailure: this.skillLifecycleService.getLatestSkillFailure(sessionId),
      pendingApprovals: this.getEffectCommitmentDeskService().listPending(sessionId),
      openToolCalls: deriveOpenToolCallsFromEvents(events),
      frames: this.getSessionWireService().query(sessionId),
    });
    this.sessionLifecycleSnapshotCache.set(sessionId, snapshot);
    return structuredClone(snapshot);
  }

  private getTaskTargetDescriptor(sessionId: string): TaskTargetDescriptor {
    this.sessionLifecycleService.ensureHydrated(sessionId);
    const spec = this.getTaskState(sessionId).spec;
    const roots = resolveTaskTargetRoots({
      cwd: this.cwd,
      workspaceRoot: this.workspaceRoot,
      spec,
    });
    return {
      primaryRoot: resolvePrimaryTaskTargetRoot({
        cwd: this.cwd,
        workspaceRoot: this.workspaceRoot,
        spec,
      }),
      roots,
    };
  }

  private getTruthState(sessionId: string): TruthState {
    return this.turnReplay.getTruthState(sessionId);
  }

  private recordEvent<TPayload extends object>(
    input: RuntimeRecordEventInput<TPayload>,
  ): BrewvaEventRecord | undefined {
    const recorded = this.eventPipeline.recordEvent(input);
    if (recorded) {
      if (LIFECYCLE_APPROVAL_CACHE_EVENT_TYPES.has(recorded.type)) {
        this.clearEffectCommitmentDeskState(recorded.sessionId);
      }
      this.invalidateSessionLifecycleSnapshot(recorded.sessionId);
    }
    return recorded;
  }

  private refreshSkillsState(input: SkillRefreshInput = {}): SkillRefreshResult {
    const systemInstall = ensureBundledSystemSkills();
    this.skillRegistry.load();
    const indexPath = this.skillRegistry.writeIndex();
    const loadReport = this.skillRegistry.getLoadReport();
    const generatedAt = new Date().toISOString();

    if (input.sessionId) {
      this.recordEvent({
        sessionId: input.sessionId,
        type: SKILL_REFRESH_RECORDED_EVENT_TYPE,
        payload: {
          reason: input.reason?.trim() || "runtime.maintain.skills.refresh",
          generatedAt,
          indexPath,
          systemInstall,
          summary: {
            loadedSkills: loadReport.loadedSkills.length,
            routableSkills: loadReport.routableSkills.length,
            hiddenSkills: loadReport.hiddenSkills.length,
            overlaySkills: loadReport.overlaySkills.length,
          },
        },
      });
    }

    return {
      generatedAt,
      systemInstall,
      loadReport,
      indexPath,
    };
  }

  private evaluateCompletion(sessionId: string, level?: VerificationLevel): VerificationReport {
    this.sessionLifecycleService.ensureHydrated(sessionId);
    return this.verificationGate.evaluate(sessionId, level);
  }

  private sanitizeInput(text: string): string {
    if (!this.runtimeConfig.security.sanitizeContext) {
      return text;
    }
    return sanitizeContextText(text);
  }

  private resolveCheckpointCostSummary(sessionId: string): SessionCostSummary {
    this.sessionLifecycleService.ensureHydrated(sessionId);
    return this.costService.getCostSummary(sessionId);
  }

  private resolveCheckpointCostSkillLastTurnByName(sessionId: string): Record<string, number> {
    this.sessionLifecycleService.ensureHydrated(sessionId);
    return this.costTracker.getSkillLastTurnByName(sessionId);
  }

  private getCurrentTurn(sessionId: string): number {
    return this.sessionState.getCurrentTurn(sessionId);
  }

  private getRecentToolOutputDistillations(
    sessionId: string,
    maxEntries = 12,
  ): ToolOutputDistillationEntry[] {
    const limit = Number.isFinite(maxEntries) ? Math.max(1, Math.floor(maxEntries)) : 12;
    const candidateEvents = this.eventStore.list(sessionId, {
      type: TOOL_OUTPUT_DISTILLED_EVENT_TYPE,
      last: Math.max(limit * 4, limit),
    });

    const entries: ToolOutputDistillationEntry[] = [];
    for (const event of candidateEvents) {
      const payload = event.payload;
      if (!payload) continue;

      const toolNameRaw = payload.toolName;
      const toolName =
        typeof toolNameRaw === "string" && toolNameRaw.trim().length > 0
          ? toolNameRaw.trim()
          : "(unknown)";

      const strategyRaw = payload.strategy;
      const strategy =
        typeof strategyRaw === "string" && strategyRaw.trim().length > 0
          ? strategyRaw.trim()
          : "unknown";

      const summaryTextRaw = payload.summaryText;
      const summaryText = typeof summaryTextRaw === "string" ? summaryTextRaw : "";
      const artifactRefRaw = payload.artifactRef;
      const artifactRef =
        typeof artifactRefRaw === "string" && artifactRefRaw.trim().length > 0
          ? artifactRefRaw.trim()
          : null;

      const rawTokens =
        typeof payload.rawTokens === "number" && Number.isFinite(payload.rawTokens)
          ? Math.max(0, Math.floor(payload.rawTokens))
          : null;
      const summaryTokens =
        typeof payload.summaryTokens === "number" && Number.isFinite(payload.summaryTokens)
          ? Math.max(0, Math.floor(payload.summaryTokens))
          : null;
      const compressionRatio =
        typeof payload.compressionRatio === "number" && Number.isFinite(payload.compressionRatio)
          ? Math.max(0, Math.min(1, payload.compressionRatio))
          : null;
      const isError = payload.isError === true;
      const verdict = normalizeToolResultVerdict(payload.verdict);
      const turn =
        typeof event.turn === "number" && Number.isFinite(event.turn)
          ? Math.max(0, Math.floor(event.turn))
          : 0;
      const timestamp = Number.isFinite(event.timestamp) ? event.timestamp : Date.now();

      entries.push({
        toolName,
        strategy,
        summaryText,
        rawTokens,
        summaryTokens,
        compressionRatio,
        artifactRef,
        isError,
        verdict,
        turn,
        timestamp,
      });
    }

    return entries.slice(-limit);
  }

  private getLatestVerificationOutcome(sessionId: string):
    | {
        timestamp: number;
        level?: string;
        outcome?: string;
        failedChecks?: string[];
        missingChecks?: string[];
        missingEvidence?: string[];
        reason?: string | null;
        commandsFresh?: string[];
        commandsStale?: string[];
      }
    | undefined {
    const event = this.eventStore.list(sessionId, {
      type: VERIFICATION_OUTCOME_RECORDED_EVENT_TYPE,
      last: 1,
    })[0];
    if (!event?.payload) return undefined;

    const payload = event.payload;
    const failedChecks = Array.isArray(payload.failedChecks)
      ? payload.failedChecks.filter((value): value is string => typeof value === "string")
      : [];
    const missingChecks = Array.isArray(payload.missingChecks)
      ? payload.missingChecks.filter((value): value is string => typeof value === "string")
      : [];
    const missingEvidence = Array.isArray(payload.missingEvidence)
      ? payload.missingEvidence.filter((value): value is string => typeof value === "string")
      : [];
    const commandsFresh = Array.isArray(payload.commandsFresh)
      ? payload.commandsFresh.filter((value): value is string => typeof value === "string")
      : [];
    const commandsStale = Array.isArray(payload.commandsStale)
      ? payload.commandsStale.filter((value): value is string => typeof value === "string")
      : [];

    return {
      timestamp: event.timestamp,
      level: typeof payload.level === "string" ? payload.level : undefined,
      outcome: typeof payload.outcome === "string" ? payload.outcome : undefined,
      failedChecks,
      missingChecks,
      missingEvidence,
      reason:
        typeof payload.reason === "string" && payload.reason.trim().length > 0
          ? payload.reason
          : null,
      commandsFresh,
      commandsStale,
    };
  }

  private recordMetricObservation(
    sessionId: string,
    input: MetricObservationInput,
  ): BrewvaEventRecord | undefined {
    const payload = coerceMetricObservationPayload(buildMetricObservationPayload(input));
    if (!payload) return undefined;
    return this.recordEvent({
      sessionId,
      type: ITERATION_METRIC_OBSERVED_EVENT_TYPE,
      turn: input.turn,
      timestamp: input.timestamp,
      payload,
    });
  }

  private listMetricObservations(
    sessionId: string,
    query: MetricObservationQuery = {},
  ): MetricObservationRecord[] {
    const records = this.listIterationFactRecords(
      sessionId,
      query,
      getMetricObservationEventQuery,
      toMetricObservationRecord,
    );
    return applyFactWindow(filterMetricObservationRecords(records, query), query);
  }

  private recordGuardResult(
    sessionId: string,
    input: GuardResultInput,
  ): BrewvaEventRecord | undefined {
    const payload = coerceGuardResultPayload(buildGuardResultPayload(input));
    if (!payload) return undefined;
    return this.recordEvent({
      sessionId,
      type: ITERATION_GUARD_RECORDED_EVENT_TYPE,
      turn: input.turn,
      timestamp: input.timestamp,
      payload,
    });
  }

  private listGuardResults(sessionId: string, query: GuardResultQuery = {}): GuardResultRecord[] {
    const records = this.listIterationFactRecords(
      sessionId,
      query,
      getGuardResultEventQuery,
      toGuardResultRecord,
    );
    return applyFactWindow(filterGuardResultRecords(records, query), query);
  }

  private listIterationFactRecords<
    TRecord extends { eventId: string; timestamp: number },
    TQuery extends { sessionScope?: IterationFactSessionScope },
  >(
    sessionId: string,
    query: TQuery,
    buildEventQuery: (query: TQuery) => BrewvaEventQuery,
    toRecord: (event: BrewvaEventRecord) => TRecord | undefined,
  ): TRecord[] {
    const records: TRecord[] = [];
    const sessionIds = [sessionId];
    for (const candidateSessionId of sessionIds) {
      for (const event of this.eventStore.list(candidateSessionId, buildEventQuery(query))) {
        const record = toRecord(event);
        if (record) {
          records.push(record);
        }
      }
    }
    return records.toSorted(
      (left, right) =>
        left.timestamp - right.timestamp || left.eventId.localeCompare(right.eventId),
    );
  }

  private isContextBudgetEnabled(): boolean {
    return this.runtimeConfig.infrastructure.contextBudget.enabled;
  }
}

type RuntimeMethodGroupsCarrier = {
  [BREWVA_RUNTIME_METHOD_GROUPS]?: BrewvaRuntimeMethodGroups;
};

function attachRuntimeMethodGroupsCarrier(
  target: object,
  methodGroups: BrewvaRuntimeMethodGroups,
): void {
  Object.defineProperty(target, BREWVA_RUNTIME_METHOD_GROUPS, {
    configurable: false,
    enumerable: false,
    value: methodGroups,
    writable: false,
  });
}

function copyRuntimeMethodGroupsCarrier(source: object, target: object): void {
  const methodGroups = (source as RuntimeMethodGroupsCarrier)[BREWVA_RUNTIME_METHOD_GROUPS];
  if (methodGroups) {
    attachRuntimeMethodGroupsCarrier(target, methodGroups);
  }
}

export function createHostedRuntimePort(runtime: BrewvaRuntime): BrewvaHostedRuntimePort {
  const hostedRuntime: BrewvaHostedRuntimePort = {
    cwd: runtime.cwd,
    workspaceRoot: runtime.workspaceRoot,
    agentId: runtime.agentId,
    config: runtime.config,
    authority: runtime.authority,
    inspect: runtime.inspect,
    maintain: runtime.maintain,
  };
  copyRuntimeMethodGroupsCarrier(runtime, hostedRuntime);
  return hostedRuntime;
}

export function createToolRuntimePort(runtime: BrewvaRuntime): BrewvaToolRuntimePort {
  return {
    cwd: runtime.cwd,
    workspaceRoot: runtime.workspaceRoot,
    agentId: runtime.agentId,
    config: runtime.config,
    authority: runtime.authority,
    inspect: runtime.inspect,
  };
}

export function createOperatorRuntimePort(runtime: BrewvaRuntime): BrewvaOperatorRuntimePort {
  return {
    cwd: runtime.cwd,
    workspaceRoot: runtime.workspaceRoot,
    agentId: runtime.agentId,
    config: runtime.config,
    inspect: runtime.inspect,
    maintain: {
      session: runtime.maintain.session,
      recovery: runtime.maintain.recovery,
    },
  };
}
