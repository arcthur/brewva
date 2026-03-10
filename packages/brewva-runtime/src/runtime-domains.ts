import { TurnWALRecovery } from "./channels/turn-wal-recovery.js";
import { TurnWALStore } from "./channels/turn-wal.js";
import type { BrewvaRuntime } from "./runtime.js";
import { ContextService } from "./services/context.js";
import { CostService } from "./services/cost.js";
import { EventPipelineService } from "./services/event-pipeline.js";
import { FileChangeService } from "./services/file-change.js";
import { LedgerService } from "./services/ledger.js";
import { ParallelService } from "./services/parallel.js";
import { ProposalAdmissionService } from "./services/proposal-admission.js";
import { ScanConvergenceService } from "./services/scan-convergence.js";
import { ScheduleIntentService } from "./services/schedule-intent.js";
import { SessionLifecycleService } from "./services/session-lifecycle.js";
import { SkillCascadeService } from "./services/skill-cascade.js";
import { SkillLifecycleService } from "./services/skill-lifecycle.js";
import { TapeService } from "./services/tape.js";
import { TaskService } from "./services/task.js";
import { ToolGateService } from "./services/tool-gate.js";
import { TruthService } from "./services/truth.js";
import { VerificationService } from "./services/verification.js";
import { SkillRegistry } from "./skills/registry.js";
import type {
  BrewvaConfig,
  BrewvaEventQuery,
  BrewvaEventRecord,
  TaskState,
  TruthState,
} from "./types.js";
import { VerificationGate } from "./verification/gate.js";

export type RuntimeDomainApis = Pick<
  BrewvaRuntime,
  | "skills"
  | "proposals"
  | "context"
  | "tools"
  | "task"
  | "truth"
  | "ledger"
  | "schedule"
  | "turnWal"
  | "events"
  | "verification"
  | "cost"
  | "session"
>;

export interface RuntimeDomainApiDependencies {
  workspaceRoot: string;
  config: BrewvaConfig;
  skillRegistry: SkillRegistry;
  verificationGate: VerificationGate;
  turnWalStore: TurnWALStore;
  eventStore: {
    list(sessionId: string, query?: BrewvaEventQuery): BrewvaEventRecord[];
    listSessionIds(): string[];
  };
  proposalAdmissionService: ProposalAdmissionService;
  skillLifecycleService: SkillLifecycleService;
  skillCascadeService: SkillCascadeService;
  taskService: TaskService;
  truthService: TruthService;
  ledgerService: LedgerService;
  parallelService: ParallelService;
  costService: CostService;
  verificationService: VerificationService;
  contextService: ContextService;
  scanConvergenceService: ScanConvergenceService;
  tapeService: TapeService;
  eventPipeline: EventPipelineService;
  scheduleIntentService: ScheduleIntentService;
  fileChangeService: FileChangeService;
  sessionLifecycleService: SessionLifecycleService;
  toolGateService: ToolGateService;
  getTaskState(sessionId: string): TaskState;
  getTruthState(sessionId: string): TruthState;
  sanitizeInput(text: string): string;
}

