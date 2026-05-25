import type { ToolActionPolicy } from "@brewva/brewva-runtime/security";
import type { BrewvaToolRuntimeCapabilitiesPort } from "@brewva/brewva-tools/contracts";
import type {
  ContextBudgetUsage,
  ContextEntryRecord,
  ContextEvidenceSample,
  ContextStatus,
} from "@brewva/brewva-vocabulary/context";
import type { WorkerMergeReport, WorkerResult } from "@brewva/brewva-vocabulary/delegation";
import type {
  BrewvaEventQuery,
  BrewvaEventRecord,
  BrewvaStructuredEvent,
  ProtocolRecord,
} from "@brewva/brewva-vocabulary/events";
import type {
  ClaimState,
  DecideEffectCommitmentInput,
  DecideEffectCommitmentResult,
  DecisionReceipt,
  EffectCommitmentProposal,
  EffectCommitmentRequestRecord,
  GuardResultInput,
  GuardResultQuery,
  GuardResultRecord,
  MetricObservationInput,
  MetricObservationQuery,
  MetricObservationRecord,
  PendingEffectCommitmentRequest,
  RenderTurnConsequenceDigestOptions,
  ToolInvocationStartInput,
  ToolInvocationStartReceipt,
  TurnEffectCommitmentProjection,
} from "@brewva/brewva-vocabulary/iteration";
import type {
  ScheduleIntentCancelInput,
  ScheduleIntentCancelResult,
  ScheduleIntentCreateInput,
  ScheduleIntentCreateResult,
  ScheduleIntentListQuery,
  ScheduleIntentProjectionRecord,
  ScheduleIntentUpdateInput,
  ScheduleIntentUpdateResult,
  ScheduleProjectionSnapshot,
} from "@brewva/brewva-vocabulary/schedule";
import type {
  BrewvaReplaySession,
  OpenToolCallRecord,
  ProducerContract,
  RecordSessionRewindCheckpointInput,
  SessionLifecycleSnapshot,
  SessionLineageNodeRecord,
  SessionLineageTree,
  SessionRedoInput,
  SessionRedoResult,
  SessionRewindInput,
  SessionRewindResult,
  SessionRewindState,
  SessionRewindTargetView,
  SessionUncleanShutdownDiagnostic,
  SkillDocument,
  SkillRegistryLoadReport,
  TapeLedgerRow,
} from "@brewva/brewva-vocabulary/session";
import type {
  TaskAcceptanceRecordResult,
  TaskBlockerRecordResult,
  TaskBlockerResolveResult,
  TaskItemAddResult,
  TaskItemStatus,
  TaskItemUpdateResult,
  TaskSpec,
  TaskState,
} from "@brewva/brewva-vocabulary/task";
import type { SessionWireFrame } from "@brewva/brewva-vocabulary/wire";
import type { WorkbenchEntry } from "@brewva/brewva-vocabulary/workbench";
import type { RecoveryWalStoredRecord } from "../../../daemon/api.js";

export type RuntimeEventRecord = BrewvaStructuredEvent & BrewvaEventRecord & ProtocolRecord;
export type RuntimeListener = (event: RuntimeEventRecord) => void;
export type SessionListener = (frame: SessionWireFrame) => void;
export type RuntimeInputRecorder = (
  input: { readonly sessionId?: string } & Record<string, unknown>,
) => RuntimeEventRecord;
export type RuntimeSessionRecorder = (
  sessionId: string,
  payload?: object | null,
) => RuntimeEventRecord;
export type RuntimeDeferredReasonRecorder = (
  sessionId: string,
  reason: string | null,
) => RuntimeEventRecord;
export type RuntimeSemanticRecorder = (...args: unknown[]) => RuntimeEventRecord;
export type RuntimeStateUnsubscribe = () => boolean;
export type RuntimeLineageRecordInput = ProtocolRecord;
export type RuntimeCompactionRequestInput = object | string | null;
export type RuntimeCompactionRequestResult = {
  readonly requested: boolean;
  readonly required: boolean;
  readonly reason?: string;
  readonly status: ContextStatus;
};
export type RuntimeSessionHydration = {
  readonly status: "cold" | "ready" | "degraded";
  readonly hydratedAt: number;
  readonly latestEventId: string | null;
  readonly issues: ReadonlyArray<{
    readonly eventId?: string;
    readonly eventType?: string;
    readonly index?: number;
    readonly reason: string;
  }>;
};
export type RuntimeSessionIntegrity = {
  readonly status: "healthy" | "degraded" | "unavailable";
  readonly issues: ReadonlyArray<{
    readonly domain: string;
    readonly severity: string;
    readonly sessionId?: string;
    readonly eventId?: string;
    readonly eventType?: string;
    readonly index?: number;
    readonly reason: string;
  }>;
};
export type MutableSessionLineageNodeRecord = Omit<
  SessionLineageNodeRecord,
  "summaries" | "outcomes" | "adoptedOutcomes"
