import { resolve } from "node:path";
import { resolveWorkspaceRootDir } from "../config/paths.js";
import type { BrewvaConfig } from "../config/types.js";
import type { DeepReadonly } from "../core/index.js";
import type { VerificationLevel } from "../core/shared.js";
import {
  resolveHistoryViewBaselineView,
  resolveRecoveryWorkingSetView,
} from "../domain/context/api.js";
import { normalizeAgentId } from "../domain/context/api.js";
import { HISTORY_VIEW_BASELINE_RESERVED_BUDGET_RATIO } from "../domain/context/api.js";
import type { ToolOutputDistillationEntry } from "../domain/context/api.js";
import type {
  HistoryViewBaselineSnapshot,
  RecoveryPostureSnapshot,
  RecoveryWorkingSetSnapshot,
} from "../domain/context/api.js";
import { SessionCostTracker } from "../domain/cost/api.js";
import type { SessionCostSummary } from "../domain/cost/api.js";
import { createActionPolicyRegistry } from "../domain/governance/api.js";
import { resolveToolAuthority } from "../domain/governance/api.js";
import { buildSessionLifecycleSnapshot } from "../domain/lifecycle/api.js";
import { EFFECT_COMMITMENT_APPROVAL_CACHE_INVALIDATION_EVENT_TYPES } from "../domain/proposals/api.js";
import { recoverRecoveryWal } from "../domain/recovery/api.js";
import type { RuntimeRecordEventInput } from "../domain/sessions/api.js";
import type { SessionLifecycleSnapshot } from "../domain/sessions/api.js";
import { RuntimeSessionStateStore } from "../domain/sessions/api.js";
import { SKILL_REFRESH_RECORDED_EVENT_TYPE } from "../domain/skills/api.js";
import { ensureBundledSystemSkills } from "../domain/skills/api.js";
import type { SkillRefreshInput, SkillRefreshResult } from "../domain/skills/api.js";
import { resolveTaskTargetDescriptor } from "../domain/task/api.js";
import type { TaskTargetDescriptor, TaskState } from "../domain/task/api.js";
import { TOOL_OUTPUT_DISTILLED_EVENT_TYPE } from "../domain/tools/api.js";
import type { TruthState } from "../domain/truth/api.js";
import { VERIFICATION_OUTCOME_RECORDED_EVENT_TYPE } from "../domain/verification/api.js";
import type { VerificationReport } from "../domain/verification/api.js";
import {
  readToolOutputDistilledEventPayload,
  readVerificationOutcomeRecordedEventPayload,
} from "../events/descriptors.js";
import type { BrewvaEventRecord } from "../events/types.js";
import { sanitizeContextText } from "../security/sanitize.js";
import type {
  BrewvaAuthorityPort,
  BrewvaHostedRuntimePort,
  BrewvaInspectionPort,
  BrewvaMaintenancePort,
  BrewvaRuntimeOptions,
} from "./runtime-api.js";
import {
  composeRuntimeDependencies,
  type RuntimeCoreDependencies,
  type RuntimeLazyServiceFactories,
  type RuntimeServiceDependencies,
} from "./runtime-composition.js";
import { resolveRuntimeConfigState } from "./runtime-config-state.js";
import { createRuntimeExtensions } from "./runtime-extension-factory.js";
import type { BrewvaRuntimeExtensions } from "./runtime-extensions.js";
import { RuntimeIterationFactController } from "./runtime-iteration-facts.js";
import type { RuntimeKernelContext } from "./runtime-kernel.js";
import { createRuntimeSemanticSurfaces } from "./runtime-surfaces.js";

export const BREWVA_RUNTIME_INTERNAL_STATE_SYMBOL = Symbol.for("brewva.runtime.internal-state");

type RuntimeCoreDependencyMap = RuntimeCoreDependencies;
type RuntimeServiceDependencyMap = RuntimeServiceDependencies;
type RuntimeLazyFactories = RuntimeLazyServiceFactories;

class RuntimeFacadeStateController implements BrewvaHostedRuntimePort {
  declare readonly cwd: string;
  declare readonly workspaceRoot: string;
  declare readonly agentId: string;
  declare readonly config: DeepReadonly<BrewvaConfig>;
  declare readonly authority: BrewvaAuthorityPort;
  declare readonly inspect: BrewvaInspectionPort;
  declare readonly maintain: BrewvaMaintenancePort;
  declare readonly extensions: BrewvaRuntimeExtensions;

