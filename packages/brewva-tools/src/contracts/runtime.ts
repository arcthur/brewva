import type { BrewvaConfig, BrewvaRuntimeIdentity, DeepReadonly } from "@brewva/brewva-runtime";
import type { ToolActionPolicy } from "@brewva/brewva-runtime/security";
import type {
  ContextBudgetUsage,
  ContextCompactionGateStatus,
  ContextEntryRecord,
  ContextEvidenceSample,
  ContextStatus,
} from "@brewva/brewva-vocabulary/context";
import type { WorkerMergeReport, WorkerResult } from "@brewva/brewva-vocabulary/delegation";
import type {
  BrewvaEventQuery,
  BrewvaEventRecord,
  ProtocolRecord,
  BrewvaStructuredEvent,
} from "@brewva/brewva-vocabulary/events";
import type {
  ActiveReasoningBranchState,
  ClaimState,
  DecideEffectCommitmentInput,
  DecideEffectCommitmentResult,
  DecisionReceipt,
  EffectCommitmentRequestRecord,
  EffectCommitmentProposal,
  GuardResultInput,
  GuardResultQuery,
  GuardResultRecord,
  MetricObservationInput,
  MetricObservationQuery,
  MetricObservationRecord,
  PendingEffectCommitmentRequest,
  ReasoningCheckpointRecord,
  ReasoningRevertInput,
  ReasoningRevertRecord,
  RecordReasoningCheckpointInput,
  RenderTurnConsequenceDigestOptions,
  ResourceLeaseRecord,
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
  HistoryViewBaselineSnapshot,
  OpenToolCallRecord,
  ProducerContract,
  RecordSessionRewindCheckpointInput,
  SessionCostSummary,
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
  TapeHandoffResult,
  TapeSearchResult,
  TapeStatusState,
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
  TaskTargetDescriptor,
} from "@brewva/brewva-vocabulary/task";
import type { SessionWireFrame } from "@brewva/brewva-vocabulary/wire";
import type {
  SourcePatchApplyResult,
  SourcePatchPlan,
  SourcePatchStaleRecoveryRecord,
  SourceResourceDescriptor,
  SourceSnapshot,
  WorkbenchEntry,
} from "@brewva/brewva-vocabulary/workbench";
import type { ManagedExecProcessRegistryRuntime } from "../families/execution/exec-process-registry/runtime.js";
import type { BoxPlane } from "../internal/box/index.js";
import type { BrewvaToolDelegationQuery, BrewvaToolOrchestration } from "./delegation.js";
import type { BrewvaToolRuntimeExtensions, BrewvaToolRuntimeToolsExtension } from "./metadata.js";

interface RuntimeResult {
  readonly ok?: boolean;
  readonly reason?: string;
}

type RuntimeMutationResult = RuntimeResult;

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

export type RuntimeRecoveryPendingRecord = {
  readonly walId: string;
  readonly source: string;
  readonly status: string;
  readonly sessionId: string;
  readonly turnId?: string;
  readonly channel?: string;
  readonly updatedAt: number;
  readonly envelope: { readonly meta?: Record<string, unknown> | null };
};

export const BREWVA_TOOL_RUNTIME_COMMAND_NAMESPACES = [
  "claim",
  "cost",
  "delegation",
  "events",
  "proposals",
  "reasoning",
  "schedule",
  "session",
  "tape",
  "task",
  "tools",
  "verification",
  "workbench",
] as const;

export const BREWVA_TOOL_RUNTIME_QUERY_NAMESPACES = [
  "claim",
  "context",
  "cost",
  "events",
  "ledger",
  "lifecycle",
  "proposals",
  "reasoning",
  "recovery",
  "schedule",
  "session",
  "sessionWire",
  "skills",
  "tape",
  "task",
  "tools",
  "workbench",
] as const;

export const BREWVA_TOOL_RUNTIME_CAPABILITY_NAMESPACES = [
  "claim",
  "context",
  "cost",
  "delegation",
  "events",
  "ledger",
  "lifecycle",
  "proposals",
  "reasoning",
  "recovery",
  "schedule",
  "session",
  "sessionWire",
  "skills",
  "tape",
  "task",
  "tools",
  "verification",
  "workbench",
] as const;

export type BrewvaToolRuntimeCapabilityNamespace =
  (typeof BREWVA_TOOL_RUNTIME_CAPABILITY_NAMESPACES)[number];

