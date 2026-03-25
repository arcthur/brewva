import { resolve } from "node:path";
import { TurnWALRecovery } from "./channels/turn-wal-recovery.js";
import { TurnWALStore } from "./channels/turn-wal.js";
import type { TurnEnvelope } from "./channels/turn.js";
import { DEFAULT_BREWVA_CONFIG } from "./config/defaults.js";
import { loadBrewvaConfig } from "./config/loader.js";
import { normalizeBrewvaConfig } from "./config/normalize.js";
import { resolveWorkspaceRootDir } from "./config/paths.js";
import { ContextBudgetManager } from "./context/budget.js";
import { normalizeAgentId } from "./context/identity.js";
import { ContextInjectionCollector, type ContextInjectionEntry } from "./context/injection.js";
import {
  type ContextSourceProvider,
  type ContextSourceProviderDescriptor,
} from "./context/provider.js";
import type { ToolOutputDistillationEntry } from "./context/tool-output-distilled.js";
import { SessionCostTracker } from "./cost/tracker.js";
import {
  ITERATION_GUARD_RECORDED_EVENT_TYPE,
  ITERATION_METRIC_OBSERVED_EVENT_TYPE,
  TOOL_OUTPUT_DISTILLED_EVENT_TYPE,
  VERIFICATION_OUTCOME_RECORDED_EVENT_TYPE,
} from "./events/event-types.js";
import { BrewvaEventStore } from "./events/store.js";
import type { GovernancePort } from "./governance/port.js";
import {
  createToolGovernanceRegistry,
  getToolGovernanceResolution,
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
import { ParallelBudgetManager } from "./parallel/budget.js";
import { ParallelResultStore } from "./parallel/results.js";
import { ProjectionEngine } from "./projection/engine.js";
import {
  createRuntimeCoreDependencies as assembleRuntimeCoreDependencies,
  createRuntimeKernelContext as assembleRuntimeKernelContext,
  createRuntimeServiceDependencies as assembleRuntimeServiceDependencies,
} from "./runtime-assembler.js";
import type { RuntimeKernelContext } from "./runtime-kernel.js";
import { parseScheduleIntentEvent, SCHEDULE_EVENT_TYPE } from "./schedule/events.js";
import { sanitizeContextText } from "./security/sanitize.js";
import { ContextService } from "./services/context.js";
import { CostService } from "./services/cost.js";
import { EffectCommitmentDeskService } from "./services/effect-commitment-desk.js";
import { EventPipelineService, type RuntimeRecordEventInput } from "./services/event-pipeline.js";
import { FileChangeService } from "./services/file-change.js";
import { LedgerService } from "./services/ledger.js";
import { MutationRollbackService } from "./services/mutation-rollback.js";
import { ParallelService } from "./services/parallel.js";
import { ProposalAdmissionService } from "./services/proposal-admission.js";
import { ResourceLeaseService } from "./services/resource-lease.js";
import { ScheduleIntentService } from "./services/schedule-intent.js";
import { SessionLifecycleService } from "./services/session-lifecycle.js";
import { RuntimeSessionStateStore } from "./services/session-state.js";
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
import { SkillRegistry, type SkillRegistryLoadReport } from "./skills/registry.js";
import { FileChangeTracker } from "./state/file-change-tracker.js";
import { TurnReplayEngine } from "./tape/replay-engine.js";
import type {
  ContextCompactionReason,
  ContextPressureLevel,
  ContextPressureStatus,
  ContextCompactionGateStatus,
  ContextBudgetUsage,
  ResourceLeaseCancelResult,
  ResourceLeaseQuery,
  ResourceLeaseRecord,
  ResourceLeaseRequest,
  ResourceLeaseResult,
  EvidenceLedgerRow,
  EvidenceQuery,
  ParallelAcquireResult,
  RollbackResult,
  ScheduleIntentCancelInput,
  ScheduleIntentCancelResult,
  ScheduleIntentCreateInput,
  ScheduleIntentCreateResult,
  ScheduleIntentListQuery,
  ScheduleIntentProjectionRecord,
  ScheduleIntentUpdateInput,
  ScheduleIntentUpdateResult,
  ScheduleProjectionSnapshot,
  BrewvaEventQuery,
  BrewvaEventRecord,
  BrewvaReplaySession,
  BrewvaConfig,
  BrewvaStructuredEvent,
  DeepReadonly,
  DecideEffectCommitmentInput,
  DecideEffectCommitmentResult,
  DecisionReceipt,
  PendingEffectCommitmentRequest,
  ToolExecutionBoundary,
  ToolGovernanceDescriptor,
  ToolMutationReceipt,
  ToolMutationRollbackResult,
  SkillDocument,
  SkillActivationResult,
  SkillOutputValidationResult,
  SkillRoutingScope,
  ProposalEnvelope,
  ProposalKind,
  ProposalListQuery,
  ProposalRecord,
  ScheduleIntentEventPayload,
  SessionHydrationState,
  SessionCostSummary,
  TapeSearchResult,
  TapeSearchScope,
  TapeHandoffResult,
  TapeStatusState,
  TaskBlockerRecordResult,
  TaskBlockerResolveResult,
  TaskAcceptanceRecordResult,
  TaskItemAddResult,
  TaskItemUpdateResult,
  TaskSpec,
  TaskState,
  TurnWALRecord,
  TurnWALRecoveryResult,
  TurnWALSource,
  VerificationLevel,
  VerificationReport,
  WorkerMergeReport,
  WorkerApplyReport,
  WorkerResult,
  TruthFactResolveResult,
  TruthFactUpsertResult,
} from "./types.js";
import type { TaskItemStatus } from "./types.js";
import type { TruthFactSeverity, TruthFactStatus, TruthState } from "./types.js";
import { normalizeToolResultVerdict } from "./utils/tool-result.js";
import { VerificationGate } from "./verification/gate.js";

export interface BrewvaRuntimeOptions {
  cwd?: string;
  configPath?: string;
  config?: BrewvaConfig;
  governancePort?: GovernancePort;
  agentId?: string;
  routingScopes?: SkillRoutingScope[];
}

export interface VerifyCompletionOptions {
  executeCommands?: boolean;
  timeoutMs?: number;
}

type RuntimeConfigState = {
  config: BrewvaConfig;
  readonlyConfig: DeepReadonly<BrewvaConfig>;
};

type RuntimeCoreDependencies = {
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
};

type RuntimeServiceDependencies = {
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

export class BrewvaRuntime {
  declare readonly cwd: string;
  declare readonly workspaceRoot: string;
  declare readonly agentId: string;
  declare readonly config: DeepReadonly<BrewvaConfig>;
  declare readonly skills: {
    refresh(): void;
    getLoadReport(): SkillRegistryLoadReport;
    list(): SkillDocument[];
    get(name: string): SkillDocument | undefined;
    activate(sessionId: string, name: string): SkillActivationResult;
    getActive(sessionId: string): SkillDocument | undefined;
    validateOutputs(
      sessionId: string,
      outputs: Record<string, unknown>,
    ): SkillOutputValidationResult;
    complete(
      sessionId: string,
      output: Record<string, unknown>,
      options?: { proof?: string; summary?: string; notes?: string },
    ): SkillOutputValidationResult;
    getOutputs(sessionId: string, skillName: string): Record<string, unknown> | undefined;
    getConsumedOutputs(sessionId: string, targetSkillName: string): Record<string, unknown>;
  };
  declare readonly proposals: {
    submit<K extends ProposalKind>(
      sessionId: string,
      proposal: ProposalEnvelope<K>,
    ): DecisionReceipt;
    list(sessionId: string, query?: ProposalListQuery): ProposalRecord[];
    listPendingEffectCommitments(sessionId: string): PendingEffectCommitmentRequest[];
    decideEffectCommitment(
      sessionId: string,
      requestId: string,
      input: DecideEffectCommitmentInput,
    ): DecideEffectCommitmentResult;
  };
  declare readonly context: {
    onTurnStart(sessionId: string, turnIndex: number): void;
    onTurnEnd(sessionId: string): void;
    onUserInput(sessionId: string): void;
    sanitizeInput(text: string): string;
    observeUsage(sessionId: string, usage: ContextBudgetUsage | undefined): void;
    getUsage(sessionId: string): ContextBudgetUsage | undefined;
    getUsageRatio(usage: ContextBudgetUsage | undefined): number | null;
    getHardLimitRatio(sessionId: string, usage?: ContextBudgetUsage): number;
    getCompactionThresholdRatio(sessionId: string, usage?: ContextBudgetUsage): number;
    getPressureStatus(sessionId: string, usage?: ContextBudgetUsage): ContextPressureStatus;
    getPressureLevel(sessionId: string, usage?: ContextBudgetUsage): ContextPressureLevel;
    getCompactionGateStatus(
      sessionId: string,
      usage?: ContextBudgetUsage,
    ): ContextCompactionGateStatus;
    checkCompactionGate(
      sessionId: string,
      toolName: string,
      usage?: ContextBudgetUsage,
    ): { allowed: boolean; reason?: string };
    registerProvider(provider: ContextSourceProvider): void;
    unregisterProvider(source: string): boolean;
    listProviders(): readonly ContextSourceProviderDescriptor[];
    buildInjection(
      sessionId: string,
      prompt: string,
      usage?: ContextBudgetUsage,
      injectionScopeId?: string,
    ): Promise<{
      text: string;
      entries: ContextInjectionEntry[];
      accepted: boolean;
      originalTokens: number;
      finalTokens: number;
      truncated: boolean;
    }>;
    appendSupplementalInjection(
      sessionId: string,
      inputText: string,
      usage?: ContextBudgetUsage,
      injectionScopeId?: string,
    ): {
      accepted: boolean;
      text: string;
      originalTokens: number;
      finalTokens: number;
      truncated: boolean;
      droppedReason?: "hard_limit" | "budget_exhausted";
    };
    checkAndRequestCompaction(sessionId: string, usage: ContextBudgetUsage | undefined): boolean;
    requestCompaction(sessionId: string, reason: ContextCompactionReason): void;
    getPendingCompactionReason(sessionId: string): ContextCompactionReason | null;
    getCompactionInstructions(): string;
    getCompactionWindowTurns(): number;
    markCompacted(
      sessionId: string,
      input: {
        fromTokens?: number | null;
        toTokens?: number | null;
        summary?: string;
        entryId?: string;
      },
    ): void;
  };
  declare readonly tools: {
    checkAccess(sessionId: string, toolName: string): { allowed: boolean; reason?: string };
    explainAccess(input: { sessionId: string; toolName: string; usage?: ContextBudgetUsage }): {
      allowed: boolean;
      reason?: string;
      warning?: string;
    };
    getGovernanceDescriptor(toolName: string): ToolGovernanceDescriptor | undefined;
    registerGovernanceDescriptor(toolName: string, input: ToolGovernanceDescriptor): void;
    unregisterGovernanceDescriptor(toolName: string): void;
    start(input: {
      sessionId: string;
      toolCallId: string;
      toolName: string;
      args?: Record<string, unknown>;
      usage?: ContextBudgetUsage;
      recordLifecycleEvent?: boolean;
      effectCommitmentRequestId?: string;
    }): {
      allowed: boolean;
      reason?: string;
      advisory?: string;
      boundary?: ToolExecutionBoundary;
      commitmentReceipt?: DecisionReceipt;
      effectCommitmentRequestId?: string;
      mutationReceipt?: ToolMutationReceipt;
    };
    finish(input: {
      sessionId: string;
      toolCallId: string;
      toolName: string;
      args: Record<string, unknown>;
      outputText: string;
      channelSuccess: boolean;
      verdict?: "pass" | "fail" | "inconclusive";
      metadata?: Record<string, unknown>;
      effectCommitmentRequestId?: string;
    }): void;
    acquireParallelSlot(sessionId: string, runId: string): ParallelAcquireResult;
    acquireParallelSlotAsync(
      sessionId: string,
      runId: string,
      options?: { timeoutMs?: number },
    ): Promise<ParallelAcquireResult>;
    releaseParallelSlot(sessionId: string, runId: string): void;
    requestResourceLease(sessionId: string, request: ResourceLeaseRequest): ResourceLeaseResult;
    listResourceLeases(sessionId: string, query?: ResourceLeaseQuery): ResourceLeaseRecord[];
    cancelResourceLease(
      sessionId: string,
      leaseId: string,
      reason?: string,
    ): ResourceLeaseCancelResult;
    markCall(sessionId: string, toolName: string): void;
    trackCallStart(input: {
      sessionId: string;
      toolCallId: string;
      toolName: string;
      args?: Record<string, unknown>;
    }): void;
    trackCallEnd(input: {
      sessionId: string;
      toolCallId: string;
      toolName: string;
      channelSuccess: boolean;
    }): void;
    rollbackLastPatchSet(sessionId: string): RollbackResult;
    rollbackLastMutation(sessionId: string): ToolMutationRollbackResult;
    resolveUndoSessionId(preferredSessionId?: string): string | undefined;
    recordResult(input: {
      sessionId: string;
      toolCallId?: string;
      toolName: string;
      args: Record<string, unknown>;
      outputText: string;
      channelSuccess: boolean;
      verdict?: "pass" | "fail" | "inconclusive";
      metadata?: Record<string, unknown>;
      effectCommitmentRequestId?: string;
    }): string;
  };
  declare readonly task: {
    setSpec(sessionId: string, spec: TaskSpec): void;
    addItem(
      sessionId: string,
      input: { text: string; status?: TaskItemStatus; id?: string },
    ): TaskItemAddResult;
    updateItem(
      sessionId: string,
      input: { id: string; text?: string; status?: TaskItemStatus },
    ): TaskItemUpdateResult;
    recordBlocker(
      sessionId: string,
      input: { id?: string; message: string; source?: string; truthFactId?: string },
    ): TaskBlockerRecordResult;
    recordAcceptance(
      sessionId: string,
      input: { status: "pending" | "accepted" | "rejected"; decidedBy?: string; notes?: string },
    ): TaskAcceptanceRecordResult;
    resolveBlocker(sessionId: string, blockerId: string): TaskBlockerResolveResult;
    getState(sessionId: string): TaskState;
  };
  declare readonly truth: {
    getState(sessionId: string): TruthState;
    upsertFact(
      sessionId: string,
      input: {
        id: string;
        kind: string;
        severity: TruthFactSeverity;
        summary: string;
        details?: Record<string, unknown>;
        evidenceIds?: string[];
        status?: TruthFactStatus;
      },
    ): TruthFactUpsertResult;
    resolveFact(sessionId: string, truthFactId: string): TruthFactResolveResult;
  };
  declare readonly ledger: {
    getDigest(sessionId: string): string;
    query(sessionId: string, query: EvidenceQuery): string;
    listRows(sessionId?: string): EvidenceLedgerRow[];
    verifyChain(sessionId: string): { valid: boolean; reason?: string };
    getPath(): string;
  };
  declare readonly schedule: {
    createIntent(
      sessionId: string,
      input: ScheduleIntentCreateInput,
    ): Promise<ScheduleIntentCreateResult>;
    cancelIntent(
      sessionId: string,
      input: ScheduleIntentCancelInput,
    ): Promise<ScheduleIntentCancelResult>;
    updateIntent(
      sessionId: string,
      input: ScheduleIntentUpdateInput,
    ): Promise<ScheduleIntentUpdateResult>;
    listIntents(query?: ScheduleIntentListQuery): Promise<ScheduleIntentProjectionRecord[]>;
    getProjectionSnapshot(): Promise<ScheduleProjectionSnapshot>;
  };
  declare readonly turnWal: {
    appendPending(
      envelope: TurnEnvelope,
      source: TurnWALSource,
      options?: { ttlMs?: number; dedupeKey?: string },
    ): TurnWALRecord;
    markInflight(walId: string): TurnWALRecord | undefined;
    markDone(walId: string): TurnWALRecord | undefined;
    markFailed(walId: string, error?: string): TurnWALRecord | undefined;
    markExpired(walId: string): TurnWALRecord | undefined;
    listPending(): TurnWALRecord[];
    recover(): Promise<TurnWALRecoveryResult>;
    compact(): {
      scope: string;
      filePath: string;
      scanned: number;
      retained: number;
      dropped: number;
    };
  };
  declare readonly events: {
    record(input: RuntimeRecordEventInput): BrewvaEventRecord | undefined;
    query(sessionId: string, query?: BrewvaEventQuery): BrewvaEventRecord[];
    queryStructured(sessionId: string, query?: BrewvaEventQuery): BrewvaStructuredEvent[];
    recordMetricObservation(
      sessionId: string,
      input: MetricObservationInput,
    ): BrewvaEventRecord | undefined;
    listMetricObservations(
      sessionId: string,
      query?: MetricObservationQuery,
    ): MetricObservationRecord[];
    recordGuardResult(sessionId: string, input: GuardResultInput): BrewvaEventRecord | undefined;
    listGuardResults(sessionId: string, query?: GuardResultQuery): GuardResultRecord[];
    getTapeStatus(sessionId: string): TapeStatusState;
    getTapePressureThresholds(): TapeStatusState["thresholds"];
    recordTapeHandoff(
      sessionId: string,
      input: { name: string; summary?: string; nextSteps?: string },
    ): TapeHandoffResult;
    searchTape(
      sessionId: string,
      input: { query: string; scope?: TapeSearchScope; limit?: number },
    ): TapeSearchResult;
    listReplaySessions(limit?: number): BrewvaReplaySession[];
    subscribe(listener: (event: BrewvaStructuredEvent) => void): () => void;
    toStructured(event: BrewvaEventRecord): BrewvaStructuredEvent;
    list(sessionId: string, query?: BrewvaEventQuery): BrewvaEventRecord[];
    listSessionIds(): string[];
  };
  declare readonly verification: {
    evaluate(sessionId: string, level?: VerificationLevel): VerificationReport;
    verify(
      sessionId: string,
      level?: VerificationLevel,
      options?: VerifyCompletionOptions,
    ): Promise<VerificationReport>;
  };
  declare readonly cost: {
    recordAssistantUsage(input: {
      sessionId: string;
      model: string;
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheWriteTokens: number;
      totalTokens: number;
      costUsd: number;
      stopReason?: string;
    }): void;
    getSummary(sessionId: string): SessionCostSummary;
  };
  declare readonly session: {
    recordWorkerResult(sessionId: string, result: WorkerResult): void;
    listWorkerResults(sessionId: string): WorkerResult[];
    mergeWorkerResults(sessionId: string): WorkerMergeReport;
    applyMergedWorkerResults(
      sessionId: string,
      input: { toolName: string; toolCallId?: string },
    ): WorkerApplyReport;
    clearWorkerResults(sessionId: string): void;
    pollStall(
      sessionId: string,
      input?: {
        now?: number;
        thresholdMs?: number;
      },
    ): void;
    recordDelegationRun(sessionId: string, record: import("./types.js").DelegationRunRecord): void;
    getDelegationRun(
      sessionId: string,
      runId: string,
    ): import("./types.js").DelegationRunRecord | undefined;
    listDelegationRuns(
      sessionId: string,
      query?: import("./types.js").DelegationRunQuery,
    ): import("./types.js").DelegationRunRecord[];
    listPendingDelegationOutcomes(
      sessionId: string,
      query?: import("./types.js").PendingDelegationOutcomeQuery,
    ): import("./types.js").DelegationRunRecord[];
    clearState(sessionId: string): void;
    onClearState(listener: (sessionId: string) => void): () => void;
    getHydration(sessionId: string): SessionHydrationState;
  };

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
  declare private readonly turnWalStore: TurnWALStore;
  declare private readonly projectionEngine: ProjectionEngine;

  private readonly sessionState = new RuntimeSessionStateStore();
  private readonly kernel: RuntimeKernelContext;
  declare private readonly contextService: ContextService;
  declare private readonly costService: CostService;
  declare private readonly eventPipeline: EventPipelineService;
  declare private readonly effectCommitmentDeskService: EffectCommitmentDeskService;
  declare private readonly fileChangeService: FileChangeService;
  declare private readonly resourceLeaseService: ResourceLeaseService;
  declare private readonly ledgerService: LedgerService;
  declare private readonly mutationRollbackService: MutationRollbackService;
  declare private readonly parallelService: ParallelService;
  declare private readonly proposalAdmissionService: ProposalAdmissionService;
  declare private readonly taskWatchdogService: TaskWatchdogService;
  declare private readonly scheduleIntentService: ScheduleIntentService;
  declare private readonly sessionLifecycleService: SessionLifecycleService;
  declare private readonly skillLifecycleService: SkillLifecycleService;
  declare private readonly taskService: TaskService;
  declare private readonly tapeService: TapeService;
  declare private readonly truthService: TruthService;
  declare private readonly truthProjectorService: TruthProjectorService;
  declare private readonly toolGateService: ToolGateService;
  declare private readonly toolInvocationSpine: ToolInvocationSpine;
  declare private readonly verificationProjectorService: VerificationProjectorService;
  declare private readonly verificationService: VerificationService;
  declare private readonly runtimeConfig: BrewvaConfig;
  private readonly toolGovernanceRegistry = createToolGovernanceRegistry();
  declare private turnReplay: TurnReplayEngine;

  constructor(options: BrewvaRuntimeOptions = {}) {
    const cwd = resolve(options.cwd ?? process.cwd());
    const workspaceRoot = resolveWorkspaceRootDir(cwd);
    const agentId = normalizeAgentId(options.agentId ?? process.env["BREWVA_AGENT_ID"]);
    Object.assign(this, {
      cwd,
      workspaceRoot,
      agentId,
    });
    const configState = this.resolveRuntimeConfig(options);
    Object.assign(this, {
      runtimeConfig: configState.config,
      config: configState.readonlyConfig,
    });
    Object.assign(this, this.createCoreDependencies(options));
    this.kernel = this.createKernelContext(options);
    Object.assign(this, this.createServiceDependencies(options));
    Object.assign(this, this.createDomainApis());
  }

  private resolveRuntimeConfig(options: BrewvaRuntimeOptions): RuntimeConfigState {
    const config = options.config
      ? normalizeBrewvaConfig(options.config, DEFAULT_BREWVA_CONFIG)
      : loadBrewvaConfig({
          cwd: this.cwd,
          configPath: options.configPath,
        });

    if (options.routingScopes && options.routingScopes.length > 0) {
      config.skills.routing.enabled = true;
      config.skills.routing.scopes = [...new Set(options.routingScopes)];
    }

    return {
      config,
      readonlyConfig: deepFreezeValue(config),
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
        turnWalStore: this.turnWalStore,
        contextBudget: this.contextBudget,
        contextInjection: this.contextInjection,
        turnReplay: this.turnReplay,
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
        turnWalStore: this.turnWalStore,
        contextBudget: this.contextBudget,
        contextInjection: this.contextInjection,
        turnReplay: this.turnReplay,
        fileChanges: this.fileChanges,
        costTracker: this.costTracker,
        projectionEngine: this.projectionEngine,
      },
      sessionState: this.sessionState,
      resolveToolGovernanceDescriptor: (toolName) => this.toolGovernanceRegistry.get(toolName),
      resolveToolGovernanceSource: (toolName) =>
        getToolGovernanceResolution(toolName, this.toolGovernanceRegistry).source,
      resolveToolExecutionBoundary: (toolName) =>
        this.toolGovernanceRegistry.get(toolName)?.boundary ?? "safe",
      resolveCheckpointCostSummary: (sessionId) => this.resolveCheckpointCostSummary(sessionId),
      resolveCheckpointCostSkillLastTurnByName: (sessionId) =>
        this.resolveCheckpointCostSkillLastTurnByName(sessionId),
      evaluateCompletion: (sessionId, level) => this.evaluateCompletion(sessionId, level),
    });
  }

  private createDomainApis(): {
    skills: BrewvaRuntime["skills"];
    proposals: BrewvaRuntime["proposals"];
    context: BrewvaRuntime["context"];
    tools: BrewvaRuntime["tools"];
    task: BrewvaRuntime["task"];
    truth: BrewvaRuntime["truth"];
    ledger: BrewvaRuntime["ledger"];
    schedule: BrewvaRuntime["schedule"];
    turnWal: BrewvaRuntime["turnWal"];
    events: BrewvaRuntime["events"];
    verification: BrewvaRuntime["verification"];
    cost: BrewvaRuntime["cost"];
    session: BrewvaRuntime["session"];
  } {
    return {
      skills: {
        refresh: () => {
          this.skillRegistry.load();
          this.skillRegistry.writeIndex();
        },
        getLoadReport: () => this.skillRegistry.getLoadReport(),
        list: () => this.skillRegistry.list(),
        get: (name) => this.skillRegistry.get(name),
        activate: (sessionId, name) => this.skillLifecycleService.activateSkill(sessionId, name),
        getActive: (sessionId) => this.skillLifecycleService.getActiveSkill(sessionId),
        validateOutputs: (sessionId, outputs) =>
          this.skillLifecycleService.validateSkillOutputs(sessionId, outputs),
        complete: (sessionId, output) =>
          this.skillLifecycleService.completeSkill(sessionId, output),
        getOutputs: (sessionId, skillName) =>
          this.skillLifecycleService.getSkillOutputs(sessionId, skillName),
        getConsumedOutputs: (sessionId, targetSkillName) =>
          this.skillLifecycleService.getAvailableConsumedOutputs(sessionId, targetSkillName),
      },
      proposals: {
        submit: (sessionId, proposal) =>
          this.proposalAdmissionService.submitProposal(sessionId, proposal),
        list: (sessionId, query) =>
          this.proposalAdmissionService.listProposalRecords(sessionId, query),
        listPendingEffectCommitments: (sessionId) =>
          this.effectCommitmentDeskService.listPending(sessionId),
        decideEffectCommitment: (sessionId, requestId, input) =>
          this.effectCommitmentDeskService.decide(sessionId, requestId, input),
      },
      context: {
        onTurnStart: (sessionId, turnIndex) => {
          this.sessionLifecycleService.onTurnStart(sessionId, turnIndex);
          this.taskWatchdogService.onTurnStart(sessionId);
        },
        onTurnEnd: () => {},
        onUserInput: () => {},
        sanitizeInput: (text) => this.sanitizeInput(text),
        observeUsage: (sessionId, usage) =>
          this.contextService.observeContextUsage(sessionId, usage),
        getUsage: (sessionId) => this.contextService.getContextUsage(sessionId),
        getUsageRatio: (usage) => this.contextService.getContextUsageRatio(usage),
        getHardLimitRatio: (sessionId, usage) =>
          this.contextService.getContextHardLimitRatio(sessionId, usage),
        getCompactionThresholdRatio: (sessionId, usage) =>
          this.contextService.getContextCompactionThresholdRatio(sessionId, usage),
        getPressureStatus: (sessionId, usage) =>
          this.contextService.getContextPressureStatus(sessionId, usage),
        getPressureLevel: (sessionId, usage) =>
          this.contextService.getContextPressureLevel(sessionId, usage),
        getCompactionGateStatus: (sessionId, usage) =>
          this.contextService.getContextCompactionGateStatus(sessionId, usage),
        checkCompactionGate: (sessionId, toolName, usage) =>
          this.contextService.checkContextCompactionGate(sessionId, toolName, usage),
        registerProvider: (provider) => this.contextService.registerContextSourceProvider(provider),
        unregisterProvider: (source) => this.contextService.unregisterContextSourceProvider(source),
        listProviders: () => this.contextService.listContextSourceProviders(),
        buildInjection: (sessionId, prompt, usage, injectionScopeId) =>
          this.contextService.buildContextInjection(sessionId, prompt, usage, injectionScopeId),
        appendSupplementalInjection: (sessionId, inputText, usage, injectionScopeId) =>
          this.contextService.appendSupplementalContextInjection(
            sessionId,
            inputText,
            usage,
            injectionScopeId,
          ),
        checkAndRequestCompaction: (sessionId, usage) =>
          this.contextService.checkAndRequestCompaction(sessionId, usage),
        requestCompaction: (sessionId, reason) =>
          this.contextService.requestCompaction(sessionId, reason),
        getPendingCompactionReason: (sessionId) =>
          this.contextService.getPendingCompactionReason(sessionId),
        getCompactionInstructions: () => this.contextService.getCompactionInstructions(),
        getCompactionWindowTurns: () => this.contextService.getRecentCompactionWindowTurns(),
        markCompacted: (sessionId, input) =>
          this.contextService.markContextCompacted(sessionId, input),
      },
      tools: {
        checkAccess: (sessionId, toolName) =>
          this.toolGateService.checkToolAccess(sessionId, toolName),
        explainAccess: (input) => {
          const access = this.toolGateService.explainToolAccess(input.sessionId, input.toolName);
          if (!access.allowed) {
            return {
              allowed: false,
              reason: access.reason,
              warning: access.warning,
            };
          }
          const compaction = this.contextService.explainContextCompactionGate(
            input.sessionId,
            input.toolName,
            input.usage,
          );
          if (!compaction.allowed) {
            return {
              allowed: false,
              reason: compaction.reason,
            };
          }
          const warnings = [access.warning].filter(
            (value): value is string => typeof value === "string" && value.trim().length > 0,
          );
          return warnings.length > 0
            ? { allowed: true, warning: warnings.join("; ") }
            : { allowed: true };
        },
        getGovernanceDescriptor: (toolName) => this.toolGovernanceRegistry.get(toolName),
        registerGovernanceDescriptor: (toolName, input) =>
          this.toolGovernanceRegistry.register(toolName, input),
        unregisterGovernanceDescriptor: (toolName) =>
          this.toolGovernanceRegistry.unregister(toolName),
        start: (input) => this.toolInvocationSpine.begin(input),
        finish: (input) => {
          this.toolInvocationSpine.complete(input);
        },
        acquireParallelSlot: (sessionId, runId) =>
          this.parallelService.acquireParallelSlot(sessionId, runId),
        acquireParallelSlotAsync: (sessionId, runId, options) =>
          this.parallelService.acquireParallelSlotAsync(sessionId, runId, options),
        releaseParallelSlot: (sessionId, runId) =>
          this.parallelService.releaseParallelSlot(sessionId, runId),
        requestResourceLease: (sessionId, request) =>
          this.resourceLeaseService.requestLease(sessionId, request),
        listResourceLeases: (sessionId, query) =>
          this.resourceLeaseService.listLeases(sessionId, query),
        cancelResourceLease: (sessionId, leaseId, reason) =>
          this.resourceLeaseService.cancelLease(sessionId, leaseId, reason),
        markCall: (sessionId, toolName) => this.fileChangeService.markToolCall(sessionId, toolName),
        trackCallStart: (input) => this.fileChangeService.trackToolCallStart(input),
        trackCallEnd: (input) => this.fileChangeService.trackToolCallEnd(input),
        rollbackLastPatchSet: (sessionId) => this.fileChangeService.rollbackLastPatchSet(sessionId),
        rollbackLastMutation: (sessionId) => this.mutationRollbackService.rollbackLast(sessionId),
        resolveUndoSessionId: (preferredSessionId) =>
          this.fileChangeService.resolveUndoSessionId(preferredSessionId),
        recordResult: (input) => this.toolInvocationSpine.recordResult(input),
      },
      task: {
        setSpec: (sessionId, spec) => this.taskService.setTaskSpec(sessionId, spec),
        addItem: (sessionId, input) => this.taskService.addTaskItem(sessionId, input),
        updateItem: (sessionId, input) => this.taskService.updateTaskItem(sessionId, input),
        recordBlocker: (sessionId, input) => this.taskService.recordTaskBlocker(sessionId, input),
        recordAcceptance: (sessionId, input) =>
          this.taskService.recordTaskAcceptance(sessionId, input),
        resolveBlocker: (sessionId, blockerId) =>
          this.taskService.resolveTaskBlocker(sessionId, blockerId),
        getState: (sessionId) => this.getTaskState(sessionId),
      },
      truth: {
        getState: (sessionId) => this.getTruthState(sessionId),
        upsertFact: (sessionId, input) => this.truthService.upsertTruthFact(sessionId, input),
        resolveFact: (sessionId, truthFactId) =>
          this.truthService.resolveTruthFact(sessionId, truthFactId),
      },
      ledger: {
        getDigest: (sessionId) => this.ledgerService.getLedgerDigest(sessionId),
        query: (sessionId, query) => this.ledgerService.queryLedger(sessionId, query),
        listRows: (sessionId) => this.ledgerService.listLedgerRows(sessionId),
        verifyChain: (sessionId) => this.ledgerService.verifyLedgerChain(sessionId),
        getPath: () => this.ledgerService.getLedgerPath(),
      },
      schedule: {
        createIntent: (sessionId, input) =>
          this.scheduleIntentService.createScheduleIntent(sessionId, input),
        cancelIntent: (sessionId, input) =>
          this.scheduleIntentService.cancelScheduleIntent(sessionId, input),
        updateIntent: (sessionId, input) =>
          this.scheduleIntentService.updateScheduleIntent(sessionId, input),
        listIntents: (query) => this.scheduleIntentService.listScheduleIntents(query),
        getProjectionSnapshot: () => this.scheduleIntentService.getScheduleProjectionSnapshot(),
      },
      turnWal: {
        appendPending: (envelope, source, options) =>
          this.turnWalStore.appendPending(envelope, source, options),
        markInflight: (walId) => this.turnWalStore.markInflight(walId),
        markDone: (walId) => this.turnWalStore.markDone(walId),
        markFailed: (walId, error) => this.turnWalStore.markFailed(walId, error),
        markExpired: (walId) => this.turnWalStore.markExpired(walId),
        listPending: () => this.turnWalStore.listPending(),
        recover: async () => {
          const recovery = new TurnWALRecovery({
            workspaceRoot: this.workspaceRoot,
            config: this.runtimeConfig.infrastructure.turnWal,
            recordEvent: (input: {
              sessionId: string;
              type: string;
              payload?: Record<string, unknown>;
            }) => {
              this.eventPipeline.recordEvent({
                sessionId: input.sessionId,
                type: input.type,
                payload: input.payload,
                skipTapeCheckpoint: true,
              });
            },
          });
          return await recovery.recover();
        },
        compact: () => this.turnWalStore.compact(),
      },
      events: {
        record: (input) => this.eventPipeline.recordEvent(input),
        query: (sessionId, query) => this.eventPipeline.queryEvents(sessionId, query),
        queryStructured: (sessionId, query) =>
          this.eventPipeline.queryStructuredEvents(sessionId, query),
        recordMetricObservation: (sessionId, input) =>
          this.recordMetricObservation(sessionId, input),
        listMetricObservations: (sessionId, query) => this.listMetricObservations(sessionId, query),
        recordGuardResult: (sessionId, input) => this.recordGuardResult(sessionId, input),
        listGuardResults: (sessionId, query) => this.listGuardResults(sessionId, query),
        getTapeStatus: (sessionId) => this.tapeService.getTapeStatus(sessionId),
        getTapePressureThresholds: () => this.tapeService.getPressureThresholds(),
        recordTapeHandoff: (sessionId, input) =>
          this.tapeService.recordTapeHandoff(sessionId, input),
        searchTape: (sessionId, input) => this.tapeService.searchTape(sessionId, input),
        listReplaySessions: (limit) => this.eventPipeline.listReplaySessions(limit),
        subscribe: (listener) => this.eventPipeline.subscribeEvents(listener),
        toStructured: (event) => this.eventPipeline.toStructuredEvent(event),
        list: (sessionId, query) => this.eventStore.list(sessionId, query),
        listSessionIds: () => this.eventStore.listSessionIds(),
      },
      verification: {
        evaluate: (sessionId, level) => this.evaluateCompletion(sessionId, level),
        verify: (sessionId, level, options) => {
          this.sessionLifecycleService.ensureHydrated(sessionId);
          return this.verificationService.verifyCompletion(sessionId, level, options);
        },
      },
      cost: {
        recordAssistantUsage: (input) => this.costService.recordAssistantUsage(input),
        getSummary: (sessionId) => this.costService.getCostSummary(sessionId),
      },
      session: {
        recordWorkerResult: (sessionId, result) =>
          this.parallelService.recordWorkerResult(sessionId, result),
        listWorkerResults: (sessionId) => this.parallelService.listWorkerResults(sessionId),
        mergeWorkerResults: (sessionId) => this.parallelService.mergeWorkerResults(sessionId),
        applyMergedWorkerResults: (sessionId, input) =>
          this.parallelService.applyMergedWorkerResults(sessionId, input),
        clearWorkerResults: (sessionId) => this.parallelService.clearWorkerResults(sessionId),
        pollStall: (sessionId, input) =>
          this.taskWatchdogService.pollTaskProgress({
            sessionId,
            now: input?.now,
            thresholdMs: input?.thresholdMs,
          }),
        recordDelegationRun: (sessionId, record) =>
          this.sessionLifecycleService.recordDelegationRun(sessionId, record),
        getDelegationRun: (sessionId, runId) =>
          this.sessionLifecycleService.getDelegationRun(sessionId, runId),
        listDelegationRuns: (sessionId, query) =>
          this.sessionLifecycleService.listDelegationRuns(sessionId, query),
        listPendingDelegationOutcomes: (sessionId, query) =>
          this.sessionLifecycleService.listPendingDelegationOutcomes(sessionId, query),
        clearState: (sessionId) => this.sessionLifecycleService.clearSessionState(sessionId),
        onClearState: (listener) => this.sessionLifecycleService.onClearState(listener),
        getHydration: (sessionId) => {
          this.sessionLifecycleService.ensureHydrated(sessionId);
          return this.sessionLifecycleService.getHydrationState(sessionId);
        },
      },
    };
  }

  private getTaskState(sessionId: string): TaskState {
    return this.turnReplay.getTaskState(sessionId);
  }

  private getTruthState(sessionId: string): TruthState {
    return this.turnReplay.getTruthState(sessionId);
  }

  private recordEvent(input: RuntimeRecordEventInput): BrewvaEventRecord | undefined {
    return this.eventPipeline.recordEvent(input);
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
      payload: payload as unknown as Record<string, unknown>,
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
      payload: payload as unknown as Record<string, unknown>,
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
    const sessionIds = this.resolveIterationFactSessionIds(sessionId, query.sessionScope);
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

  private resolveIterationFactSessionIds(
    sessionId: string,
    sessionScope: IterationFactSessionScope | undefined,
  ): string[] {
    if (sessionScope !== "parent_lineage") {
      return [sessionId];
    }

    const scheduleEvents = this.collectScheduleIntentEvents();
    const rootSessionId = this.resolveIterationLineageRootSessionId(sessionId, scheduleEvents);
    const sessionIds = new Set<string>([rootSessionId]);

    let progressed = true;
    while (progressed) {
      progressed = false;
      for (const payload of scheduleEvents) {
        if (payload.kind !== "intent_fired" || payload.continuityMode !== "inherit") {
          continue;
        }
        const childSessionId =
          typeof payload.childSessionId === "string" ? payload.childSessionId.trim() : "";
        if (
          !childSessionId ||
          !sessionIds.has(payload.parentSessionId) ||
          sessionIds.has(childSessionId)
        ) {
          continue;
        }
        sessionIds.add(childSessionId);
        progressed = true;
      }
    }

    return [...sessionIds];
  }

  private collectScheduleIntentEvents(): ScheduleIntentEventPayload[] {
    const rows: BrewvaEventRecord[] = [];
    for (const sessionId of this.eventStore.listSessionIds()) {
      rows.push(...this.eventStore.list(sessionId, { type: SCHEDULE_EVENT_TYPE }));
    }
    return rows
      .toSorted(
        (left, right) => left.timestamp - right.timestamp || left.id.localeCompare(right.id),
      )
      .flatMap((row) => {
        const payload = parseScheduleIntentEvent(row);
        return payload ? [payload] : [];
      });
  }

  private resolveIterationLineageRootSessionId(
    sessionId: string,
    scheduleEvents: readonly ScheduleIntentEventPayload[],
  ): string {
    const visited = new Set<string>();
    let currentSessionId = sessionId;

    while (!visited.has(currentSessionId)) {
      visited.add(currentSessionId);
      let parentSessionId: string | undefined;
      for (let index = scheduleEvents.length - 1; index >= 0; index -= 1) {
        const payload = scheduleEvents[index];
        if (!payload || payload.kind !== "intent_fired" || payload.continuityMode !== "inherit") {
          continue;
        }
        if (payload.childSessionId?.trim() === currentSessionId) {
          parentSessionId = payload.parentSessionId;
          break;
        }
      }
      if (!parentSessionId || parentSessionId === currentSessionId) {
        break;
      }
      currentSessionId = parentSessionId;
    }

    return currentSessionId;
  }

  private isContextBudgetEnabled(): boolean {
    return this.runtimeConfig.infrastructure.contextBudget.enabled;
  }
}