  declare private readonly evidenceLedger: RuntimeCoreDependencyMap["evidenceLedger"];
  declare private readonly parallel: RuntimeCoreDependencyMap["parallel"];
  declare private readonly parallelResults: RuntimeCoreDependencyMap["parallelResults"];
  declare private readonly contextBudget: RuntimeCoreDependencyMap["contextBudget"];
  declare private readonly contextInjection: RuntimeCoreDependencyMap["contextInjection"];
  declare private readonly fileChanges: RuntimeCoreDependencyMap["fileChanges"];
  declare private readonly costTracker: SessionCostTracker;

  declare private readonly skillRegistry: RuntimeCoreDependencyMap["skillRegistry"];
  declare private readonly verificationGate: RuntimeCoreDependencyMap["verificationGate"];
  declare private readonly eventStore: RuntimeCoreDependencyMap["eventStore"];
  declare private readonly recoveryWalStore: RuntimeCoreDependencyMap["recoveryWalStore"];
  declare private readonly projectionEngine: RuntimeCoreDependencyMap["projectionEngine"];
  private readonly iterationFacts: RuntimeIterationFactController;

  private readonly sessionState = new RuntimeSessionStateStore();
  private readonly sessionLifecycleSnapshotCache = new Map<string, SessionLifecycleSnapshot>();
  private readonly kernel: RuntimeKernelContext;
  private readonly lazyServiceFactories: RuntimeLazyServiceFactories;
  private readonly clearEffectCommitmentDeskState: (sessionId: string) => void;
  declare private readonly contextService: RuntimeServiceDependencyMap["contextService"];
  declare private readonly costService: RuntimeServiceDependencyMap["costService"];
  declare private readonly eventPipeline: RuntimeServiceDependencyMap["eventPipeline"];
  declare private readonly ledgerService: RuntimeServiceDependencyMap["ledgerService"];
  declare private readonly taskWatchdogService: RuntimeServiceDependencyMap["taskWatchdogService"];
  declare private readonly sessionLifecycleService: RuntimeServiceDependencyMap["sessionLifecycleService"];
  declare private readonly skillLifecycleService: RuntimeServiceDependencyMap["skillLifecycleService"];
  declare private readonly taskService: RuntimeServiceDependencyMap["taskService"];
  declare private readonly truthService: RuntimeServiceDependencyMap["truthService"];
  declare private readonly toolLifecycleRecoveryWalService: RuntimeServiceDependencyMap["toolLifecycleRecoveryWalService"];
  private readonly tapeServiceGetter: RuntimeServiceDependencyMap["getTapeService"];
  private readonly effectCommitmentDeskServiceGetter: RuntimeServiceDependencyMap["getEffectCommitmentDeskService"];
  private readonly proposalAdmissionServiceGetter: RuntimeServiceDependencyMap["getProposalAdmissionService"];
  private verificationService:
    | ReturnType<RuntimeLazyFactories["createVerificationService"]>
    | undefined;
  private fileChangeService:
    | ReturnType<RuntimeLazyFactories["createFileChangeService"]>
    | undefined;
  private sessionRewindService:
    | ReturnType<RuntimeLazyFactories["createSessionRewindService"]>
    | undefined;
  private mutationRollbackService:
    | ReturnType<RuntimeLazyFactories["createMutationRollbackService"]>
    | undefined;
  private parallelService: ReturnType<RuntimeLazyFactories["createParallelService"]> | undefined;
  private resourceLeaseService:
    | ReturnType<RuntimeLazyFactories["createResourceLeaseService"]>
    | undefined;
  private toolGateService: ReturnType<RuntimeLazyFactories["createToolGateService"]> | undefined;
  private toolInvocationSpine:
    | ReturnType<RuntimeLazyFactories["createToolInvocationSpine"]>
    | undefined;
  private credentialVaultService:
    | ReturnType<RuntimeLazyFactories["createCredentialVaultService"]>
    | undefined;
  private scheduleIntentService:
    | ReturnType<RuntimeLazyFactories["createScheduleIntentService"]>
    | undefined;
  private sessionWireService:
    | ReturnType<RuntimeLazyFactories["createSessionWireService"]>
    | undefined;
  private reasoningService: ReturnType<RuntimeLazyFactories["createReasoningService"]> | undefined;
  declare private readonly runtimeConfig: BrewvaConfig;
  private readonly actionPolicyRegistry = createActionPolicyRegistry();
  declare private turnReplay: RuntimeCoreDependencyMap["turnReplay"];
  declare private reasoningReplay: RuntimeCoreDependencyMap["reasoningReplay"];