> & {
  readonly summaries: Array<ProtocolRecord & { readonly summaryId?: string }>;
  readonly outcomes: Array<ProtocolRecord & { readonly outcomeId?: string }>;
  readonly adoptedOutcomes: Array<{ readonly adoptionId?: string } & ProtocolRecord>;
};

export interface HostedRuntimeOpsPort extends BrewvaToolRuntimeCapabilitiesPort {
  readonly events: {
    recordMetricObservation(
      sessionId: string,
      input: MetricObservationInput,
    ): BrewvaEventRecord | undefined;
    recordGuardResult(sessionId: string, input: GuardResultInput): BrewvaEventRecord | undefined;
    readonly records: {
      listSessionIds(): string[];
      list(sessionId: string, query?: BrewvaEventQuery): RuntimeEventRecord[];
      query(sessionId: string, query?: BrewvaEventQuery): RuntimeEventRecord[];
      queryStructured(sessionId: string, query?: BrewvaEventQuery): RuntimeEventRecord[];
      toStructured(event: BrewvaEventRecord): RuntimeEventRecord;
      subscribe(listener: RuntimeListener): () => boolean;
    };
    readonly replay: {
      listSessions(limit?: number): BrewvaReplaySession[];
    };
    readonly effects: {
      getTurnProjection(
        sessionId: string,
        input?: RenderTurnConsequenceDigestOptions,
      ): TurnEffectCommitmentProjection;
      renderTurnDigest(sessionId: string, input?: RenderTurnConsequenceDigestOptions): string;
    };
    readonly iteration: {
      listGuardResults(sessionId: string, query?: GuardResultQuery): GuardResultRecord[];
      listMetricObservations(
        sessionId: string,
        query?: MetricObservationQuery,
      ): MetricObservationRecord[];
    };
  };
  readonly context: BrewvaToolRuntimeCapabilitiesPort["context"] & {
    readonly evidence: {
      latest(sessionId: string, kind: string): ContextEvidenceSample | undefined;
      append(sessionId: string, payload: object): RuntimeEventRecord;
    };
    readonly usage: {
      get(sessionId: string): ContextBudgetUsage | undefined;
      getStatus(sessionId: string, usage?: ContextBudgetUsage): ContextStatus;
      getRatio(usage?: ContextBudgetUsage): number | null;
      observe(sessionId: string, payload?: ContextBudgetUsage): RuntimeEventRecord;
    };
    readonly compaction: BrewvaToolRuntimeCapabilitiesPort["context"]["compaction"] & {
      rememberDeferredReason: RuntimeDeferredReasonRecorder;
      request(sessionId: string, input?: RuntimeCompactionRequestInput): RuntimeEventRecord;
      checkAndRequest(
        sessionId: string,
        input?: ContextBudgetUsage | ProtocolRecord,
      ): RuntimeCompactionRequestResult;
    };
    readonly lifecycle: {
      onUserInput: RuntimeSessionRecorder;
      onTurnStart(sessionId: string, turn?: number): RuntimeEventRecord;
      onTurnEnd: RuntimeSessionRecorder;
    };
    readonly telemetry: {
      autoCompleted: RuntimeInputRecorder;
      autoFailed: RuntimeInputRecorder;
      autoRequested: RuntimeInputRecorder;
      compactionAdvisory: RuntimeInputRecorder;
      compactionSkipped: RuntimeInputRecorder;
      contextComposed: RuntimeInputRecorder;
      criticalWithoutCompact: RuntimeInputRecorder;
      gateCleared: RuntimeInputRecorder;
      hardGateRequired: RuntimeInputRecorder;
      sessionCompact: RuntimeInputRecorder;
    };
  };
  readonly proposals: {
    readonly requests: {
      listPending(sessionId?: string, query?: unknown): PendingEffectCommitmentRequest[];
      list(sessionId?: string, query?: unknown): EffectCommitmentRequestRecord[];
      decide(
        sessionId: string,
        requestId: string,
        input: DecideEffectCommitmentInput,
      ): DecideEffectCommitmentResult;
    };
    readonly proposals: {
      list(sessionId: string, query?: unknown): ProtocolRecord[];
      submit(sessionId: string, proposal: EffectCommitmentProposal): DecisionReceipt;
    };
    readonly governance: {
      turnDecisionRecorded: RuntimeInputRecorder;
    };
  };
  readonly claim: {
    readonly facts: {
      resolve(sessionId: string, input?: unknown): { ok?: boolean; reason?: string };
      upsert(sessionId: string, input?: unknown): { ok?: boolean; reason?: string };
    };
    readonly state: {
      get(sessionId: string): ClaimState;
    };
  };
  readonly delegation: {
    readonly lifecycle: {
      cancelled(input: unknown): unknown;
      completed(input: unknown): BrewvaEventRecord | undefined;
      deliverySurfaced(input: unknown): unknown;
      failed(input: unknown): unknown;
      knowledgeAdoptionRecorded(input: unknown): unknown;
      outcomeParseFailed(input: unknown): unknown;
      running(input: unknown): unknown;
      spawned(input: unknown): unknown;
    };
    readonly workerResults: {
      applied(input: unknown): unknown;
      applyFailed(input: unknown): unknown;
    };
  };
  readonly lifecycle: {
    getSnapshot(sessionId: string): SessionLifecycleSnapshot;
  };
  readonly ledger: {
    readonly store: {
      getDigest(sessionId: string): { readonly digest?: string } | undefined;
      getPath(): string;
      listRows(sessionId: string): TapeLedgerRow[];
      query(sessionId: string, query?: unknown): string;
      verifyIntegrity(sessionId: string): { valid: boolean; reason?: string; ok?: boolean };
    };
  };
  readonly session: {
    readonly state: {
      clear(sessionId: string): void;
      onClear(listener: (sessionId: string) => void): RuntimeStateUnsubscribe;
    };
    readonly credentials: {
      resolveBindings(): Record<string, never>;
    };
    readonly lineage: {
      getNode(sessionId: string, lineageNodeId: string): SessionLineageNodeRecord | undefined;
      getTree(sessionId: string, query?: unknown): SessionLineageTree;
      listChildren(sessionId: string, lineageNodeId: string): SessionLineageNodeRecord[];
      getContextEntryPath(sessionId: string, query?: unknown): ContextEntryRecord[];
      createNode(sessionId: string, payload: RuntimeLineageRecordInput): RuntimeEventRecord;
      recordSummary(sessionId: string, payload: RuntimeLineageRecordInput): RuntimeEventRecord;
      recordContextEntry(sessionId: string, payload: RuntimeLineageRecordInput): RuntimeEventRecord;
      recordCapabilityState(
        sessionId: string,
        payload: RuntimeLineageRecordInput,
      ): RuntimeEventRecord;
      recordSelection(sessionId: string, payload: RuntimeLineageRecordInput): RuntimeEventRecord;
      recordOutcome(sessionId: string, payload: RuntimeLineageRecordInput): RuntimeEventRecord;
      adoptOutcome(sessionId: string, payload: RuntimeLineageRecordInput): RuntimeEventRecord;
    };
    readonly rewind: {
      getState(sessionId: string): SessionRewindState;
      listTargets(sessionId: string): SessionRewindTargetView[];
      recordCheckpoint(
        sessionId: string,
        input: RecordSessionRewindCheckpointInput,
      ): RuntimeEventRecord;
      rewind(sessionId: string, input: SessionRewindInput): SessionRewindResult;
      redo(sessionId: string, input?: SessionRedoInput): SessionRedoResult;
    };
    readonly lifecycle: {
      agentStarted: RuntimeSemanticRecorder;
      agentEnded: RuntimeSemanticRecorder;
      beforeCompact: RuntimeSemanticRecorder;
      bootstrap: RuntimeSemanticRecorder;
      branchSummaryRecorded: RuntimeSemanticRecorder;
      compactFailed(input: unknown): unknown;
      compactRequestFailed(input: unknown): unknown;
      compactRequested(input: unknown): unknown;
      getHydration(sessionId: string): RuntimeSessionHydration;
      getIntegrity(sessionId: string): RuntimeSessionIntegrity;
      getOpenToolCalls(sessionId: string): OpenToolCallRecord[];
      getUncleanShutdownDiagnostic(sessionId: string): SessionUncleanShutdownDiagnostic | undefined;
      inputObserved: RuntimeSemanticRecorder;
      messageStarted: RuntimeSemanticRecorder;
      messageEnded: RuntimeSemanticRecorder;
      modelPresetSelected: RuntimeSemanticRecorder;
      modelSelected: RuntimeSemanticRecorder;
      providerCredentialRotated: RuntimeSemanticRecorder;
      shutdown: RuntimeSemanticRecorder;
      started: RuntimeSemanticRecorder;
      thinkingLevelSelected: RuntimeSemanticRecorder;
      turnStarted: RuntimeSemanticRecorder;
      turnEnded: RuntimeSemanticRecorder;
    };
    readonly workerResults: {
      list(sessionId: string): WorkerResult[];
      record(sessionId: string, input: WorkerResult): RuntimeEventRecord;
      clear(sessionId: string): RuntimeEventRecord;
      merge(sessionId: string, input?: unknown): WorkerMergeReport;
    };
    readonly title: {
      get(sessionId: string): string | undefined;
      recordGenerated(sessionId: string, payload: RuntimeLineageRecordInput): RuntimeEventRecord;
    };
    readonly compaction: {
      commit(sessionId: string, payload: RuntimeLineageRecordInput): RuntimeEventRecord;
    };
    readonly mcp: {
      serverConnected: RuntimeInputRecorder;
      serverDisconnected: RuntimeInputRecorder;
      toolListRefreshed: RuntimeInputRecorder;
      toolCallFailed: RuntimeInputRecorder;
    };
    readonly stall: {
      poll(
        sessionId: string,
        input: { readonly now?: number; readonly thresholdMs?: number },
      ): RuntimeEventRecord | undefined;
    };
    readonly taskWatchdog: {
      adjudicated: RuntimeSemanticRecorder;
      adjudicationError: RuntimeSemanticRecorder;
    };
  };
  readonly sessionWire: {
    subscribe(sessionId: string, listener: SessionListener): () => boolean;
    query(sessionId: string): SessionWireFrame[];
  };
  readonly task: {
    readonly acceptance: {
      record(
        sessionId: string,
        input: { status: "pending" | "accepted" | "rejected"; decidedBy?: string; notes?: string },
      ): TaskAcceptanceRecordResult;
    };
    readonly blockers: {
      record(
        sessionId: string,
        input: { id?: string; message: string; source?: string; claimId?: string },
      ): TaskBlockerRecordResult;
      resolve(sessionId: string, blockerId: string): TaskBlockerResolveResult;
    };
    readonly items: {
      add(
        sessionId: string,
        input: {
          id?: string;
          text: string;
          status?: TaskItemStatus;
          timestamp?: number;
          turn?: number;
        },
      ): TaskItemAddResult;
      update(
        sessionId: string,
        input: {
          id: string;
          text?: string;
          status?: TaskItemStatus;
          timestamp?: number;
          turn?: number;
        },
      ): TaskItemUpdateResult;
    };
    readonly spec: {
      set(sessionId: string, input: TaskSpec): void;
    };
    readonly state: {
      get(sessionId: string): TaskState;
    };
    readonly target: {
      getDescriptor(sessionId: string): { primaryRoot?: string; roots?: string[] };
    };
  };
  readonly workbench: BrewvaToolRuntimeCapabilitiesPort["workbench"] & {
    list(sessionId: string): WorkbenchEntry[];
    commitBaseline(sessionId: string, input?: unknown): WorkbenchEntry[];
  };
  readonly recovery: {
    getPosture(sessionId: string): undefined;
    getWorkingSet(sessionId: string): undefined;
    listPending(): RecoveryWalStoredRecord[];
  };
  readonly schedule: {
    readonly intents: {
      create(
        sessionId: string,
        input: ScheduleIntentCreateInput,
      ): Promise<ScheduleIntentCreateResult>;
      update(
        sessionId: string,
        input: ScheduleIntentUpdateInput,
      ): Promise<ScheduleIntentUpdateResult>;
      cancel(
        sessionId: string,
        input: ScheduleIntentCancelInput,
      ): Promise<ScheduleIntentCancelResult>;
      getProjectionSnapshot(): Promise<ScheduleProjectionSnapshot>;
      list(query?: ScheduleIntentListQuery): Promise<ScheduleIntentProjectionRecord[]>;
    };
    readonly events: {
      recordIntent(input: object): unknown;
      recordWakeup(sessionId: string, input: object): unknown;
      recordChildStarted(sessionId: string, input: object): unknown;
      recordChildFinished(sessionId: string, input: object): unknown;
      recordChildFailed(sessionId: string, input: object): unknown;
    };
  };
  readonly channel: {
    readonly a2a: {
      blocked: RuntimeInputRecorder;
      invoked: RuntimeInputRecorder;
    };
    readonly agent: {
      created: RuntimeInputRecorder;
      deleted: RuntimeInputRecorder;
      focusChanged: RuntimeInputRecorder;
    };
    readonly command: {
      operatorQuestionAnswered: RuntimeInputRecorder;
      received: RuntimeInputRecorder;
      rejected: RuntimeInputRecorder;
      updateLockBlocked: RuntimeInputRecorder;
      updateRequested: RuntimeInputRecorder;
    };
    readonly discussion: {
      round: RuntimeInputRecorder;
    };
    readonly fanout: {
      finished: RuntimeInputRecorder;
      started: RuntimeInputRecorder;
    };
    readonly ingress: {
      started: RuntimeInputRecorder;
      stopped: RuntimeInputRecorder;
    };
    readonly recovery: {
      walAppended: RuntimeInputRecorder;
      walCompacted: RuntimeInputRecorder;
      walRecoveryCompleted: RuntimeInputRecorder;
      walStatusChanged: RuntimeInputRecorder;
    };
    readonly runtime: {
      evicted: RuntimeInputRecorder;
    };
    readonly session: {
      bound: RuntimeInputRecorder;
      conversationBound: RuntimeInputRecorder;
      workspaceCostSummary: RuntimeInputRecorder;
    };
    readonly turn: {
      approvalTargetUnresolved: RuntimeInputRecorder;
      bridgeError: RuntimeInputRecorder;
      dispatchEnd: RuntimeInputRecorder;
      dispatchStart: RuntimeInputRecorder;
      emitted: RuntimeInputRecorder;
      ingested: RuntimeInputRecorder;
      outboundComplete: RuntimeInputRecorder;
      outboundError: RuntimeInputRecorder;
    };
  };
  readonly skills: {
    readonly catalog: {
      list(): SkillDocument[];
      get(name: string): SkillDocument | undefined;
      getLoadReport(): SkillRegistryLoadReport;
      listProducers(): ProtocolRecord[];
      getProducer(name: string): ProducerContract | undefined;
    };
    readonly selection: {
      record(sessionId: string, receipt: object): unknown;
      latest(sessionId: string): object | undefined;
    };
  };
  readonly tools: BrewvaToolRuntimeCapabilitiesPort["tools"] & {
    readonly access: BrewvaToolRuntimeCapabilitiesPort["tools"]["access"] & {
      check(
        sessionId: string,
        toolName: string,
        args?: Record<string, unknown>,
      ): { allowed: boolean; reason?: string; warning?: string };
      getActionPolicy(toolName: string): ToolActionPolicy | undefined;
    };
    readonly invocation: BrewvaToolRuntimeCapabilitiesPort["tools"]["invocation"] & {
      start(input: ToolInvocationStartInput): ToolInvocationStartReceipt;
    };
    readonly lifecycle: BrewvaToolRuntimeCapabilitiesPort["tools"]["lifecycle"] & {
      callObserved(input: unknown): unknown;
      executionStarted(input: unknown): unknown;
      executionEnded(input: unknown): unknown;
    };
    readonly outputs: BrewvaToolRuntimeCapabilitiesPort["tools"]["outputs"] & {
      artifactPersistFailed(input: unknown): unknown;
      distilled(input: unknown): unknown;
    };
    readonly readPath: BrewvaToolRuntimeCapabilitiesPort["tools"]["readPath"] & {
      contractWarning(input: unknown): unknown;
    };
    readonly steering: {
      queued: RuntimeSemanticRecorder;
      applied: RuntimeSemanticRecorder;
      dropped: RuntimeSemanticRecorder;
    };
    readonly operatorQuestions: {
      answerRecorded: RuntimeInputRecorder;
      asked: RuntimeInputRecorder;
      resolved: RuntimeInputRecorder;
    };
    readonly capabilitySelection: {
      latest(sessionId: string): object | undefined;
      record(sessionId: string, receipt: object): unknown;
    };
    readonly surface: {
      recordResolved(sessionId: string, input: object): unknown;
    };
  };
}