export interface WorkerResultsClearInput {
  readonly workerIds?: readonly string[];
  readonly decision?: "applied" | "reject";
  readonly reason?: string;
}

export interface BrewvaToolRuntimeCommandPort {
  readonly claim: {
    readonly facts: {
      resolve(sessionId: string, input?: unknown): RuntimeMutationResult;
      upsert(sessionId: string, input?: unknown): RuntimeMutationResult;
    };
  };
  readonly cost: {
    readonly usage: {
      recordAssistant(input: unknown): SessionCostSummary;
    };
  };
  readonly delegation: {
    readonly lifecycle: {
      knowledgeAdoptionRecorded(input: unknown): unknown;
    };
    readonly workerResults: {
      applied(input: unknown): unknown;
      applyFailed(input: unknown): unknown;
      rejected(input: unknown): unknown;
    };
  };
  readonly events: {
    recordMetricObservation(
      sessionId: string,
      input: MetricObservationInput,
    ): BrewvaEventRecord | undefined;
    recordGuardResult(sessionId: string, input: GuardResultInput): BrewvaEventRecord | undefined;
  };
  readonly proposals: {
    readonly proposals: {
      submit(sessionId: string, proposal: EffectCommitmentProposal): DecisionReceipt;
    };
    readonly requests: {
      decide(
        sessionId: string,
        requestId: string,
        input: DecideEffectCommitmentInput,
      ): DecideEffectCommitmentResult;
    };
  };
  readonly reasoning: {
    readonly checkpoints: {
      record(sessionId: string, input: RecordReasoningCheckpointInput): ReasoningCheckpointRecord;
    };
    readonly reverts: {
      revert(sessionId: string, input: ReasoningRevertInput): ReasoningRevertRecord;
    };
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
    };
  };
  readonly session: {
    readonly compaction: {
      commit(sessionId: string, input: ProtocolRecord): BrewvaEventRecord;
    };
    readonly lifecycle: {
      compactFailed(input: unknown): unknown;
      compactRequestFailed(input: unknown): unknown;
      compactRequested(input: unknown): unknown;
    };
    readonly lineage: {
      adoptOutcome(sessionId: string, input: ProtocolRecord): BrewvaEventRecord;
      createNode(sessionId: string, input: ProtocolRecord): BrewvaEventRecord;
      recordCapabilityState(sessionId: string, input: ProtocolRecord): BrewvaEventRecord;
      recordContextEntry(sessionId: string, input: ProtocolRecord): BrewvaEventRecord;
      recordOutcome(sessionId: string, input: ProtocolRecord): BrewvaEventRecord;
      recordSelection(sessionId: string, input: ProtocolRecord): BrewvaEventRecord;
      recordSummary(sessionId: string, input: ProtocolRecord): BrewvaEventRecord;
    };
    readonly rewind: {
      recordCheckpoint(
        sessionId: string,
        input: RecordSessionRewindCheckpointInput,
      ): BrewvaEventRecord;
      redo(sessionId: string, input?: SessionRedoInput): SessionRedoResult;
      rewind(sessionId: string, input: SessionRewindInput): SessionRewindResult;
    };
    readonly title: {
      recordGenerated(sessionId: string, input: ProtocolRecord): BrewvaEventRecord;
    };
    readonly workerResults: {
      record(sessionId: string, input: WorkerResult): BrewvaEventRecord;
    };
  };
  readonly tape: {
    readonly handoff: {
      record(
        sessionId: string,
        input: { name: string; summary?: string; nextSteps?: string },
      ): TapeHandoffResult;
    };
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
  };
  readonly tools: {
    readonly invocation: {
      finish(input: unknown): void;
      recordResult(input: unknown): unknown;
      start(input: ToolInvocationStartInput): ToolInvocationStartReceipt;
    };
    readonly execution: {
      recordAudit(input: unknown): unknown;
    };
    readonly lifecycle: {
      boxReleased(input: unknown): unknown;
      callBlocked(input: unknown): unknown;
      callObserved(input: unknown): unknown;
      executionEnded(input: unknown): unknown;
      executionStarted(input: unknown): unknown;
      parallelRead(input: unknown): unknown;
    };
    readonly observability: {
      assertionRecorded(input: unknown): unknown;
      queryExecuted(input: unknown): unknown;
    };
    readonly outputs: {
      artifactPersisted(input: unknown): unknown;
      artifactPersistFailed(input: unknown): unknown;
      distilled(input: unknown): unknown;
      observed(input: unknown): unknown;
      search(input: unknown): unknown;
      sourceIntelligenceQuery(input: unknown): unknown;
    };
    readonly readPath: {
      discoveryObserved(input: unknown): unknown;
      gateArmed(input: unknown): unknown;
    };
    readonly parallel: {
      acquire(
        sessionId: string,
        runId: string,
        options?: unknown,
      ): { accepted: boolean; reason?: string };
      acquireAsync(
        sessionId: string,
        runId: string,
        options?: { timeoutMs?: number },
      ): Promise<{ accepted: boolean }>;
      release(sessionId: string, runId: string): void;
    };
    readonly patches: {
      redoLastPatchSet(sessionId: string): RuntimeMutationResult;
      rollbackLastMutation(sessionId: string): RuntimeMutationResult;
      rollbackLastPatchSet(sessionId: string): {
        ok: boolean;
        patchSetId?: string;
        restoredPaths: string[];
        failedPaths: string[];
        reason?: string;
      };
    };
    readonly sourcePatch: {
      readonly snapshots: {
        record(sessionId: string, input: SourceSnapshot): unknown;
      };
      readonly plans: {
        prepare(sessionId: string, input: SourcePatchPlan): unknown;
        apply(sessionId: string, input: SourcePatchApplyResult): unknown;
      };
      readonly staleRecovery: {
        record(sessionId: string, input: SourcePatchStaleRecoveryRecord): unknown;
      };
      readonly resources: {
        read(sessionId: string, input: SourceResourceDescriptor): unknown;
      };
    };
    readonly resourceLeases: {
      request(
        sessionId: string,
        input: {
          reason: string;
          budget: { maxToolCalls?: number; maxTokens?: number; maxParallel?: number };
          ttlMs?: number;
          ttlTurns?: number;
        },
      ):
        | { ok: true; lease: ResourceLeaseRecord }
        | { ok: false; reason: string; lease?: ResourceLeaseRecord };
      cancel(
        sessionId: string,
        leaseId: string,
        reason?: string,
      ):
        | { ok: true; lease: ResourceLeaseRecord }
        | { ok: false; reason: string; lease?: ResourceLeaseRecord };
    };
    readonly tracking: {
      markCall(sessionId: string, input?: unknown): void;
      trackCallEnd(input: unknown): void;
      trackCallStart(input: unknown): void;
    };
    readonly recall: {
      curationRecorded(input: unknown): unknown;
      resultsSurfaced(input: unknown): unknown;
    };
  };
  readonly verification: {
    readonly checks: {
      evaluate(
        sessionId: string,
        input?: unknown,
      ): RuntimeMutationResult | Promise<RuntimeMutationResult>;
      verify(
        sessionId: string,
        input?: unknown,
      ): RuntimeMutationResult | Promise<RuntimeMutationResult>;
    };
  };
  readonly workbench: {
    commitBaseline(sessionId: string, input?: unknown): WorkbenchEntry[];
    evict(
      sessionId: string,
      input: {
        spanRefs: readonly string[];
        replacementNote?: string;
        reason: string;
        preservedQuotes?: readonly string[];
      },
    ): WorkbenchEntry;
    note(
      sessionId: string,
      input: {
        content: string;
        sourceRefs?: readonly string[];
        reason: string;
        retentionHint?: string;
      },
    ): WorkbenchEntry;
    undoEviction(
      sessionId: string,
      entryId: string,
      reason: string,
    ): { undone: boolean; entry?: WorkbenchEntry };
  };
}

