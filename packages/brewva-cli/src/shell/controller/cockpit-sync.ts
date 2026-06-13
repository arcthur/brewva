import type { HostedRuntimeAdapterPort } from "@brewva/brewva-gateway/hosted";
import type { SessionPhase } from "@brewva/brewva-substrate/session";
import type { RuntimeCostPosture } from "@brewva/brewva-tools/contracts";
import {
  TASK_WORK_CARD_PROJECTION_SCHEMA_V2,
  type TaskWorkCardProjection,
} from "@brewva/brewva-vocabulary/session";
import type { ContextCockpitReport } from "../../operator/inspect.js";
import { buildInspectReport, buildTaskWorkCardProjection } from "../../operator/inspect.js";
import { getCliRuntimeCostPosture, queryCliRuntimeEvents } from "../../runtime/runtime-ports.js";
import type { ShellCommitOptions } from "../domain/actions.js";
import type { ShellClock, ShellScheduledTimeout } from "../domain/clock.js";
import {
  projectShellCockpitProjection,
  type CockpitObservationCursor,
  type ShellCockpitChannelProjection,
  type ShellCockpitPhaseTransition,
  type ShellCockpitProjectionSource,
  type ShellCockpitSandboxPosture,
} from "../domain/cockpit/index.js";
import type { OperatorSurfaceSnapshot } from "../domain/operator-snapshot.js";
import type { CliShellAction } from "../domain/state.js";
import type { SessionViewPort } from "../ports/session-port.js";

const COCKPIT_PROGRESS_SYNC_INTERVAL_MS = 100;

interface ShellCockpitColdSourceSnapshot {
  readonly sessionId: string;
  readonly workCard: TaskWorkCardProjection;
  readonly contextCockpit: ContextCockpitReport;
  readonly runtimeEvents: ReturnType<typeof queryCliRuntimeEvents>;
  readonly cost: RuntimeCostPosture;
  readonly rewindTargets: ReturnType<SessionViewPort["listRewindTargets"]>;
}

export interface ShellCockpitSyncContext {
  isDisposed(): boolean;
  getRuntime(): HostedRuntimeAdapterPort;
  getSessionId(): string;
  getSessionPhase(): SessionPhase;
  getModelLabel(): string;
  getOperatorSnapshot(): OperatorSurfaceSnapshot;
  getObservation(): CockpitObservationCursor;
  getRewindTargets(): ReturnType<SessionViewPort["listRewindTargets"]>;
  getSessionWireFrames(
    sessionId?: string,
    options?: Parameters<SessionViewPort["getSessionWireFrames"]>[1],
  ): ReturnType<SessionViewPort["getSessionWireFrames"]>;
  getCockpitWireFoldSnapshot?(
    sessionId?: string,
    options?: Parameters<SessionViewPort["getCockpitWireFoldSnapshot"]>[1],
  ): ReturnType<SessionViewPort["getCockpitWireFoldSnapshot"]>;
  commit(action: CliShellAction, options?: ShellCommitOptions): void;
  clock: ShellClock;
}

function fallbackCostPosture(): RuntimeCostPosture {
  return {
    status: "disabled",
    salience: "muted",
    totalCostUsd: 0,
    budgetLimitUsd: null,
    budgetRemainingUsd: null,
    usageRatio: null,
    alertThresholdRatio: null,
    actionOnExceed: "off",
    softGate: { required: false, reason: null },
    label: "cost tracking disabled",
    shortLabel: "$0.00",
  };
}

function fallbackContextCockpit(): ContextCockpitReport {
  const status = {
    usageRatio: null,
    hardLimitRatio: 1,
    compactionThresholdRatio: 1,
    compactionAdvised: false,
    forcedCompaction: false,
  };
  return {
    sideEffectPolicy: "inspect_projection_only",
    context: {
      usage: undefined,
      status,
      gate: { status, required: false, reason: null },
      pendingCompactionReason: null,
      visibleReadEpoch: 0,
      historyBaseline: undefined,
    },
    workbench: { activeCount: 0, entries: [] },
    skills: { selectionId: null, invocationRecords: [], resourceRefs: [] },
    capabilities: { receiptRefs: [], latest: null },
    recall: { results: [] },
    compaction: { timeline: [], latestBaseline: null, inputProvenance: null },
    cachePosture: {
      status: "unknown",
      bucketKey: null,
      stablePrefixHash: null,
      dynamicTailHash: null,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      supported: false,
      reason: null,
    },
  };
}