  constructor(options: BrewvaRuntimeOptions = {}) {
    const cwd = resolve(options.cwd ?? process.cwd());
    const workspaceRoot = resolveWorkspaceRootDir(cwd);
    const agentId = normalizeAgentId(options.agentId ?? process.env["BREWVA_AGENT_ID"]);
    this.cwd = cwd;
    this.workspaceRoot = workspaceRoot;
    this.agentId = agentId;

    const configState = resolveRuntimeConfigState({
      cwd: this.cwd,
      options,
    });
    this.runtimeConfig = configState.config;
    this.config = configState.readonlyConfig;

    const composition = composeRuntimeDependencies({
      cwd: this.cwd,
      workspaceRoot: this.workspaceRoot,
      agentId: this.agentId,
      config: this.runtimeConfig,
      governancePort: options.governancePort,
      sessionState: this.sessionState,
      resolveToolAuthority: (toolName, args) =>
        resolveToolAuthority(
          toolName,
          this.actionPolicyRegistry,
          args,
          this.runtimeConfig.security.actionAdmissionOverrides,
        ),
      getCurrentTurn: (sessionId) => this.getCurrentTurn(sessionId),
      getTaskState: (sessionId) => this.getTaskState(sessionId),
      getTruthState: (sessionId) => this.getTruthState(sessionId),
      recordEvent: (input) => this.recordEvent(input),
      sanitizeInput: (text) => this.sanitizeInput(text),
      getRecentToolOutputDistillations: (sessionId, maxEntries) =>
        this.getRecentToolOutputDistillations(sessionId, maxEntries),
      getLatestVerificationOutcome: (sessionId) => this.getLatestVerificationOutcome(sessionId),
      isContextBudgetEnabled: () => this.isContextBudgetEnabled(),
      resolveCheckpointCostSummary: (sessionId) => this.resolveCheckpointCostSummary(sessionId),
      resolveCheckpointCostSkillLastTurnByName: (sessionId) =>
        this.resolveCheckpointCostSkillLastTurnByName(sessionId),
      evaluateCompletion: (sessionId, level) => this.evaluateCompletion(sessionId, level),
      getSessionLifecycleSnapshot: (sessionId) => this.getSessionLifecycleSnapshot(sessionId),
    });
    const { coreDependencies, kernel, serviceDependencies, lazyServiceFactories } = composition;
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
    this.kernel = kernel;
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
    this.lazyServiceFactories = lazyServiceFactories;
    this.iterationFacts = new RuntimeIterationFactController({
      eventStore: this.eventStore,
      recordEvent: (input) => this.recordEvent(input),
    });

    this.sessionLifecycleService.onClearState((sessionId) => {
      this.invalidateSessionLifecycleSnapshot(sessionId);
    });
    this.refreshSkillsState();
    const surfaces = createRuntimeSemanticSurfaces({
      runtimeConfig: this.runtimeConfig,
      skillRegistry: this.skillRegistry,
      getSkillLifecycleService: () => this.skillLifecycleService,
      getProposalAdmissionService: () => this.getProposalAdmissionService(),
      getEffectCommitmentDeskService: () => this.getEffectCommitmentDeskService(),
      contextInjection: this.contextInjection,
      getContextService: () => this.contextService,
      getSessionLifecycleService: () => this.sessionLifecycleService,
      getTaskWatchdogService: () => this.taskWatchdogService,
      getTaskService: () => this.taskService,
      getTruthService: () => this.truthService,
      getLedgerService: () => this.ledgerService,
      recoveryWalStore: this.recoveryWalStore,
      eventStore: this.eventStore,
      eventPipeline: this.eventPipeline,
      getCostService: () => this.costService,
      actionPolicyRegistry: this.actionPolicyRegistry,
      getReasoningService: () => this.getReasoningService(),
      getSessionRewindService: () => this.getSessionRewindService(),
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
      recordMetricObservation: (sessionId, input) =>
        this.iterationFacts.recordMetricObservation(sessionId, input),
      listMetricObservations: (sessionId, query) =>
        this.iterationFacts.listMetricObservations(sessionId, query),
      recordGuardResult: (sessionId, input) =>
        this.iterationFacts.recordGuardResult(sessionId, input),
      listGuardResults: (sessionId, query) =>
        this.iterationFacts.listGuardResults(sessionId, query),
      evaluateCompletion: (sessionId, level) => this.evaluateCompletion(sessionId, level),
      getSessionLifecycleSnapshot: (sessionId) => this.getSessionLifecycleSnapshot(sessionId),
      invalidateSessionLifecycleSnapshot: (sessionId) =>
        this.invalidateSessionLifecycleSnapshot(sessionId),
      recoverRecoveryWal: async () =>
        recoverRecoveryWal({
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
        }),
    });
    this.authority = surfaces.authority;
    this.inspect = surfaces.inspect;
    this.maintain = surfaces.maintain;
    this.extensions = createRuntimeExtensions({
      recordEvent: (input) => this.recordEvent(input),
      eventStore: this.eventStore,
      recoveryWalStore: this.recoveryWalStore,
      maintain: this.maintain,
    });
  }