export function createRuntimeDomainApis(deps: RuntimeDomainApiDependencies): RuntimeDomainApis {
  return {
    skills: {
      refresh: () => {
        deps.skillRegistry.load();
        deps.skillRegistry.writeIndex();
      },
      getLoadReport: () => deps.skillRegistry.getLoadReport(),
      list: () => deps.skillRegistry.list(),
      get: (name) => deps.skillRegistry.get(name),
      getPendingDispatch: (sessionId) => deps.skillLifecycleService.getPendingDispatch(sessionId),
      clearPendingDispatch: (sessionId) =>
        deps.skillLifecycleService.clearPendingDispatch(sessionId),
      overridePendingDispatch: (sessionId, input) =>
        deps.skillLifecycleService.overridePendingDispatch(sessionId, input),
      reconcilePendingDispatch: (sessionId, turn) =>
        deps.skillLifecycleService.reconcilePendingDispatchOnTurnEnd(sessionId, turn),
      activate: (sessionId, name) => deps.skillLifecycleService.activateSkill(sessionId, name),
      getActive: (sessionId) => deps.skillLifecycleService.getActiveSkill(sessionId),
      validateOutputs: (sessionId, outputs) =>
        deps.skillLifecycleService.validateSkillOutputs(sessionId, outputs),
      complete: (sessionId, output) => deps.skillLifecycleService.completeSkill(sessionId, output),
      getOutputs: (sessionId, skillName) =>
        deps.skillLifecycleService.getSkillOutputs(sessionId, skillName),
      getConsumedOutputs: (sessionId, targetSkillName) =>
        deps.skillLifecycleService.getAvailableConsumedOutputs(sessionId, targetSkillName),
      getCascadeIntent: (sessionId) => deps.skillCascadeService.getIntent(sessionId),
      pauseCascade: (sessionId, reason) => deps.skillCascadeService.pauseIntent(sessionId, reason),
      resumeCascade: (sessionId, reason) =>
        deps.skillCascadeService.resumeIntent(sessionId, reason),
      cancelCascade: (sessionId, reason) =>
        deps.skillCascadeService.cancelIntent(sessionId, reason),
      startCascade: (sessionId, input) =>
        deps.skillCascadeService.createExplicitIntent(sessionId, input),
    },
    proposals: {
      submit: (sessionId, proposal) =>
        deps.proposalAdmissionService.submitProposal(sessionId, proposal),
      list: (sessionId, query) =>
        deps.proposalAdmissionService.listProposalRecords(sessionId, query),
    },
    context: {
      onTurnStart: (sessionId, turnIndex) =>
        deps.sessionLifecycleService.onTurnStart(sessionId, turnIndex),
      onTurnEnd: (sessionId) => deps.scanConvergenceService.onTurnEnd(sessionId),
      onUserInput: (sessionId) => deps.scanConvergenceService.onUserInput(sessionId),
      sanitizeInput: (text) => deps.sanitizeInput(text),
      observeUsage: (sessionId, usage) => deps.contextService.observeContextUsage(sessionId, usage),
      getUsage: (sessionId) => deps.contextService.getContextUsage(sessionId),
      getUsageRatio: (usage) => deps.contextService.getContextUsageRatio(usage),
      getHardLimitRatio: () => deps.contextService.getContextHardLimitRatio(),
      getCompactionThresholdRatio: () => deps.contextService.getContextCompactionThresholdRatio(),
      getPressureStatus: (sessionId, usage) =>
        deps.contextService.getContextPressureStatus(sessionId, usage),
      getPressureLevel: (sessionId, usage) =>
        deps.contextService.getContextPressureLevel(sessionId, usage),
      getCompactionGateStatus: (sessionId, usage) =>
        deps.contextService.getContextCompactionGateStatus(sessionId, usage),
      checkCompactionGate: (sessionId, toolName, usage) =>
        deps.contextService.checkContextCompactionGate(sessionId, toolName, usage),
      buildInjection: (sessionId, prompt, usage, injectionScopeId) =>
        deps.contextService.buildContextInjection(sessionId, prompt, usage, injectionScopeId),
      appendSupplementalInjection: (sessionId, inputText, usage, injectionScopeId) =>
        deps.contextService.appendSupplementalContextInjection(
          sessionId,
          inputText,
          usage,
          injectionScopeId,
        ),
      checkAndRequestCompaction: (sessionId, usage) =>
        deps.contextService.checkAndRequestCompaction(sessionId, usage),
      requestCompaction: (sessionId, reason) =>
        deps.contextService.requestCompaction(sessionId, reason),
      getPendingCompactionReason: (sessionId) =>
        deps.contextService.getPendingCompactionReason(sessionId),
      getCompactionInstructions: () => deps.contextService.getCompactionInstructions(),
      getCompactionWindowTurns: () => deps.contextService.getRecentCompactionWindowTurns(),
      markCompacted: (sessionId, input) =>
        deps.contextService.markContextCompacted(sessionId, input),
    },
    tools: {
      checkAccess: (sessionId, toolName) =>
        deps.toolGateService.checkToolAccess(sessionId, toolName),
      explainAccess: (input) => {
        const access = deps.toolGateService.explainToolAccess(input.sessionId, input.toolName);
        if (!access.allowed) {
          return {
            allowed: false,
            reason: access.reason,
            warning: access.warning,
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
          };
        }

        const dispatchGate = deps.toolGateService.explainSkillDispatchGate(
          input.sessionId,
          input.toolName,
        );
        if (!dispatchGate.allowed) {
          return {
            allowed: false,
            reason: dispatchGate.reason,
            warning: dispatchGate.warning,
          };
        }

        const warnings = [access.warning, dispatchGate.warning].filter(
          (value): value is string => typeof value === "string" && value.trim().length > 0,
        );
        return warnings.length > 0
          ? { allowed: true, warning: warnings.join("; ") }
          : { allowed: true };
      },
      start: (input) => deps.toolGateService.startToolCall(input),
      finish: (input) => {
        deps.toolGateService.finishToolCall(input);
      },
      acquireParallelSlot: (sessionId, runId) =>
        deps.parallelService.acquireParallelSlot(sessionId, runId),
      releaseParallelSlot: (sessionId, runId) =>
        deps.parallelService.releaseParallelSlot(sessionId, runId),
      markCall: (sessionId, toolName) => deps.fileChangeService.markToolCall(sessionId, toolName),
      trackCallStart: (input) => deps.fileChangeService.trackToolCallStart(input),
      trackCallEnd: (input) => deps.fileChangeService.trackToolCallEnd(input),
      rollbackLastPatchSet: (sessionId) => deps.fileChangeService.rollbackLastPatchSet(sessionId),
      resolveUndoSessionId: (preferredSessionId) =>
        deps.fileChangeService.resolveUndoSessionId(preferredSessionId),
      recordResult: (input) => deps.ledgerService.recordToolResult(input),
    },
    task: {
      setSpec: (sessionId, spec) => deps.taskService.setTaskSpec(sessionId, spec),
      addItem: (sessionId, input) => deps.taskService.addTaskItem(sessionId, input),
      updateItem: (sessionId, input) => deps.taskService.updateTaskItem(sessionId, input),
      recordBlocker: (sessionId, input) => deps.taskService.recordTaskBlocker(sessionId, input),
      resolveBlocker: (sessionId, blockerId) =>
        deps.taskService.resolveTaskBlocker(sessionId, blockerId),
      getState: (sessionId) => deps.getTaskState(sessionId),
    },
    truth: {
      getState: (sessionId) => deps.getTruthState(sessionId),
      upsertFact: (sessionId, input) => deps.truthService.upsertTruthFact(sessionId, input),
      resolveFact: (sessionId, truthFactId) =>
        deps.truthService.resolveTruthFact(sessionId, truthFactId),
    },
    ledger: {
      getDigest: (sessionId) => deps.ledgerService.getLedgerDigest(sessionId),
      query: (sessionId, query) => deps.ledgerService.queryLedger(sessionId, query),
      listRows: (sessionId) => deps.ledgerService.listLedgerRows(sessionId),
      verifyChain: (sessionId) => deps.ledgerService.verifyLedgerChain(sessionId),
      getPath: () => deps.ledgerService.getLedgerPath(),
    },
    schedule: {
      createIntent: (sessionId, input) =>
        deps.scheduleIntentService.createScheduleIntent(sessionId, input),
      cancelIntent: (sessionId, input) =>
        deps.scheduleIntentService.cancelScheduleIntent(sessionId, input),
      updateIntent: (sessionId, input) =>
        deps.scheduleIntentService.updateScheduleIntent(sessionId, input),
      listIntents: (query) => deps.scheduleIntentService.listScheduleIntents(query),
      getProjectionSnapshot: () => deps.scheduleIntentService.getScheduleProjectionSnapshot(),
    },
    turnWal: {
      appendPending: (envelope, source, options) =>
        deps.turnWalStore.appendPending(envelope, source, options),
      markInflight: (walId) => deps.turnWalStore.markInflight(walId),
      markDone: (walId) => deps.turnWalStore.markDone(walId),
      markFailed: (walId, error) => deps.turnWalStore.markFailed(walId, error),
      markExpired: (walId) => deps.turnWalStore.markExpired(walId),
      listPending: () => deps.turnWalStore.listPending(),
      recover: async () => {
        const recovery = new TurnWALRecovery({
          workspaceRoot: deps.workspaceRoot,
          config: deps.config.infrastructure.turnWal,
          recordEvent: (input) => {
            deps.eventPipeline.recordEvent({
              sessionId: input.sessionId,
              type: input.type,
              payload: input.payload,
              skipTapeCheckpoint: true,
            });
          },
        });
        return await recovery.recover();
      },
      compact: () => deps.turnWalStore.compact(),
    },
    events: {
      record: (input) => deps.eventPipeline.recordEvent(input),
      query: (sessionId, query) => deps.eventPipeline.queryEvents(sessionId, query),
      queryStructured: (sessionId, query) =>
        deps.eventPipeline.queryStructuredEvents(sessionId, query),
      getTapeStatus: (sessionId) => deps.tapeService.getTapeStatus(sessionId),
      getTapePressureThresholds: () => deps.tapeService.getPressureThresholds(),
      recordTapeHandoff: (sessionId, input) => deps.tapeService.recordTapeHandoff(sessionId, input),
      searchTape: (sessionId, input) => deps.tapeService.searchTape(sessionId, input),
      listReplaySessions: (limit) => deps.eventPipeline.listReplaySessions(limit),
      subscribe: (listener) => deps.eventPipeline.subscribeEvents(listener),
      toStructured: (event) => deps.eventPipeline.toStructuredEvent(event),
      list: (sessionId, query) => deps.eventStore.list(sessionId, query),
      listSessionIds: () => deps.eventStore.listSessionIds(),
    },
    verification: {
      evaluate: (sessionId, level) => deps.verificationGate.evaluate(sessionId, level),
      verify: (sessionId, level, options) =>
        deps.verificationService.verifyCompletion(sessionId, level, options ?? {}),
    },
    cost: {
      recordAssistantUsage: (input) => deps.costService.recordAssistantUsage(input),
      getSummary: (sessionId) => deps.costService.getCostSummary(sessionId),
    },
    session: {
      recordWorkerResult: (sessionId, result) =>
        deps.parallelService.recordWorkerResult(sessionId, result),
      listWorkerResults: (sessionId) => deps.parallelService.listWorkerResults(sessionId),
      mergeWorkerResults: (sessionId) => deps.parallelService.mergeWorkerResults(sessionId),
      clearWorkerResults: (sessionId) => deps.parallelService.clearWorkerResults(sessionId),
      clearState: (sessionId) => deps.sessionLifecycleService.clearSessionState(sessionId),
      onClearState: (listener) => deps.sessionLifecycleService.onClearState(listener),
    },
  };
}