function fallbackWorkCard(input: {
  readonly runtime: HostedRuntimeAdapterPort;
  readonly sessionId: string;
  readonly contextCockpit: ContextCockpitReport;
}): TaskWorkCardProjection {
  return {
    schema: TASK_WORK_CARD_PROJECTION_SCHEMA_V2,
    version: 2,
    sessionId: input.sessionId,
    refs: [],
    goal: {
      current: null,
      phase: null,
      health: null,
      targetRoots: [input.runtime.identity.workspaceRoot],
      taskItemCount: 0,
      blockerCount: 0,
    },
    context: {
      pressure: "unknown",
      workbenchEntryCount: input.contextCockpit.workbench.activeCount,
      skillInvocationRefs: [],
      resourceRefs: [],
      recallResultRefs: [],
      compactBaselineRef: null,
      automaticallyAvailableRefs: ["current_request", "project_guidance", "target_roots"],
    },
    options: {
      generatedCount: 0,
      consumedRefs: [],
      pinnedRefs: [],
      ignoredRefs: [],
      verifyPlanRefs: [],
    },
    authority: {
      selectedCapabilities: [],
      capabilityReceiptRefs: [],
      pendingAskCount: 0,
      denialCount: 0,
      recentDecisionRefs: [],
    },
    work: {
      activeRunCount: 0,
      pendingWorkerPatchCount: 0,
      pendingKnowledgeAdoptionCount: 0,
      unreadEvidenceCount: 0,
      blockedOrFailedRunCount: 0,
      recoveryNextOwner: "operator",
    },
    evidence: {
      verificationOutcome: null,
      verificationLevel: null,
      failedChecks: [],
      missingChecks: [],
      missingEvidence: [],
      verificationDebtCount: 0,
      latestPatchSetRef: null,
    },
    continuationAnchor: {
      anchorId: null,
      name: null,
      summary: null,
      nextSteps: null,
    },
  };
}

function safeRead<T>(read: () => T, fallback: T): T {
  try {
    return read();
  } catch {
    return fallback;
  }
}

function buildWorkCardSource(input: {
  readonly runtime: HostedRuntimeAdapterPort;
  readonly sessionId: string;
}): {
  readonly workCard: TaskWorkCardProjection;
  readonly contextCockpit: ContextCockpitReport;
} {
  try {
    const report = buildInspectReport(input.runtime, input.sessionId);
    return {
      workCard: buildTaskWorkCardProjection(report),
      contextCockpit: report.contextCockpit,
    };
  } catch {
    const contextCockpit = fallbackContextCockpit();
    return {
      workCard: fallbackWorkCard({
        runtime: input.runtime,
        sessionId: input.sessionId,
        contextCockpit,
      }),
      contextCockpit,
    };
  }
}

function buildFallbackColdSource(input: {
  readonly runtime: HostedRuntimeAdapterPort;
  readonly sessionId: string;
}): ShellCockpitColdSourceSnapshot {
  const contextCockpit = fallbackContextCockpit();
  return {
    sessionId: input.sessionId,
    workCard: fallbackWorkCard({
      runtime: input.runtime,
      sessionId: input.sessionId,
      contextCockpit,
    }),
    contextCockpit,
    runtimeEvents: [],
    cost: fallbackCostPosture(),
    rewindTargets: [],
  };
}

function buildColdSource(input: {
  readonly runtime: HostedRuntimeAdapterPort;
  readonly sessionId: string;
  readonly readRewindTargets: () => ReturnType<SessionViewPort["listRewindTargets"]>;
}): ShellCockpitColdSourceSnapshot {
  const workCardSource = buildWorkCardSource({
    runtime: input.runtime,
    sessionId: input.sessionId,
  });
  return {
    sessionId: input.sessionId,
    ...workCardSource,
    runtimeEvents: safeRead(() => queryCliRuntimeEvents(input.runtime, input.sessionId), []),
    cost: safeRead(
      () => getCliRuntimeCostPosture(input.runtime, input.sessionId),
      fallbackCostPosture(),
    ),
    rewindTargets: safeRead(() => input.readRewindTargets(), []),
  };
}

