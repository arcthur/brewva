import type { RecoveryWalStore } from "./channels/recovery-wal.js";
import type { TurnEnvelope } from "./channels/turn.js";
import type { ContextInjectionCollector, ContextInjectionEntry } from "./context/injection.js";
import type { ContextSourceProvider, ContextSourceProviderDescriptor } from "./context/provider.js";
import type {
  BrewvaConfig,
  BrewvaEventRecord,
  BrewvaEventQuery,
  BrewvaReplaySession,
  BrewvaStructuredEvent,
  BrewvaWalId,
  BuildContextInjectionOptions,
  ContextCompactionGateStatus,
  ContextCompactionReason,
  CorrectionRedoInput,
  CorrectionRedoResult,
  CorrectionState,
  CorrectionUndoInput,
  CorrectionUndoResult,
  ContextBudgetUsage,
  ContextPressureLevel,
  ContextPressureStatus,
  DecisionReceipt,
  DecideEffectCommitmentInput,
  DecideEffectCommitmentResult,
  ActiveReasoningBranchState,
  ActiveSkillRuntimeState,
  EvidenceLedgerRow,
  EvidenceQuery,
  EffectCommitmentDiffPreview,
  EffectCommitmentListQuery,
  EffectCommitmentProposal,
  EffectCommitmentRecord,
  EffectCommitmentRequestListQuery,
  EffectCommitmentRequestRecord,
  HistoryViewBaselineSnapshot,
  IntegrityStatus,
  OpenToolCallRecord,
  ParallelAcquireResult,
  PendingEffectCommitmentRequest,
  PromptStabilityObservationInput,
  PromptStabilityState,
  ReasoningCheckpointRecord,
  ReasoningRevertInput,
  ReasoningRevertRecord,
  RecordReasoningCheckpointInput,
  RecordCorrectionCheckpointInput,
  RecoveryPostureSnapshot,
  RecoveryWalRecord,
  RecoveryWalRecoveryResult,
  RecoveryWalSource,
  RecoveryWorkingSetSnapshot,
  ResourceLeaseCancelResult,
  ResourceLeaseQuery,
  ResourceLeaseRecord,
  ResourceLeaseRequest,
  ResourceLeaseResult,
  RollbackResult,
  RedoResult,
  ScheduleIntentCancelInput,
  ScheduleIntentCancelResult,
  ScheduleIntentCreateInput,
  ScheduleIntentCreateResult,
  ScheduleIntentListQuery,
  ScheduleIntentProjectionRecord,
  ScheduleIntentUpdateInput,
  ScheduleIntentUpdateResult,
  ScheduleProjectionSnapshot,
  SessionCompactionCommitInput,
  SessionCostSummary,
  SessionHydrationState,
  SessionLifecycleSnapshot,
  SessionUncleanShutdownDiagnostic,
  SessionWireFrame,
  SkillActivationResult,
  SkillCompletionFailureRecord,
  SkillConsumedOutputsView,
  SkillDocument,
  SkillNormalizedOutputsView,
  SkillOutputValidationResult,
  SkillReadinessEntry,
  SkillReadinessQuery,
  SkillRefreshInput,
  SkillRefreshResult,
  SkillRegistryLoadReport,
  TapeHandoffResult,
  TapeSearchResult,
  TapeSearchScope,
  TapeStatusState,
  TaskAcceptanceRecordResult,
  TaskBlockerRecordResult,
  TaskBlockerResolveResult,
  TaskItemAddResult,
  TaskItemStatus,
  TaskItemUpdateResult,
  TaskTargetDescriptor,
  TaskSpec,
  TaskState,
  ToolActionPolicy,
  ToolActionPolicyResolver,
  ToolExecutionBoundary,
  ToolMutationReceipt,
  ToolMutationRollbackResult,
  TransientReductionObservationInput,
  TransientReductionState,
  TruthFactResolveResult,
  TruthFactSeverity,
  TruthFactStatus,
  TruthFactUpsertResult,
  TruthState,
  VerificationLevel,
  VerificationReport,
  WorkerApplyReport,
  WorkerMergeReport,
  WorkerResult,
} from "./contracts/index.js";
import type { BrewvaEventStore } from "./events/store.js";
import type {
  GuardResultInput,
  GuardResultQuery,
  GuardResultRecord,
  MetricObservationInput,
  MetricObservationQuery,
  MetricObservationRecord,
} from "./iteration/facts.js";
import type { CommandPolicySummary } from "./security/command-policy.js";
import type { VirtualReadonlyPolicySummary } from "./security/virtual-readonly-policy.js";
import type { ContextService } from "./services/context.js";
import type { CorrectionService } from "./services/correction.js";
import type { CostService } from "./services/cost.js";
import type { CredentialVaultService } from "./services/credential-vault.js";
import type { EventPipelineService, RuntimeRecordEvent } from "./services/event-pipeline.js";
import type { FileChangeService } from "./services/file-change.js";
import type { LedgerService } from "./services/ledger.js";
import type { MutationRollbackService } from "./services/mutation-rollback.js";
import type { ParallelService } from "./services/parallel.js";
import type { ReasoningService } from "./services/reasoning.js";
import type { ResourceLeaseService } from "./services/resource-lease.js";
import type { ScheduleIntentService } from "./services/schedule-intent.js";
import type { SessionLifecycleService } from "./services/session-lifecycle.js";
import type { SessionWireService } from "./services/session-wire.js";
import type { SkillLifecycleService } from "./services/skill-lifecycle.js";
import type { TapeService } from "./services/tape.js";
import type { TaskWatchdogService } from "./services/task-watchdog.js";
import type { TaskService } from "./services/task.js";
import type { ToolGateService } from "./services/tool-gate.js";
import type { ToolInvocationSpine } from "./services/tool-invocation-spine.js";
import type { TruthService } from "./services/truth.js";
import type { VerificationService } from "./services/verification.js";
import type { SkillRegistry } from "./skills/registry.js";