  private getCredentialVaultService(): ReturnType<
    RuntimeLazyFactories["createCredentialVaultService"]
  > {
    this.credentialVaultService ??= this.lazyServiceFactories.createCredentialVaultService();
    return this.credentialVaultService;
  }

  private getScheduleIntentService(): ReturnType<
    RuntimeLazyFactories["createScheduleIntentService"]
  > {
    this.scheduleIntentService ??= this.lazyServiceFactories.createScheduleIntentService();
    return this.scheduleIntentService;
  }

  private getSessionWireService(): ReturnType<RuntimeLazyFactories["createSessionWireService"]> {
    this.sessionWireService ??= this.lazyServiceFactories.createSessionWireService();
    return this.sessionWireService;
  }

  private getTapeService(): ReturnType<RuntimeServiceDependencyMap["getTapeService"]> {
    return this.tapeServiceGetter();
  }

  private getEffectCommitmentDeskService(): ReturnType<
    RuntimeServiceDependencyMap["getEffectCommitmentDeskService"]
  > {
    return this.effectCommitmentDeskServiceGetter();
  }

  private getProposalAdmissionService(): ReturnType<
    RuntimeServiceDependencyMap["getProposalAdmissionService"]
  > {
    return this.proposalAdmissionServiceGetter();
  }

  private getVerificationService(): ReturnType<RuntimeLazyFactories["createVerificationService"]> {
    this.verificationService ??= this.lazyServiceFactories.createVerificationService();
    return this.verificationService;
  }

  private getReasoningService(): ReturnType<RuntimeLazyFactories["createReasoningService"]> {
    this.reasoningService ??= this.lazyServiceFactories.createReasoningService();
    return this.reasoningService;
  }

  private getFileChangeService(): ReturnType<RuntimeLazyFactories["createFileChangeService"]> {
    this.fileChangeService ??= this.lazyServiceFactories.createFileChangeService();
    return this.fileChangeService;
  }

  private getSessionRewindService(): ReturnType<
    RuntimeLazyFactories["createSessionRewindService"]
  > {
    this.sessionRewindService ??= this.lazyServiceFactories.createSessionRewindService();
    return this.sessionRewindService;
  }

  private getMutationRollbackService(): ReturnType<
    RuntimeLazyFactories["createMutationRollbackService"]
  > {
    this.mutationRollbackService ??= this.lazyServiceFactories.createMutationRollbackService();
    return this.mutationRollbackService;
  }

  private getParallelService(): ReturnType<RuntimeLazyFactories["createParallelService"]> {
    this.parallelService ??= this.lazyServiceFactories.createParallelService();
    return this.parallelService;
  }

  private getResourceLeaseService(): ReturnType<
    RuntimeLazyFactories["createResourceLeaseService"]
  > {
    this.resourceLeaseService ??= this.lazyServiceFactories.createResourceLeaseService();
    return this.resourceLeaseService;
  }

  private getToolGateService(): ReturnType<RuntimeLazyFactories["createToolGateService"]> {
    this.toolGateService ??= this.lazyServiceFactories.createToolGateService();
    return this.toolGateService;
  }