function resolveSandboxPosture(runtime: HostedRuntimeAdapterPort): ShellCockpitSandboxPosture {
  const mode = runtime.config.security.mode;
  const backend = runtime.config.security.execution.backend;
  if (mode === "strict" && backend === "box") {
    return "restricted";
  }
  if (backend === "box") {
    return "workspace_write";
  }
  if (mode === "permissive") {
    return "unrestricted";
  }
  return "workspace_write";
}

function buildChannels(input: {
  readonly sessionId: string;
  readonly phase: SessionPhase;
  readonly operator: OperatorSurfaceSnapshot;
}): ShellCockpitChannelProjection[] {
  const channels: ShellCockpitChannelProjection[] = [
    {
      kind: "cli",
      id: `cli:${input.sessionId}`,
      label: "CLI",
      status: input.phase.kind === "crashed" ? "blocked" : "active",
      sessionId: input.sessionId,
    },
  ];
  for (const session of input.operator.sessions.slice(0, 4)) {
    if (session.sessionId === input.sessionId) {
      continue;
    }
    channels.push({
      kind: "runtime",
      id: `runtime:${session.sessionId}`,
      label: session.sessionId,
      status: "idle",
      sessionId: session.sessionId,
    });
  }
  return channels;
}

function latestSourceRef(source: Omit<ShellCockpitProjectionSource, "transitionsSince">): {
  readonly ref: string;
  readonly changedAt: number;
} {
  let latest = { ref: `work-card:${source.sessionId}`, changedAt: 0 };
  const observe = (candidate: { readonly ref: string; readonly changedAt: number }): void => {
    if (
      candidate.changedAt > latest.changedAt ||
      (candidate.changedAt === latest.changedAt && candidate.ref < latest.ref)
    ) {
      latest = candidate;
    }
  };
  for (const frame of source.sessionWire) {
    observe({ ref: frame.sourceEventId ?? frame.frameId, changedAt: frame.ts });
  }
  if (source.wireFold?.latestWireRef) {
    observe(source.wireFold.latestWireRef);
  }
  for (const event of source.runtimeEvents) {
    observe({ ref: event.id, changedAt: event.timestamp });
  }
  for (const approval of source.operator.approvals) {
    observe({ ref: approval.requestId, changedAt: approval.createdAt ?? 0 });
  }
  for (const question of source.operator.questions) {
    observe({ ref: question.questionId, changedAt: question.createdAt });
  }
  return latest;
}

export class ShellCockpitSync {
  readonly #transitions: ShellCockpitPhaseTransition[] = [];
  #coldSourceSnapshot: ShellCockpitColdSourceSnapshot | undefined;
  #lastPhaseKind: SessionPhase["kind"] | undefined;
  #scheduled = false;
  #progressScheduled = false;
  #disposed = false;
  #progressTimer: ShellScheduledTimeout | undefined;
  #lastProgressSyncAt: number | undefined;

  constructor(private readonly context: ShellCockpitSyncContext) {}

  reset(): void {
    this.clearProgressTimer();
    this.#transitions.length = 0;
    this.#coldSourceSnapshot = undefined;
    this.#lastPhaseKind = undefined;
    this.#scheduled = false;
    this.#progressScheduled = false;
    this.#disposed = false;
    this.#lastProgressSyncAt = undefined;
  }

  dispose(): void {
    this.#disposed = true;
    this.clearProgressTimer();
    this.#scheduled = false;
    this.#progressScheduled = false;
  }

  requestSync(): void {
    if (this.#disposed || this.#scheduled || this.context.isDisposed()) {
      return;
    }
    this.clearProgressTimer();
    this.#scheduled = true;
    queueMicrotask(() => {
      this.#scheduled = false;
      this.syncNow();
    });
  }

