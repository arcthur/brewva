import { resolve } from "node:path";
import { resolveWorkspaceRootDir } from "../config/paths.js";
import type { BrewvaConfig } from "../config/types.js";
import type { DeepReadonly } from "../core/index.js";
import type { VerificationLevel } from "../core/shared.js";
import type { ClaimState } from "../domain/claim/api.js";
import {
  resolveHistoryViewBaselineView,
  resolveRecoveryWorkingSetView,
} from "../domain/context/api.js";
import { normalizeAgentId } from "../domain/context/api.js";
import { HISTORY_VIEW_BASELINE_RESERVED_BUDGET_RATIO } from "../domain/context/api.js";
import type {
  HistoryViewBaselineSnapshot,
  RecoveryPostureSnapshot,
  RecoveryWorkingSetSnapshot,
} from "../domain/context/api.js";
import { SessionCostTracker } from "../domain/cost/api.js";
import type { SessionCostSummary } from "../domain/cost/api.js";
import { RuntimeIterationFactController } from "../domain/events/api.js";
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
import { VERIFICATION_OUTCOME_RECORDED_EVENT_TYPE } from "../domain/verification/api.js";
import type { VerificationReport } from "../domain/verification/api.js";
import { readVerificationOutcomeRecordedEventPayload } from "../events/descriptors.js";
import type { BrewvaEventRecord } from "../events/types.js";
import { sanitizeContextText } from "../security/sanitize.js";
import {
  collectRuntimeComposition,
  createRuntimeEffectLayer,
  createRuntimeEffectSpine,
} from "./effect-runtime-layer.js";
import type {
  BrewvaAuthorityPort,
  BrewvaHostedRuntimePort,
  BrewvaInspectionPort,
  BrewvaRuntimeOptions,
  RuntimeOperatorPort,
} from "./runtime-api.js";
import type {
  RuntimeCoreDependencies,
  RuntimeLazyServiceFactories,
  RuntimeServiceDependencies,
} from "./runtime-composition.js";
import { resolveRuntimeConfigState } from "./runtime-config-state.js";
import { createRuntimeExtensions } from "./runtime-extension-factory.js";
import {
  listRuntimeExtensionOwnerIds,
  type BrewvaRuntimeExtensions,
} from "./runtime-extensions.js";
import type { RuntimeKernelContext } from "./runtime-kernel.js";
import { createRuntimeSemanticSurfaces } from "./runtime-surfaces.js";

type RuntimeCoreDependencyMap = RuntimeCoreDependencies;
type RuntimeServiceDependencyMap = RuntimeServiceDependencies;
type RuntimeLazyFactories = RuntimeLazyServiceFactories;

class RuntimeFacadeStateController implements BrewvaHostedRuntimePort {
  declare readonly identity: BrewvaHostedRuntimePort["identity"];
  declare readonly config: DeepReadonly<BrewvaConfig>;
  declare readonly authority: BrewvaAuthorityPort;
  declare readonly inspect: BrewvaInspectionPort;
  declare readonly operator: RuntimeOperatorPort;
  declare readonly extensions: BrewvaRuntimeExtensions;

  declare private readonly evidenceLedger: RuntimeCoreDependencyMap["evidenceLedger"];
  declare private readonly parallel: RuntimeCoreDependencyMap["parallel"];
  declare private readonly parallelResults: RuntimeCoreDependencyMap["parallelResults"];
  declare private readonly contextBudget: RuntimeCoreDependencyMap["contextBudget"];
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
  private readonly effectRuntimeSpine: ReturnType<typeof createRuntimeEffectSpine>;
  private readonly effectRuntimeLayer: ReturnType<typeof createRuntimeEffectLayer>;
  private readonly clearEffectCommitmentDeskState: (sessionId: string) => void;
  declare private readonly contextService: RuntimeServiceDependencyMap["contextService"];
  declare private readonly workbenchService: RuntimeServiceDependencyMap["workbenchService"];
  declare private readonly costService: RuntimeServiceDependencyMap["costService"];
  declare private readonly eventPipeline: RuntimeServiceDependencyMap["eventPipeline"];
  declare private readonly ledgerService: RuntimeServiceDependencyMap["ledgerService"];
  declare private readonly taskWatchdogService: RuntimeServiceDependencyMap["taskWatchdogService"];
  declare private readonly sessionLifecycleService: RuntimeServiceDependencyMap["sessionLifecycleService"];
  declare private readonly sessionLineageService: RuntimeServiceDependencyMap["sessionLineageService"];
  declare private readonly taskService: RuntimeServiceDependencyMap["taskService"];
  declare private readonly claimService: RuntimeServiceDependencyMap["claimService"];
  declare private readonly toolLifecycleRecoveryWalService: RuntimeServiceDependencyMap["toolLifecycleRecoveryWalService"];
  private readonly tapeServiceGetter: RuntimeServiceDependencyMap["getTapeService"];
  private readonly effectCommitmentDeskServiceGetter: RuntimeServiceDependencyMap["getEffectCommitmentDeskService"];
  private readonly proposalAdmissionServiceGetter: RuntimeServiceDependencyMap["getProposalAdmissionService"];
  private readonly conventionAdmissionServiceGetter: RuntimeServiceDependencyMap["getConventionAdmissionService"];
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
    this.identity = { cwd, workspaceRoot, agentId };

    const configState = resolveRuntimeConfigState({
      cwd: this.identity.cwd,
      options,
    });
    this.runtimeConfig = configState.config;
    this.config = configState.readonlyConfig;