  private getToolInvocationSpine(): ReturnType<RuntimeLazyFactories["createToolInvocationSpine"]> {
    this.toolInvocationSpine ??= this.lazyServiceFactories.createToolInvocationSpine();
    return this.toolInvocationSpine;
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
    const usage = this.contextService.getContextUsage(sessionId);
    const referenceContextDigest =
      this.sessionState.getPromptStability(sessionId)?.stablePrefixHash;
    const recoveryContext = resolveRecoveryWorkingSetView(this.kernel, {
      sessionId,
      usage,
      referenceContextDigest,
      reservedBudgetRatio: HISTORY_VIEW_BASELINE_RESERVED_BUDGET_RATIO,
    });
    const snapshot = buildSessionLifecycleSnapshot({
      sessionId,
      hydration: this.sessionLifecycleService.getHydrationState(sessionId),
      integrity: this.sessionLifecycleService.getIntegrityStatus(sessionId),
      recovery: {
        ...recoveryContext.posture,
        latestSourceEventId: recoveryContext.transitionState.latestSourceEventId,
        latestSourceEventType: recoveryContext.transitionState.latestSourceEventType,
        recentTransitions: recoveryContext.transitionState.recentTransitions,
      },
      activeSkillState: this.skillLifecycleService.getActiveSkillState(sessionId),
      latestSkillFailure: this.skillLifecycleService.getLatestSkillFailure(sessionId),
      pendingApprovals: this.getEffectCommitmentDeskService().listPending(sessionId),
      openToolCalls: recoveryContext.canonicalization.openToolCalls,
      frames: this.getSessionWireService().query(sessionId),
    });
    this.sessionLifecycleSnapshotCache.set(sessionId, snapshot);
    return structuredClone(snapshot);
  }

  private getTaskTargetDescriptor(sessionId: string): TaskTargetDescriptor {
    this.sessionLifecycleService.ensureHydrated(sessionId);
    return resolveTaskTargetDescriptor({
      cwd: this.cwd,
      workspaceRoot: this.workspaceRoot,
      spec: this.getTaskState(sessionId).spec,
    });
  }

  private getTruthState(sessionId: string): TruthState {
    return this.turnReplay.getTruthState(sessionId);
  }

  private recordEvent<TPayload extends object>(
    input: RuntimeRecordEventInput<TPayload>,
  ): BrewvaEventRecord | undefined {
    const recorded = this.eventPipeline.recordEvent(input);
    if (recorded) {
      if (EFFECT_COMMITMENT_APPROVAL_CACHE_INVALIDATION_EVENT_TYPES.has(recorded.type)) {
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
      const payload = readToolOutputDistilledEventPayload(event);
      if (!payload) continue;
      const turn =
        typeof event.turn === "number" && Number.isFinite(event.turn)
          ? Math.max(0, Math.floor(event.turn))
          : 0;
      const timestamp = Number.isFinite(event.timestamp) ? event.timestamp : Date.now();

      entries.push({
        toolName: payload.toolName,
        strategy: payload.strategy,
        summaryText: payload.summaryText,
        rawTokens: payload.rawTokens,
        summaryTokens: payload.summaryTokens,
        compressionRatio: payload.compressionRatio,
        artifactRef: payload.artifactRef,
        isError: payload.isError,
        verdict: payload.verdict ?? undefined,
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
    if (!event) return undefined;
    const payload = readVerificationOutcomeRecordedEventPayload(event);
    if (!payload) return undefined;

    return {
      timestamp: event.timestamp,
      level: payload.level,
      outcome: payload.outcome,
      failedChecks: payload.failedChecks,
      missingChecks: payload.missingChecks,
      missingEvidence: payload.missingEvidence,
      reason: payload.reason,
      commandsFresh: payload.commandsFresh,
      commandsStale: payload.commandsStale,
    };
  }

  private isContextBudgetEnabled(): boolean {
    return this.runtimeConfig.infrastructure.contextBudget.enabled;
  }
}

export type RuntimeFacadeState = Pick<
  RuntimeFacadeStateController,
  | "cwd"
  | "workspaceRoot"
  | "agentId"
  | "config"
  | "authority"
  | "inspect"
  | "maintain"
  | "extensions"
> & {
  readonly [BREWVA_RUNTIME_INTERNAL_STATE_SYMBOL]: RuntimeFacadeStateController;
};

export function createRuntimeFacadeState(options: BrewvaRuntimeOptions = {}): RuntimeFacadeState {
  const runtime = new RuntimeFacadeStateController(options);
  const facadeState = {
    cwd: runtime.cwd,
    workspaceRoot: runtime.workspaceRoot,
    agentId: runtime.agentId,
    config: runtime.config,
    authority: runtime.authority,
    inspect: runtime.inspect,
    maintain: runtime.maintain,
    extensions: runtime.extensions,
  } as RuntimeFacadeState;
  Object.defineProperty(facadeState, BREWVA_RUNTIME_INTERNAL_STATE_SYMBOL, {
    value: runtime,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return facadeState;
}