  requestProgressSync(): void {
    if (this.#disposed || this.context.isDisposed() || this.#scheduled) {
      return;
    }
    const lastSyncAt = this.#lastProgressSyncAt;
    const elapsedMs = lastSyncAt === undefined ? undefined : this.context.clock.now() - lastSyncAt;
    if (elapsedMs === undefined || elapsedMs >= COCKPIT_PROGRESS_SYNC_INTERVAL_MS) {
      this.requestProgressSyncNow();
      return;
    }
    if (this.#progressTimer) {
      return;
    }
    this.#progressTimer = this.context.clock.schedule(() => {
      this.#progressTimer = undefined;
      this.requestProgressSyncNow();
    }, COCKPIT_PROGRESS_SYNC_INTERVAL_MS - elapsedMs);
  }

  syncNow(): void {
    this.syncProjection({ refreshColdSource: true });
  }

  private requestProgressSyncNow(): void {
    if (this.#disposed || this.#progressScheduled || this.#scheduled || this.context.isDisposed()) {
      return;
    }
    this.clearProgressTimer();
    this.#progressScheduled = true;
    queueMicrotask(() => {
      this.#progressScheduled = false;
      this.syncProgressNow();
    });
  }

  private syncProgressNow(): void {
    if (this.#scheduled) {
      return;
    }
    this.syncProjection({ refreshColdSource: false });
  }

  private syncProjection(input: { readonly refreshColdSource: boolean }): void {
    if (this.#disposed || this.context.isDisposed()) {
      return;
    }
    const runtime = this.context.getRuntime();
    const sessionId = this.context.getSessionId();
    const phase = this.context.getSessionPhase();
    const operator = this.context.getOperatorSnapshot();
    const coldSource = input.refreshColdSource
      ? this.refreshColdSource({ runtime, sessionId })
      : this.readColdSource({ runtime, sessionId });
    const wireFold = safeRead(
      () =>
        this.context.getCockpitWireFoldSnapshot?.(sessionId, {
          refreshDurable: input.refreshColdSource,
        }),
      undefined,
    );
    const sourceBase: Omit<ShellCockpitProjectionSource, "transitionsSince"> = {
      sessionId,
      phase,
      workCard: coldSource.workCard,
      contextCockpit: coldSource.contextCockpit,
      operator,
      sessionWire: wireFold
        ? []
        : safeRead(
            () =>
              this.context.getSessionWireFrames(sessionId, {
                refreshDurable: input.refreshColdSource,
              }),
            [],
          ),
      ...(wireFold ? { wireFold } : {}),
      runtimeEvents: coldSource.runtimeEvents,
      cost: coldSource.cost,
      rewindTargets: coldSource.rewindTargets,
      observation: this.context.getObservation(),
      runtimeLabels: {
        providerLabel: null,
        modelLabel: this.context.getModelLabel(),
        sandboxPosture: safeRead(() => resolveSandboxPosture(runtime), "unknown"),
      },
      channels: buildChannels({ sessionId, phase, operator }),
    };
    if (!input.refreshColdSource) {
      this.#lastProgressSyncAt = this.context.clock.now();
    }
    this.recordTransition(sourceBase);
    const projection = projectShellCockpitProjection({
      ...sourceBase,
      transitionsSince: this.#transitions,
    });
    this.context.commit(
      {
        type: "cockpit.setProjection",
        projection,
      },
      {
        debounceStatus: false,
        refreshCompletions: false,
        emitChange: input.refreshColdSource,
      },
    );
  }

  private refreshColdSource(input: {
    readonly runtime: HostedRuntimeAdapterPort;
    readonly sessionId: string;
  }): ShellCockpitColdSourceSnapshot {
    const snapshot = buildColdSource({
      runtime: input.runtime,
      sessionId: input.sessionId,
      readRewindTargets: () => this.context.getRewindTargets(),
    });
    this.#coldSourceSnapshot = snapshot;
    return snapshot;
  }

  private readColdSource(input: {
    readonly runtime: HostedRuntimeAdapterPort;
    readonly sessionId: string;
  }): ShellCockpitColdSourceSnapshot {
    // Streaming progress must stay on live in-memory state; cold sources may scan replay history.
    if (this.#coldSourceSnapshot?.sessionId === input.sessionId) {
      return this.#coldSourceSnapshot;
    }
    return buildFallbackColdSource(input);
  }

  private clearProgressTimer(): void {
    this.#progressTimer?.cancel();
    this.#progressTimer = undefined;
  }

  private recordTransition(source: Omit<ShellCockpitProjectionSource, "transitionsSince">): void {
    const nextKind = source.phase.kind;
    if (this.#lastPhaseKind && this.#lastPhaseKind !== nextKind) {
      const latest = latestSourceRef(source);
      this.#transitions.push({
        from: this.#lastPhaseKind,
        to: nextKind,
        sourceRef: latest.ref,
        changedAt: latest.changedAt,
      });
      while (this.#transitions.length > 5) {
        this.#transitions.shift();
      }
    }
    this.#lastPhaseKind = nextKind;
  }
}