    this.effectRuntimeSpine = createRuntimeEffectSpine({
      identity: {
        cwd: this.identity.cwd,
        workspaceRoot: this.identity.workspaceRoot,
        agentId: this.identity.agentId,
      },
      config: {
        mutableConfig: this.runtimeConfig,
        readonlyConfig: this.config,
      },
      hooks: {
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
        getClaimState: (sessionId) => this.getClaimState(sessionId),
        recordEvent: (input) => this.recordEvent(input),
        sanitizeInput: (text) => this.sanitizeInput(text),
        getLatestVerificationOutcome: (sessionId) => this.getLatestVerificationOutcome(sessionId),
        isContextBudgetEnabled: () => this.isContextBudgetEnabled(),
        resolveCheckpointCostSummary: (sessionId) => this.resolveCheckpointCostSummary(sessionId),
        resolveCheckpointCostSkillLastTurnByName: (sessionId) =>
          this.resolveCheckpointCostSkillLastTurnByName(sessionId),
        evaluateCompletion: (sessionId, level) => this.evaluateCompletion(sessionId, level),
        getSessionLifecycleSnapshot: (sessionId) => this.getSessionLifecycleSnapshot(sessionId),
      },
    });
    this.effectRuntimeLayer = this.effectRuntimeSpine.layer;
    const { coreDependencies, kernel, serviceDependencies, lazyServiceFactories } =
      this.effectRuntimeSpine.runSync(collectRuntimeComposition());
    this.skillRegistry = coreDependencies.skillRegistry;
    this.evidenceLedger = coreDependencies.evidenceLedger;
    this.verificationGate = coreDependencies.verificationGate;
    this.parallel = coreDependencies.parallel;
    this.parallelResults = coreDependencies.parallelResults;
    this.eventStore = coreDependencies.eventStore;
    this.recoveryWalStore = coreDependencies.recoveryWalStore;
    this.contextBudget = coreDependencies.contextBudget;
    this.turnReplay = coreDependencies.turnReplay;
    this.reasoningReplay = coreDependencies.reasoningReplay;
    this.fileChanges = coreDependencies.fileChanges;
    this.costTracker = coreDependencies.costTracker;
    this.projectionEngine = coreDependencies.projectionEngine;
    this.kernel = kernel;
    this.taskService = serviceDependencies.taskService;
    this.claimService = serviceDependencies.claimService;
    this.ledgerService = serviceDependencies.ledgerService;
    this.costService = serviceDependencies.costService;
    this.contextService = serviceDependencies.contextService;
    this.workbenchService = serviceDependencies.workbenchService;
    this.taskWatchdogService = serviceDependencies.taskWatchdogService;
    this.sessionLineageService = serviceDependencies.sessionLineageService;
    this.eventPipeline = serviceDependencies.eventPipeline;
    this.toolLifecycleRecoveryWalService = serviceDependencies.toolLifecycleRecoveryWalService;
    this.sessionLifecycleService = serviceDependencies.sessionLifecycleService;
    this.tapeServiceGetter = () => serviceDependencies.getTapeService();
    this.effectCommitmentDeskServiceGetter = () =>
      serviceDependencies.getEffectCommitmentDeskService();
    this.proposalAdmissionServiceGetter = () => serviceDependencies.getProposalAdmissionService();
    this.conventionAdmissionServiceGetter = () =>
      serviceDependencies.getConventionAdmissionService();
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
      getProposalAdmissionService: () => this.getProposalAdmissionService(),
      getEffectCommitmentDeskService: () => this.getEffectCommitmentDeskService(),
      getConventionAdmissionService: () => this.getConventionAdmissionService(),
      getContextService: () => this.contextService,
      getWorkbenchService: () => this.workbenchService,
      getSessionLifecycleService: () => this.sessionLifecycleService,
      getSessionLineageService: () => this.sessionLineageService,
      getTaskWatchdogService: () => this.taskWatchdogService,
      getTaskService: () => this.taskService,
      getClaimService: () => this.claimService,
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
      getClaimState: (sessionId) => this.getClaimState(sessionId),
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
          workspaceRoot: this.identity.workspaceRoot,
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
    this.operator = surfaces.operator;
    this.extensions = createRuntimeExtensions({
      recordEvent: (input) => this.recordEvent(input),
      eventStore: this.eventStore,
      recoveryWalStore: this.recoveryWalStore,
      operator: this.operator,
    });
    this.sessionLineageService.registerRuntimeCapabilityStateOwners(listRuntimeExtensionOwnerIds());
  }

  getEffectRuntimeLayer(): ReturnType<typeof createRuntimeEffectLayer> {
    return this.effectRuntimeLayer;
  }

  getEffectRuntimeSpine(): ReturnType<typeof createRuntimeEffectSpine> {
    return this.effectRuntimeSpine;
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

  private getConventionAdmissionService(): ReturnType<
    RuntimeServiceDependencyMap["getConventionAdmissionService"]
  > {
    return this.conventionAdmissionServiceGetter();
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
      cwd: this.identity.cwd,
      workspaceRoot: this.identity.workspaceRoot,
      spec: this.getTaskState(sessionId).spec,
    });
  }

  private getClaimState(sessionId: string): ClaimState {
    return this.turnReplay.getClaimState(sessionId);
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
          reason: input.reason?.trim() || "runtime.operator.skills.refresh",
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

export type RuntimeFacadeControllerHandle = RuntimeFacadeStateController;

export function createRuntimeFacadeController(
  options: BrewvaRuntimeOptions = {},
): RuntimeFacadeControllerHandle {
  return new RuntimeFacadeStateController(options);
}

export function getRuntimeEffectLayer(
  state: RuntimeFacadeControllerHandle,
): ReturnType<typeof createRuntimeEffectLayer> {
  return state.getEffectRuntimeLayer();
}

export function getRuntimeEffectSpine(
  state: RuntimeFacadeControllerHandle,
): ReturnType<typeof createRuntimeEffectSpine> {
  return state.getEffectRuntimeSpine();
}