interface ActionPolicyRegistryLike {
  get(toolName: string, args?: Record<string, unknown>): ToolActionPolicy | undefined;
  register(toolName: string, input: ToolActionPolicy): void;
  registerResolver(toolName: string, resolver: ToolActionPolicyResolver): void;
  unregister(toolName: string): void;
}

export interface BrewvaRuntimeMethodGroups {
  skills: {
    refresh(input?: SkillRefreshInput): SkillRefreshResult;
    getLoadReport(): SkillRegistryLoadReport;
    list(): SkillDocument[];
    get(name: string): SkillDocument | undefined;
    activate(sessionId: string, name: string): SkillActivationResult;
    getActive(sessionId: string): SkillDocument | undefined;
    getActiveState(sessionId: string): ActiveSkillRuntimeState | undefined;
    getLatestFailure(sessionId: string): SkillCompletionFailureRecord | undefined;
    validateOutputs(
      sessionId: string,
      outputs: Record<string, unknown>,
    ): SkillOutputValidationResult;
    recordCompletionFailure(
      sessionId: string,
      outputs: Record<string, unknown>,
      validation: SkillOutputValidationResult & { ok: false },
      usage?: ContextBudgetUsage,
    ): SkillCompletionFailureRecord | undefined;
    complete(sessionId: string, output: Record<string, unknown>): SkillOutputValidationResult;
    getRawOutputs(sessionId: string, skillName: string): Record<string, unknown> | undefined;
    getNormalizedOutputs(
      sessionId: string,
      skillName: string,
    ): SkillNormalizedOutputsView | undefined;
    getConsumedOutputs(sessionId: string, targetSkillName: string): SkillConsumedOutputsView;
    getReadiness(sessionId: string, query?: SkillReadinessQuery): SkillReadinessEntry[];
  };
  proposals: {
    submit(sessionId: string, proposal: EffectCommitmentProposal): DecisionReceipt;
    list(sessionId: string, query?: EffectCommitmentListQuery): EffectCommitmentRecord[];
    listEffectCommitmentRequests(
      sessionId: string,
      query?: EffectCommitmentRequestListQuery,
    ): EffectCommitmentRequestRecord[];
    listPendingEffectCommitments(sessionId: string): PendingEffectCommitmentRequest[];
    decideEffectCommitment(
      sessionId: string,
      requestId: string,
      input: DecideEffectCommitmentInput,
    ): DecideEffectCommitmentResult;
  };
  reasoning: {
    recordCheckpoint(
      sessionId: string,
      input: RecordReasoningCheckpointInput,
    ): ReasoningCheckpointRecord;
    revert(sessionId: string, input: ReasoningRevertInput): ReasoningRevertRecord;
    getActiveState(sessionId: string): ActiveReasoningBranchState;
    listCheckpoints(sessionId: string): ReasoningCheckpointRecord[];
    getCheckpoint(sessionId: string, checkpointId: string): ReasoningCheckpointRecord | undefined;
    listReverts(sessionId: string): ReasoningRevertRecord[];
    canRevertTo(sessionId: string, checkpointId: string): boolean;
  };
  correction: {
    recordCheckpoint(
      sessionId: string,
      input?: RecordCorrectionCheckpointInput,
    ): CorrectionState["checkpoints"][number];
    undo(sessionId: string, input?: CorrectionUndoInput): CorrectionUndoResult;
    redo(sessionId: string, input?: CorrectionRedoInput): CorrectionRedoResult;
    getState(sessionId: string): CorrectionState;
  };
  context: {
    onTurnStart(sessionId: string, turnIndex: number): void;
    onTurnEnd(sessionId: string): void;
    onUserInput(sessionId: string): void;
    sanitizeInput(text: string): string;
    observeUsage(sessionId: string, usage: ContextBudgetUsage | undefined): void;
    observePromptStability(
      sessionId: string,
      input: PromptStabilityObservationInput,
    ): PromptStabilityState;
    observeTransientReduction(
      sessionId: string,
      input: TransientReductionObservationInput,
    ): TransientReductionState;
    getUsage(sessionId: string): ContextBudgetUsage | undefined;
    getPromptStability(sessionId: string): PromptStabilityState | undefined;
    getTransientReduction(sessionId: string): TransientReductionState | undefined;
    getReservedPrimaryTokens(sessionId: string, injectionScopeId?: string): number;
    getReservedSupplementalTokens(sessionId: string, injectionScopeId?: string): number;
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
    getHistoryViewBaseline(sessionId: string): HistoryViewBaselineSnapshot | undefined;
    registerProvider(provider: ContextSourceProvider): void;
    unregisterProvider(source: string): boolean;
    listProviders(): readonly ContextSourceProviderDescriptor[];
    buildInjection(
      sessionId: string,
      prompt: string,
      usage?: ContextBudgetUsage,
      options?: BuildContextInjectionOptions,
    ): Promise<{
      text: string;
      entries: ContextInjectionEntry[];
      accepted: boolean;
      originalTokens: number;
      finalTokens: number;
      truncated: boolean;
    }>;
    appendGuardedSupplementalBlocks(
      sessionId: string,
      blocks: readonly {
        familyId: string;
        content: string;
      }[],
      usage?: ContextBudgetUsage,
      injectionScopeId?: string,
    ): Array<{
      familyId: string;
      accepted: boolean;
      text: string;
      originalTokens: number;
      finalTokens: number;
      truncated: boolean;
      droppedReason?: "hard_limit" | "budget_exhausted";
    }>;
    checkAndRequestCompaction(sessionId: string, usage: ContextBudgetUsage | undefined): boolean;
    requestCompaction(sessionId: string, reason: ContextCompactionReason): void;
    getPendingCompactionReason(sessionId: string): ContextCompactionReason | null;
    getCompactionInstructions(): string;
    getCompactionWindowTurns(): number;
  };
  tools: {
    checkAccess(
      sessionId: string,
      toolName: string,
      args?: Record<string, unknown>,
    ): { allowed: boolean; reason?: string };
    explainAccess(input: {
      sessionId: string;
      toolName: string;
      args?: Record<string, unknown>;
      cwd?: string;
      usage?: ContextBudgetUsage;
    }): {
      allowed: boolean;
      reason?: string;
      warning?: string;
      commandPolicy?: CommandPolicySummary;
      virtualReadonly?: VirtualReadonlyPolicySummary;
    };
    getActionPolicy(toolName: string, args?: Record<string, unknown>): ToolActionPolicy | undefined;
    registerActionPolicy(toolName: string, input: ToolActionPolicy): void;
    registerActionPolicyResolver(toolName: string, resolver: ToolActionPolicyResolver): void;
    unregisterActionPolicy(toolName: string): void;
    start(input: {
      sessionId: string;
      toolCallId: string;
      toolName: string;
      args?: Record<string, unknown>;
      cwd?: string;
      usage?: ContextBudgetUsage;
      recordLifecycleEvent?: boolean;
      effectCommitmentRequestId?: string;
      diffPreview?: EffectCommitmentDiffPreview;
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
    redoLastPatchSet(sessionId: string): RedoResult;
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
  task: {
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
    getTargetDescriptor(sessionId: string): TaskTargetDescriptor;
    getState(sessionId: string): TaskState;
  };
  truth: {
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
  ledger: {
    getDigest(sessionId: string): string;
    query(sessionId: string, query: EvidenceQuery): string;
    listRows(sessionId?: string): EvidenceLedgerRow[];
    verifyIntegrity(sessionId: string): { valid: boolean; reason?: string };
    getPath(): string;
  };
  schedule: {
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
  recoveryWal: {
    appendPending(
      envelope: TurnEnvelope,
      source: RecoveryWalSource,
      options?: { ttlMs?: number; dedupeKey?: string },
    ): RecoveryWalRecord;
    markInflight(walId: BrewvaWalId): RecoveryWalRecord | undefined;
    markDone(walId: BrewvaWalId): RecoveryWalRecord | undefined;
    markFailed(walId: BrewvaWalId, error?: string): RecoveryWalRecord | undefined;
    markExpired(walId: BrewvaWalId): RecoveryWalRecord | undefined;
    listPending(): RecoveryWalRecord[];
    getPosture(sessionId: string): RecoveryPostureSnapshot;
    getWorkingSet(sessionId: string): RecoveryWorkingSetSnapshot | undefined;
    recover(): Promise<RecoveryWalRecoveryResult>;
    compact(): {
      scope: string;
      filePath: string;
      scanned: number;
      retained: number;
      dropped: number;
    };
  };
  lifecycle: {
    getSnapshot(sessionId: string): SessionLifecycleSnapshot;
  };
  events: {
    record: RuntimeRecordEvent;
    resolveLogPath(sessionId: string): string;
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
  verification: {
    evaluate(sessionId: string, level?: VerificationLevel): VerificationReport;
    verify(
      sessionId: string,
      level?: VerificationLevel,
      options?: { executeCommands?: boolean; timeoutMs?: number },
    ): Promise<VerificationReport>;
  };
  cost: {
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
  session: {
    recordWorkerResult(sessionId: string, result: WorkerResult): void;
    listWorkerResults(sessionId: string): WorkerResult[];
    getOpenToolCalls(sessionId: string): OpenToolCallRecord[];
    getUncleanShutdownDiagnostic(sessionId: string): SessionUncleanShutdownDiagnostic | undefined;
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
    clearState(sessionId: string): void;
    onClearState(listener: (sessionId: string) => void): () => void;
    getHydration(sessionId: string): SessionHydrationState;
    getIntegrity(sessionId: string): IntegrityStatus;
    commitCompaction(sessionId: string, input: SessionCompactionCommitInput): BrewvaEventRecord;
    resolveCredentialBindings(sessionId: string, toolName: string): Record<string, string>;
    resolveSandboxApiKey(sessionId: string): string | undefined;
  };
  sessionWire: {
    query(sessionId: string): SessionWireFrame[];
    subscribe(sessionId: string, listener: (frame: SessionWireFrame) => void): () => void;
  };
}

export interface RuntimeMethodGroupsDependencies {
  runtimeConfig: BrewvaConfig;
  skillRegistry: SkillRegistry;
  skillLifecycleService: SkillLifecycleService;
  getProposalAdmissionService(): {
    submitProposal(sessionId: string, proposal: EffectCommitmentProposal): DecisionReceipt;
    listProposalRecords(
      sessionId: string,
      query?: EffectCommitmentListQuery,
    ): EffectCommitmentRecord[];
  };
  getEffectCommitmentDeskService(): {
    listRequests(
      sessionId: string,
      query?: EffectCommitmentRequestListQuery,
    ): EffectCommitmentRequestRecord[];
    listPending(sessionId: string): PendingEffectCommitmentRequest[];
    decide(
      sessionId: string,
      requestId: string,
      input: DecideEffectCommitmentInput,
    ): DecideEffectCommitmentResult;
  };
  contextInjection: ContextInjectionCollector;
  contextService: ContextService;
  sessionLifecycleService: SessionLifecycleService;
  taskWatchdogService: TaskWatchdogService;
  taskService: TaskService;
  truthService: TruthService;
  ledgerService: LedgerService;
  recoveryWalStore: RecoveryWalStore;
  eventStore: BrewvaEventStore;
  eventPipeline: EventPipelineService;
  costService: CostService;
  actionPolicyRegistry: ActionPolicyRegistryLike;
  getReasoningService(): ReasoningService;
  getCorrectionService(): CorrectionService;
  getToolGateService(): ToolGateService;
  getToolInvocationSpine(): ToolInvocationSpine;
  getParallelService(): ParallelService;
  getResourceLeaseService(): ResourceLeaseService;
  getFileChangeService(): FileChangeService;
  getMutationRollbackService(): MutationRollbackService;
  getScheduleIntentService(): ScheduleIntentService;
  getTapeService(): TapeService;
  getVerificationService(): VerificationService;
  getCredentialVaultService(): CredentialVaultService;
  getSessionWireService(): SessionWireService;
  refreshSkillsState(input?: SkillRefreshInput): SkillRefreshResult;
  sanitizeInput(text: string): string;
  getHistoryViewBaseline(sessionId: string): HistoryViewBaselineSnapshot | undefined;
  getTaskTargetDescriptor(sessionId: string): TaskTargetDescriptor;
  getTaskState(sessionId: string): TaskState;
  getTruthState(sessionId: string): TruthState;
  getRecoveryPosture(sessionId: string): RecoveryPostureSnapshot;
  getRecoveryWorkingSet(sessionId: string): RecoveryWorkingSetSnapshot | undefined;
  recordEvent: RuntimeRecordEvent;
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
  evaluateCompletion(sessionId: string, level?: VerificationLevel): VerificationReport;
  getSessionLifecycleSnapshot(sessionId: string): SessionLifecycleSnapshot;
  invalidateSessionLifecycleSnapshot(sessionId: string): void;
  recoverRecoveryWal(): Promise<RecoveryWalRecoveryResult>;
}

export function createRuntimeMethodGroups(
  deps: RuntimeMethodGroupsDependencies,
): BrewvaRuntimeMethodGroups {
  return {
    skills: {
      refresh: (input?: SkillRefreshInput) => deps.refreshSkillsState(input),
      getLoadReport: () => deps.skillRegistry.getLoadReport(),
      list: () => deps.skillRegistry.list(),
      get: (name: string) => deps.skillRegistry.get(name),
      activate: (sessionId: string, name: string) =>
        deps.skillLifecycleService.activateSkill(sessionId, name),
      getActive: (sessionId: string) => deps.skillLifecycleService.getActiveSkill(sessionId),
      getActiveState: (sessionId: string) =>
        deps.skillLifecycleService.getActiveSkillState(sessionId),
      getLatestFailure: (sessionId: string) =>
        deps.skillLifecycleService.getLatestSkillFailure(sessionId),
      validateOutputs: (sessionId: string, outputs: Record<string, unknown>) =>
        deps.skillLifecycleService.validateSkillOutputs(sessionId, outputs),
      recordCompletionFailure: (
        sessionId: string,
        outputs: Record<string, unknown>,
        validation: ReturnType<SkillLifecycleService["validateSkillOutputs"]> & { ok: false },
        usage?: ContextBudgetUsage,
      ) =>
        deps.skillLifecycleService.recordCompletionFailure(sessionId, outputs, validation, usage),
      complete: (sessionId: string, output: Record<string, unknown>) =>
        deps.skillLifecycleService.completeSkill(sessionId, output),
      getRawOutputs: (sessionId: string, skillName: string) =>
        deps.skillLifecycleService.getRawSkillOutputs(sessionId, skillName),
      getNormalizedOutputs: (sessionId: string, skillName: string) =>
        deps.skillLifecycleService.getNormalizedSkillOutputs(sessionId, skillName),
      getConsumedOutputs: (sessionId: string, targetSkillName: string) =>
        deps.skillLifecycleService.getAvailableConsumedOutputs(sessionId, targetSkillName),
      getReadiness: (sessionId: string, query?: SkillReadinessQuery) =>
        deps.skillLifecycleService.getSkillReadiness(sessionId, query),
    },
    proposals: {
      submit: (sessionId: string, proposal: EffectCommitmentProposal): DecisionReceipt =>
        deps.getProposalAdmissionService().submitProposal(sessionId, proposal),
      list: (sessionId: string, query?: EffectCommitmentListQuery): EffectCommitmentRecord[] =>
        deps.getProposalAdmissionService().listProposalRecords(sessionId, query),
      listEffectCommitmentRequests: (
        sessionId: string,
        query?: EffectCommitmentRequestListQuery,
      ): EffectCommitmentRequestRecord[] =>
        deps.getEffectCommitmentDeskService().listRequests(sessionId, query),
      listPendingEffectCommitments: (sessionId: string): PendingEffectCommitmentRequest[] =>
        deps.getEffectCommitmentDeskService().listPending(sessionId),
      decideEffectCommitment: (
        sessionId: string,
        requestId: string,
        input: DecideEffectCommitmentInput,
      ): DecideEffectCommitmentResult =>
        deps.getEffectCommitmentDeskService().decide(sessionId, requestId, input),
    },
    reasoning: {
      recordCheckpoint: (
        sessionId: string,
        input: Parameters<ReasoningService["recordCheckpoint"]>[1],
      ) => deps.getReasoningService().recordCheckpoint(sessionId, input),
      revert: (sessionId: string, input: Parameters<ReasoningService["revert"]>[1]) =>
        deps.getReasoningService().revert(sessionId, input),
      getActiveState: (sessionId: string) => deps.getReasoningService().getActiveState(sessionId),
      listCheckpoints: (sessionId: string) => deps.getReasoningService().listCheckpoints(sessionId),
      getCheckpoint: (sessionId: string, checkpointId: string) =>
        deps.getReasoningService().getCheckpoint(sessionId, checkpointId),
      listReverts: (sessionId: string) => deps.getReasoningService().listReverts(sessionId),
      canRevertTo: (sessionId: string, checkpointId: string) =>
        deps.getReasoningService().canRevertTo(sessionId, checkpointId),
    },
    correction: {
      recordCheckpoint: (
        sessionId: string,
        input?: Parameters<CorrectionService["recordCheckpoint"]>[1],
      ) => deps.getCorrectionService().recordCheckpoint(sessionId, input),
      undo: (sessionId: string, input?: Parameters<CorrectionService["undo"]>[1]) =>
        deps.getCorrectionService().undo(sessionId, input),
      redo: (sessionId: string, input?: Parameters<CorrectionService["redo"]>[1]) =>
        deps.getCorrectionService().redo(sessionId, input),
      getState: (sessionId: string) => deps.getCorrectionService().getState(sessionId),
    },
    context: {
      onTurnStart: (sessionId: string, turnIndex: number) => {
        deps.sessionLifecycleService.onTurnStart(sessionId, turnIndex);
        deps.taskWatchdogService.onTurnStart(sessionId);
      },
      onTurnEnd: (sessionId: string) => {
        deps.sessionLifecycleService.ensureHydrated(sessionId);
        deps.contextInjection.clearPending(sessionId);
        deps.contextService.clearReservedInjectionTokensForSession(sessionId);
      },
      onUserInput: (sessionId: string) => {
        deps.sessionLifecycleService.ensureHydrated(sessionId);
      },
      sanitizeInput: (text: string) => deps.sanitizeInput(text),
      observeUsage: (sessionId: string, usage: ContextBudgetUsage | undefined) =>
        deps.contextService.observeContextUsage(sessionId, usage),
      observePromptStability: (sessionId: string, input: PromptStabilityObservationInput) => {
        const observed = deps.contextService.observePromptStability(sessionId, input);
        deps.invalidateSessionLifecycleSnapshot(sessionId);
        return observed;
      },
      observeTransientReduction: (sessionId: string, input: TransientReductionObservationInput) =>
        deps.contextService.observeTransientReduction(sessionId, input),
      getUsage: (sessionId: string) => deps.contextService.getContextUsage(sessionId),
      getPromptStability: (sessionId: string) => deps.contextService.getPromptStability(sessionId),
      getTransientReduction: (sessionId: string) =>
        deps.contextService.getTransientReduction(sessionId),
      getReservedPrimaryTokens: (sessionId: string, injectionScopeId?: string) =>
        deps.contextService.getReservedPrimaryTokens(sessionId, injectionScopeId),
      getReservedSupplementalTokens: (sessionId: string, injectionScopeId?: string) =>
        deps.contextService.getReservedSupplementalTokens(sessionId, injectionScopeId),
      getUsageRatio: (usage: ContextBudgetUsage | undefined) =>
        deps.contextService.getContextUsageRatio(usage),
      getHardLimitRatio: (sessionId: string, usage?: ContextBudgetUsage) =>
        deps.contextService.getContextHardLimitRatio(sessionId, usage),
      getCompactionThresholdRatio: (sessionId: string, usage?: ContextBudgetUsage) =>
        deps.contextService.getContextCompactionThresholdRatio(sessionId, usage),
      getPressureStatus: (sessionId: string, usage?: ContextBudgetUsage) =>
        deps.contextService.getContextPressureStatus(sessionId, usage),
      getPressureLevel: (sessionId: string, usage?: ContextBudgetUsage) =>
        deps.contextService.getContextPressureLevel(sessionId, usage),
      getCompactionGateStatus: (sessionId: string, usage?: ContextBudgetUsage) =>
        deps.contextService.getContextCompactionGateStatus(sessionId, usage),
      checkCompactionGate: (sessionId: string, toolName: string, usage?: ContextBudgetUsage) =>
        deps.contextService.checkContextCompactionGate(sessionId, toolName, usage),
      getHistoryViewBaseline: (sessionId: string) => deps.getHistoryViewBaseline(sessionId),
      registerProvider: (provider) => deps.contextService.registerContextSourceProvider(provider),
      unregisterProvider: (source: string) =>
        deps.contextService.unregisterContextSourceProvider(source),
      listProviders: () => deps.contextService.listContextSourceProviders(),
      buildInjection: (
        sessionId: string,
        prompt: string,
        usage?: ContextBudgetUsage,
        options?: Parameters<ContextService["buildContextInjection"]>[3],
      ) => deps.contextService.buildContextInjection(sessionId, prompt, usage, options),
      appendGuardedSupplementalBlocks: (
        sessionId: string,
        blocks: readonly { familyId: string; content: string }[],
        usage?: ContextBudgetUsage,
        injectionScopeId?: string,
      ) =>
        deps.contextService.appendGuardedSupplementalBlocks(
          sessionId,
          blocks,
          usage,
          injectionScopeId,
        ),
      checkAndRequestCompaction: (sessionId: string, usage: ContextBudgetUsage | undefined) =>
        deps.contextService.checkAndRequestCompaction(sessionId, usage),
      requestCompaction: (sessionId: string, reason) =>
        deps.contextService.requestCompaction(sessionId, reason),
      getPendingCompactionReason: (sessionId: string) =>
        deps.contextService.getPendingCompactionReason(sessionId),
      getCompactionInstructions: () => deps.contextService.getCompactionInstructions(),
      getCompactionWindowTurns: () => deps.contextService.getRecentCompactionWindowTurns(),
    },
    tools: {
      checkAccess: (sessionId: string, toolName: string, args?: Record<string, unknown>) =>
        deps.getToolGateService().checkToolAccess(sessionId, toolName, args),
      explainAccess: (input: {
        sessionId: string;
        toolName: string;
        args?: Record<string, unknown>;
        cwd?: string;
        usage?: ContextBudgetUsage;
      }) => {
        const access = deps
          .getToolGateService()
          .explainToolAccessWithArgs(input.sessionId, input.toolName, input.args, input.cwd);
        if (!access.allowed) {
          return {
            allowed: false,
            reason: access.reason,
            warning: access.warning,
            commandPolicy: access.commandPolicy,
            virtualReadonly: access.virtualReadonly,
          };
        }
        const compaction = deps.contextService.explainContextCompactionGate(
          input.sessionId,
          input.toolName,
          input.usage,
        );
        if (!compaction.allowed) {
          return {
            allowed: false,
            reason: compaction.reason,
            commandPolicy: access.commandPolicy,
            virtualReadonly: access.virtualReadonly,
          };
        }
        const warnings = [access.warning].filter(
          (value): value is string => typeof value === "string" && value.trim().length > 0,
        );
        return warnings.length > 0
          ? {
              allowed: true,
              warning: warnings.join("; "),
              commandPolicy: access.commandPolicy,
              virtualReadonly: access.virtualReadonly,
            }
          : {
              allowed: true,
              commandPolicy: access.commandPolicy,
              virtualReadonly: access.virtualReadonly,
            };
      },
      getActionPolicy: (toolName: string, args?: Record<string, unknown>) =>
        deps.actionPolicyRegistry.get(toolName, args),
      registerActionPolicy: (toolName: string, input: ToolActionPolicy) =>
        deps.actionPolicyRegistry.register(toolName, input),
      registerActionPolicyResolver: (toolName: string, resolver: ToolActionPolicyResolver) =>
        deps.actionPolicyRegistry.registerResolver(toolName, resolver),
      unregisterActionPolicy: (toolName: string) => deps.actionPolicyRegistry.unregister(toolName),
      start: (input: Parameters<ToolInvocationSpine["begin"]>[0]) =>
        deps.getToolInvocationSpine().begin(input),
      finish: (input: Parameters<ToolInvocationSpine["complete"]>[0]) => {
        deps.getToolInvocationSpine().complete(input);
      },
      acquireParallelSlot: (sessionId: string, runId: string) =>
        deps.getParallelService().acquireParallelSlot(sessionId, runId),
      acquireParallelSlotAsync: (
        sessionId: string,
        runId: string,
        options?: { timeoutMs?: number },
      ) => deps.getParallelService().acquireParallelSlotAsync(sessionId, runId, options),
      releaseParallelSlot: (sessionId: string, runId: string) =>
        deps.getParallelService().releaseParallelSlot(sessionId, runId),
      requestResourceLease: (
        sessionId: string,
        request: Parameters<ResourceLeaseService["requestLease"]>[1],
      ) => deps.getResourceLeaseService().requestLease(sessionId, request),
      listResourceLeases: (
        sessionId: string,
        query?: Parameters<ResourceLeaseService["listLeases"]>[1],
      ) => deps.getResourceLeaseService().listLeases(sessionId, query),
      cancelResourceLease: (sessionId: string, leaseId: string, reason?: string) =>
        deps.getResourceLeaseService().cancelLease(sessionId, leaseId, reason),
      markCall: (sessionId: string, toolName: string) =>
        deps.getFileChangeService().markToolCall(sessionId, toolName),
      trackCallStart: (input: Parameters<FileChangeService["trackToolCallStart"]>[0]) =>
        deps.getFileChangeService().trackToolCallStart(input),
      trackCallEnd: (input: Parameters<FileChangeService["trackToolCallEnd"]>[0]) =>
        deps.getFileChangeService().trackToolCallEnd(input),
      rollbackLastPatchSet: (sessionId: string) =>
        deps.getFileChangeService().rollbackLastPatchSet(sessionId),
      redoLastPatchSet: (sessionId: string) =>
        deps.getFileChangeService().redoLastPatchSet(sessionId),
      rollbackLastMutation: (sessionId: string) =>
        deps.getMutationRollbackService().rollbackLast(sessionId),
      resolveUndoSessionId: (preferredSessionId?: string) =>
        deps.getFileChangeService().resolveUndoSessionId(preferredSessionId),
      recordResult: (input: Parameters<ToolInvocationSpine["recordResult"]>[0]) =>
        deps.getToolInvocationSpine().recordResult(input),
    },
    task: {
      setSpec: (sessionId: string, spec) => deps.taskService.setTaskSpec(sessionId, spec),
      addItem: (sessionId: string, input) => deps.taskService.addTaskItem(sessionId, input),
      updateItem: (sessionId: string, input) => deps.taskService.updateTaskItem(sessionId, input),
      recordBlocker: (sessionId: string, input) =>
        deps.taskService.recordTaskBlocker(sessionId, input),
      recordAcceptance: (sessionId: string, input) =>
        deps.taskService.recordTaskAcceptance(sessionId, input),
      resolveBlocker: (sessionId: string, blockerId: string) =>
        deps.taskService.resolveTaskBlocker(sessionId, blockerId),
      getTargetDescriptor: (sessionId: string) => deps.getTaskTargetDescriptor(sessionId),
      getState: (sessionId: string) => deps.getTaskState(sessionId),
    },
    truth: {
      getState: (sessionId: string) => deps.getTruthState(sessionId),
      upsertFact: (sessionId: string, input) => deps.truthService.upsertTruthFact(sessionId, input),
      resolveFact: (sessionId: string, truthFactId: string) =>
        deps.truthService.resolveTruthFact(sessionId, truthFactId),
    },
    ledger: {
      getDigest: (sessionId: string) => deps.ledgerService.getLedgerDigest(sessionId),
      query: (sessionId: string, query) => deps.ledgerService.queryLedger(sessionId, query),
      listRows: (sessionId?: string) => deps.ledgerService.listLedgerRows(sessionId),
      verifyIntegrity: (sessionId: string) => deps.ledgerService.verifyLedgerIntegrity(sessionId),
      getPath: () => deps.ledgerService.getLedgerPath(),
    },
    schedule: {
      createIntent: (sessionId: string, input) =>
        deps.getScheduleIntentService().createScheduleIntent(sessionId, input),
      cancelIntent: (sessionId: string, input) =>
        deps.getScheduleIntentService().cancelScheduleIntent(sessionId, input),
      updateIntent: (sessionId: string, input) =>
        deps.getScheduleIntentService().updateScheduleIntent(sessionId, input),
      listIntents: (query?: Parameters<ScheduleIntentService["listScheduleIntents"]>[0]) =>
        deps.getScheduleIntentService().listScheduleIntents(query),
      getProjectionSnapshot: () => deps.getScheduleIntentService().getScheduleProjectionSnapshot(),
    },
    recoveryWal: {
      appendPending: (envelope, source, options) =>
        deps.recoveryWalStore.appendPending(envelope, source, options),
      markInflight: (walId) => deps.recoveryWalStore.markInflight(walId),
      markDone: (walId) => deps.recoveryWalStore.markDone(walId),
      markFailed: (walId, error) => deps.recoveryWalStore.markFailed(walId, error),
      markExpired: (walId) => deps.recoveryWalStore.markExpired(walId),
      listPending: () => deps.recoveryWalStore.listPending(),
      getPosture: (sessionId: string) => deps.getRecoveryPosture(sessionId),
      getWorkingSet: (sessionId: string) => deps.getRecoveryWorkingSet(sessionId),
      recover: () => deps.recoverRecoveryWal(),
      compact: () => deps.recoveryWalStore.compact(),
    },
    lifecycle: {
      getSnapshot: (sessionId: string) => deps.getSessionLifecycleSnapshot(sessionId),
    },
    events: {
      record: (input) => deps.recordEvent(input),
      resolveLogPath: (sessionId: string) => deps.eventStore.getLogPath(sessionId),
      query: (sessionId: string, query) => deps.eventPipeline.queryEvents(sessionId, query),
      queryStructured: (sessionId: string, query) =>
        deps.eventPipeline.queryStructuredEvents(sessionId, query),
      recordMetricObservation: (sessionId: string, input: MetricObservationInput) =>
        deps.recordMetricObservation(sessionId, input),
      listMetricObservations: (sessionId: string, query?: MetricObservationQuery) =>
        deps.listMetricObservations(sessionId, query),
      recordGuardResult: (sessionId: string, input: GuardResultInput) =>
        deps.recordGuardResult(sessionId, input),
      listGuardResults: (sessionId: string, query?: GuardResultQuery) =>
        deps.listGuardResults(sessionId, query),
      getTapeStatus: (sessionId: string) => deps.getTapeService().getTapeStatus(sessionId),
      getTapePressureThresholds: () => deps.getTapeService().getPressureThresholds(),
      recordTapeHandoff: (sessionId: string, input) =>
        deps.getTapeService().recordTapeHandoff(sessionId, input),
      searchTape: (sessionId: string, input) => deps.getTapeService().searchTape(sessionId, input),
      listReplaySessions: (limit?: number) => deps.eventPipeline.listReplaySessions(limit),
      subscribe: (listener: Parameters<EventPipelineService["subscribeEvents"]>[0]) =>
        deps.eventPipeline.subscribeEvents(listener),
      toStructured: (event: BrewvaEventRecord) => deps.eventPipeline.toStructuredEvent(event),
      list: (sessionId: string, query) => deps.eventStore.list(sessionId, query),
      listSessionIds: () => deps.eventStore.listSessionIds(),
    },
    verification: {
      evaluate: (sessionId: string, level?: VerificationLevel) =>
        deps.evaluateCompletion(sessionId, level),
      verify: async (
        sessionId: string,
        level?: VerificationLevel,
        options?: { executeCommands?: boolean; timeoutMs?: number },
      ) => {
        deps.sessionLifecycleService.ensureHydrated(sessionId);
        return await deps.getVerificationService().verifyCompletion(sessionId, level, options);
      },
    },
    cost: {
      recordAssistantUsage: (input) => deps.costService.recordAssistantUsage(input),
      getSummary: (sessionId: string): SessionCostSummary =>
        deps.costService.getCostSummary(sessionId),
    },
    session: {
      recordWorkerResult: (sessionId: string, result) =>
        deps.getParallelService().recordWorkerResult(sessionId, result),
      listWorkerResults: (sessionId: string) =>
        deps.getParallelService().listWorkerResults(sessionId),
      getOpenToolCalls: (sessionId: string) =>
        deps.sessionLifecycleService.getOpenToolCalls(sessionId),
      getUncleanShutdownDiagnostic: (sessionId: string) =>
        deps.sessionLifecycleService.getUncleanShutdownDiagnostic(sessionId),
      mergeWorkerResults: (sessionId: string) =>
        deps.getParallelService().mergeWorkerResults(sessionId),
      applyMergedWorkerResults: (sessionId: string, input) =>
        deps.getParallelService().applyMergedWorkerResults(sessionId, input),
      clearWorkerResults: (sessionId: string) =>
        deps.getParallelService().clearWorkerResults(sessionId),
      pollStall: (
        sessionId: string,
        input?: {
          now?: number;
          thresholdMs?: number;
        },
      ) =>
        deps.taskWatchdogService.pollTaskProgress({
          sessionId,
          now: input?.now,
          thresholdMs: input?.thresholdMs,
        }),
      clearState: (sessionId: string) => deps.sessionLifecycleService.clearSessionState(sessionId),
      onClearState: (listener: (sessionId: string) => void) =>
        deps.sessionLifecycleService.onClearState(listener),
      getHydration: (sessionId: string): SessionHydrationState => {
        deps.sessionLifecycleService.ensureHydrated(sessionId);
        return deps.sessionLifecycleService.getHydrationState(sessionId);
      },
      getIntegrity: (sessionId: string): IntegrityStatus => {
        deps.sessionLifecycleService.ensureHydrated(sessionId);
        return deps.sessionLifecycleService.getIntegrityStatus(sessionId);
      },
      commitCompaction: (sessionId: string, input: SessionCompactionCommitInput) =>
        deps.contextService.markContextCompacted(sessionId, input),
      resolveCredentialBindings: (sessionId: string, toolName: string) => {
        deps.sessionLifecycleService.ensureHydrated(sessionId);
        return deps
          .getCredentialVaultService()
          .resolveToolBindings(toolName, deps.runtimeConfig.security.credentials.bindings);
      },
      resolveSandboxApiKey: (sessionId: string) => {
        deps.sessionLifecycleService.ensureHydrated(sessionId);
        return deps
          .getCredentialVaultService()
          .resolveConfiguredSecret(deps.runtimeConfig.security.credentials.sandboxApiKeyRef);
      },
    },
    sessionWire: {
      query: (sessionId: string) => deps.getSessionWireService().query(sessionId),
      subscribe: (sessionId: string, listener) =>
        deps.getSessionWireService().subscribe(sessionId, listener),
    },
  };
}
