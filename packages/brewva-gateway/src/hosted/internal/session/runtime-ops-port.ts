import type { Lossy } from "@brewva/brewva-std/honesty";
import type {
  BrewvaToolRuntimeCapabilitiesPort,
  WorkerResultsClearInput,
} from "@brewva/brewva-tools/contracts";
import type { FourPortRuntimeEventRecord } from "@brewva/brewva-tools/runtime-port";
import type { ContextBudgetUsage, ContextStatus } from "@brewva/brewva-vocabulary/context";
import type { WorkerMergeReport, WorkerResult } from "@brewva/brewva-vocabulary/delegation";
import type { BrewvaEventRecord, ProtocolRecord } from "@brewva/brewva-vocabulary/events";
import type {
  BrewvaReplaySession,
  SessionLineageNodeRecord,
} from "@brewva/brewva-vocabulary/session";
import type { SessionWireFrame } from "@brewva/brewva-vocabulary/wire";

export type RuntimeEventRecord = FourPortRuntimeEventRecord;
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
export type MutableSessionLineageNodeRecord = Omit<
  SessionLineageNodeRecord,
  "summaries" | "outcomes" | "adoptedOutcomes"
> & {
  readonly summaries: Array<ProtocolRecord & { readonly summaryId?: string }>;
  readonly outcomes: Array<ProtocolRecord & { readonly outcomeId?: string }>;
  readonly adoptedOutcomes: Array<{ readonly adoptionId?: string } & ProtocolRecord>;
};

export type HostedRuntimeOpsPort = BrewvaToolRuntimeCapabilitiesPort & HostedRuntimeOpsExtensions;

export type HostedRuntimeOpsExtensions = {
  readonly events: {
    readonly replay: {
      listSessions(limit?: number): BrewvaReplaySession[];
    };
  };
  readonly context: {
    readonly evidence: {
      // The evidence sink is the lossy plane: every appended sample is non-authoritative
      // and may vanish on restart. Demand the `Lossy` honesty class so a durable value
      // can never be mis-routed here, and so the lossy plane is typed, not conventional.
      append(sessionId: string, payload: Lossy<object>): RuntimeEventRecord;
    };
    readonly usage: {
      observe(sessionId: string, payload?: ContextBudgetUsage): RuntimeEventRecord | undefined;
    };
    readonly compaction: {
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
      preCompactPrune: RuntimeInputRecorder;
      sessionCompact: RuntimeInputRecorder;
    };
    readonly visibleRead: {
      rememberState(sessionId: string, state: unknown): unknown;
    };
  };
  readonly proposals: {
    readonly governance: {
      turnDecisionRecorded: RuntimeInputRecorder;
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
      rejected(input: unknown): unknown;
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
    readonly lifecycle: {
      agentStarted: RuntimeSemanticRecorder;
      agentEnded: RuntimeSemanticRecorder;
      beforeCompact: RuntimeSemanticRecorder;
      bootstrap: RuntimeSemanticRecorder;
      branchSummaryRecorded: RuntimeSemanticRecorder;
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
      turnInputRecorded: RuntimeSemanticRecorder;
      turnRenderCommitted: RuntimeSemanticRecorder;
    };
    readonly workerResults: {
      list(sessionId: string): WorkerResult[];
      record(sessionId: string, input: WorkerResult): RuntimeEventRecord;
      clear(sessionId: string, input?: WorkerResultsClearInput): RuntimeEventRecord;
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
  readonly schedule: {
    readonly events: {
      recordIntent(input: object): unknown;
      recordRecoveryDeferred(sessionId: string, input: object): unknown;
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
    readonly selection: {
      record(sessionId: string, receipt: object): unknown;
      latest(sessionId: string): object | undefined;
    };
  };
  readonly tools: {
    readonly readPath: {
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
};