export interface BrewvaToolRuntimeQueryPort {
  readonly claim: {
    readonly state: {
      get(sessionId: string): ClaimState;
    };
  };
  readonly context: {
    readonly compaction: {
      checkGate(
        sessionId: string,
        toolName: string,
        usage?: ContextBudgetUsage,
      ): ContextCompactionGateStatus;
      getGateStatus(sessionId: string, usage?: ContextBudgetUsage): ContextCompactionGateStatus;
      getHardLimitRatio(sessionId: string, usage?: ContextBudgetUsage): number;
      getInstructions(): string;
      getPendingReason(sessionId: string): string | null;
      getThresholdRatio(sessionId: string, usage?: ContextBudgetUsage): number;
      getWindowTurns(): number;
      resolveEligibility(input: unknown): {
        eligible: boolean;
        reason?: string;
        decision?: string;
      };
    };
    readonly evidence: {
      latest(sessionId: string, key: string): ContextEvidenceSample | undefined;
    };
    readonly prompt: {
      getHistoryViewBaseline(sessionId: string): HistoryViewBaselineSnapshot | undefined;
    };
    readonly sanitizeInput: (text: string) => string;
    readonly usage: {
      get(sessionId: string): ContextBudgetUsage | undefined;
      getRatio(usage: ContextBudgetUsage | undefined): number | null;
      getStatus(sessionId: string, usage: ContextBudgetUsage | undefined): ContextStatus;
    };
    readonly visibleRead: {
      getEpoch(sessionId: string): number;
      isCurrent(sessionId: string, state: unknown): boolean;
    };
  };
  readonly cost: {
    readonly summary: {
      get(sessionId: string): SessionCostSummary;
    };
  };
  readonly events: {
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
    readonly records: {
      listSessionIds(): string[];
      list(sessionId: string, query?: BrewvaEventQuery): BrewvaEventRecord[];
      query(sessionId: string, query?: BrewvaEventQuery): BrewvaEventRecord[];
      queryStructured(sessionId: string, query?: BrewvaEventQuery): BrewvaStructuredEvent[];
      subscribe(listener: (event: BrewvaEventRecord) => void): () => void;
      toStructured(event: BrewvaEventRecord): BrewvaStructuredEvent;
    };
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
  readonly lifecycle: {
    getSnapshot(sessionId: string): SessionLifecycleSnapshot;
  };
  readonly proposals: {
    readonly proposals: {
      list(sessionId: string, query?: unknown): ProtocolRecord[];
    };
    readonly requests: {
      list(sessionId: string, query?: unknown): EffectCommitmentRequestRecord[];
      listPending(sessionId?: string, query?: unknown): PendingEffectCommitmentRequest[];
    };
  };
  readonly reasoning: {
    readonly checkpoints: {
      get(sessionId: string, checkpointId: string): unknown;
      list(sessionId: string): unknown[];
    };
    readonly reverts: {
      canRevertTo(sessionId: string, checkpointId: string): boolean;
      list(sessionId: string): unknown[];
    };
    readonly state: {
      getActive(sessionId: string): ActiveReasoningBranchState;
    };
  };
  readonly recovery: {
    getPosture(sessionId: string): unknown;
    getWorkingSet(sessionId: string): unknown;
    listPending(): RuntimeRecoveryPendingRecord[];
  };
  readonly schedule: {
    readonly intents: {
      getProjectionSnapshot(): Promise<ScheduleProjectionSnapshot>;
      list(query?: ScheduleIntentListQuery): Promise<ScheduleIntentProjectionRecord[]>;
    };
  };
  readonly session: {
    readonly lifecycle: {
      getHydration(sessionId: string): RuntimeSessionHydration;
      getIntegrity(sessionId: string): RuntimeSessionIntegrity;
      getOpenToolCalls(sessionId: string): OpenToolCallRecord[];
      getUncleanShutdownDiagnostic(sessionId: string): SessionUncleanShutdownDiagnostic | undefined;
    };
    readonly lineage: {
      getContextEntryPath(sessionId: string, query?: unknown): ContextEntryRecord[];
      getNode(sessionId: string, lineageNodeId: string): SessionLineageNodeRecord | undefined;
      getTree(sessionId: string, query?: unknown): SessionLineageTree;
      listChildren(sessionId: string, lineageNodeId: string): SessionLineageNodeRecord[];
    };
    readonly rewind: {
      getState(sessionId: string): SessionRewindState;
      listTargets(sessionId: string): SessionRewindTargetView[];
    };
    readonly title: {
      get(sessionId: string): string | undefined;
    };
    readonly workerResults: {
      list(sessionId: string): WorkerResult[];
      clear(sessionId: string, input?: WorkerResultsClearInput): unknown;
      merge(sessionId: string, input?: unknown): WorkerMergeReport;
    };
  };
  readonly sessionWire: {
    query(sessionId: string, query?: unknown): SessionWireFrame[];
    subscribe(sessionId: string, listener: (event: SessionWireFrame) => void): () => boolean;
  };
  readonly skills: {
    readonly catalog: {
      get(name: string): SkillDocument | undefined;
      getLoadReport(): SkillRegistryLoadReport;
      getProducer(name: string): ProducerContract | undefined;
      list(): SkillDocument[];
      listProducers(): ProtocolRecord[];
    };
    readonly selection: {
      record(sessionId: string, receipt: object): unknown;
    };
  };
  readonly tape: {
    readonly search: {
      search(
        sessionId: string,
        input: { query: string; scope?: string; limit?: number },
      ): TapeSearchResult;
    };
    readonly status: {
      get(sessionId: string): TapeStatusState;
      getPressureThresholds(): TapeStatusState["thresholds"];
    };
  };
  readonly task: {
    readonly state: {
      get(sessionId: string): TaskState;
    };
    readonly target: {
      getDescriptor(sessionId: string): TaskTargetDescriptor;
    };
  };
  readonly tools: {
    readonly access: {
      check(
        sessionId: string,
        toolName: string,
        args?: Record<string, unknown>,
      ): { allowed: boolean; reason?: string; warning?: string };
      explain(input: unknown): { allowed: boolean; reason?: string; warning?: string };
      getActionPolicy(toolName: string): ToolActionPolicy | undefined;
    };
    readonly resourceLeases: {
      list(
        sessionId: string,
        query?: { includeInactive?: boolean; skillName?: string },
      ): ResourceLeaseRecord[];
    };
    readonly undo: {
      resolveSessionId(input?: unknown): string | undefined;
    };
  };
  readonly workbench: {
    list(sessionId: string): WorkbenchEntry[];
  };
}

export type BrewvaToolRuntimeCapabilitiesPort = BrewvaToolRuntimeCommandPort &
  BrewvaToolRuntimeQueryPort;

export interface BrewvaToolRuntime {
  readonly identity: BrewvaRuntimeIdentity;
  readonly config: DeepReadonly<BrewvaConfig>;
  readonly capabilities: BrewvaToolRuntimeCapabilitiesPort;
  readonly extensions?: BrewvaToolRuntimeExtensions;
  readonly orchestration?: BrewvaToolOrchestration;
  readonly delegation?: BrewvaToolDelegationQuery;
}

type CapabilityScopedMethod<
  TMethod,
  TCapability extends string,
  TCapabilities extends string,
> = TMethod extends (...args: infer TArgs) => infer TResult
  ? TCapability extends TCapabilities
    ? (...args: TArgs) => TResult
    : never
  : TMethod;

type CapabilityScopedRuntimePort<
  TPort extends object,
  TPrefix extends string,
  TCapabilities extends string,
> = {
  [TMemberName in keyof TPort]: TPort[TMemberName] extends (...args: never[]) => unknown
    ? CapabilityScopedMethod<
        TPort[TMemberName],
        `${TPrefix}.${Extract<TMemberName, string>}`,
        TCapabilities
      >
    : TPort[TMemberName] extends object
      ? CapabilityScopedRuntimePort<
          TPort[TMemberName],
          `${TPrefix}.${Extract<TMemberName, string>}`,
          TCapabilities
        >
      : TPort[TMemberName];
};

type CapabilityScopedToolRuntimeExtensions<TCapabilities extends string> = {
  [TMethodName in keyof BrewvaToolRuntimeToolsExtension]: CapabilityScopedMethod<
    BrewvaToolRuntimeToolsExtension[TMethodName],
    `extensions.tools.${Extract<TMethodName, string>}`,
    TCapabilities
  >;
};

export type CapabilityScopedBrewvaToolRuntime<
  TRuntime extends BrewvaToolRuntime | undefined,
  TCapabilities extends string,
> = TRuntime extends undefined
  ? undefined
  : TRuntime extends BrewvaToolRuntime
    ? Omit<TRuntime, "capabilities" | "extensions"> & {
        capabilities: CapabilityScopedRuntimePort<
          TRuntime["capabilities"],
          "capabilities",
          TCapabilities
        >;
        extensions?: {
          tools?: CapabilityScopedToolRuntimeExtensions<TCapabilities>;
        };
      }
    : never;

export type BrewvaBundledToolRuntime = BrewvaToolRuntime & {
  boxPlane?: BoxPlane;
  execProcessRegistry?: ManagedExecProcessRegistryRuntime;
};

export interface BrewvaToolOptions<TRuntime extends BrewvaToolRuntime = BrewvaToolRuntime> {
  runtime: TRuntime;
  verification?: {
    executeCommands?: boolean;
    timeoutMs?: number;
  };
}

export interface BrewvaBundledToolOptions extends BrewvaToolOptions {
  runtime: BrewvaBundledToolRuntime;
}
