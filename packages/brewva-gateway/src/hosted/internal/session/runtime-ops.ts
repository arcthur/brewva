import { randomUUID } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import type { BrewvaRuntime, CanonicalEvent } from "@brewva/brewva-runtime";
import {
  CHANNEL_SESSION_CONVERSATION_BOUND_EVENT_TYPE,
  type ContextBudgetUsage,
  OPERATOR_QUESTION_ANSWERED_EVENT_TYPE,
  deriveTurnEffectCommitmentProjection,
  renderTurnConsequenceDigest,
  parseSkillDocument,
  RECALL_CURATION_RECORDED_EVENT_TYPE,
  RECALL_RESULTS_SURFACED_EVENT_TYPE,
  SCHEDULE_EVENT_TYPE,
  TASK_STALL_ADJUDICATED_EVENT_TYPE,
  TASK_STALL_ADJUDICATION_ERROR_EVENT_TYPE,
  TASK_STUCK_DETECTED_EVENT_TYPE,
} from "@brewva/brewva-runtime/protocol";
import type {
  BrewvaEventQuery,
  BrewvaEventRecord,
  BrewvaReplaySession,
  BrewvaStructuredEvent,
  ClaimState,
  ContextCompactionGateStatus,
  ContextEntryRecord,
  ContextEvidenceSample,
  ContextStatus,
  GuardResultInput,
  GuardResultQuery,
  GuardResultRecord,
  DecideEffectCommitmentInput,
  DecideEffectCommitmentResult,
  DecisionReceipt,
  EffectCommitmentProposal,
  EffectCommitmentRequestRecord,
  ForkPoint,
  MetricObservationInput,
  MetricObservationQuery,
  MetricObservationRecord,
  OpenToolCallRecord,
  PendingEffectCommitmentRequest,
  ProtocolRecord,
  RenderTurnConsequenceDigestOptions,
  SessionCostSummary,
  SessionLifecycleSnapshot,
  SessionLineageNodeRecord,
  SessionLineageTree,
  RecordSessionRewindCheckpointInput,
  SessionRedoInput,
  SessionRedoResult,
  SessionRewindInput,
  SessionRewindResult,
  SessionRewindState,
  SessionRewindTargetView,
  SessionUncleanShutdownDiagnostic,
  SessionWireFrame,
  ProducerContract,
  ReasoningCheckpointRecord,
  ReasoningRevertInput,
  ReasoningRevertRecord,
  RecordReasoningCheckpointInput,
  ScheduleIntentCancelInput,
  ScheduleIntentCancelResult,
  ScheduleIntentCreateInput,
  ScheduleIntentCreateResult,
  ScheduleIntentListQuery,
  ScheduleIntentProjectionRecord,
  ScheduleIntentUpdateInput,
  ScheduleIntentUpdateResult,
  ScheduleProjectionSnapshot,
  SkillDocument,
  SkillRegistryLoadReport,
  TaskAcceptanceRecordResult,
  TaskBlockerRecordResult,
  TaskBlockerResolveResult,
  TaskItem,
  TaskItemAddResult,
  TaskItemStatus,
  TaskItemUpdateResult,
  TaskSpec,
  TaskState,
  TapeHandoffResult,
  TapeLedgerRow,
  TapeSearchResult,
  ToolInvocationStartInput,
  ToolInvocationStartReceipt,
  TurnEffectCommitmentProjection,
  WorkbenchEntry,
} from "@brewva/brewva-runtime/protocol";
import { getToolActionPolicy } from "@brewva/brewva-runtime/protocol";
import type {
  WorkerApplyReport,
  WorkerMergeReport,
  WorkerResult,
} from "@brewva/brewva-runtime/protocol";
import {
  classifyToolBoundaryRequest,
  evaluateBoundaryClassification,
  resolveBoundaryPolicy,
} from "@brewva/brewva-runtime/security";
import { toJsonValue } from "@brewva/brewva-std/json";
import type { BrewvaToolRuntimeCapabilitiesPort } from "@brewva/brewva-tools/contracts";
import type { RecoveryWalStoredRecord } from "../../../daemon/api.js";
import { buildRuntimeTurnSessionWireFrames } from "../../../utils/runtime-session-wire-projection.js";

type RuntimeEventRecord = BrewvaStructuredEvent & BrewvaEventRecord & ProtocolRecord;
type RuntimeListener = (event: RuntimeEventRecord) => void;
type SessionListener = (frame: SessionWireFrame) => void;
type SkillCatalogSnapshot = {
  readonly skills: SkillDocument[];
  readonly report: SkillRegistryLoadReport;
};
type RuntimeEventInput = {
  readonly sessionId?: string;
  readonly payload?: object;
  readonly timestamp?: number;
  readonly turn?: number;
};

const EMPTY_COST_SUMMARY: SessionCostSummary = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  totalTokens: 0,
  totalCostUsd: 0,
  models: {},
  skills: {},
  tools: {},
  alerts: [],
  budget: {
    action: "warn",
    sessionExceeded: false,
    blocked: false,
  },
};

const EMPTY_CONTEXT_STATUS: ContextStatus = Object.freeze({
  tokensUsed: null,
  tokensTotal: 0,
  effectiveTokensTotal: 0,
  tokensRemaining: null,
  autoCompactLimitTokens: 0,
  controllableBaselineTokens: 0,
  controllableTokensUsed: null,
  controllableTokensTotal: 0,
  controllableTokensRemaining: null,
  controllableContextRemainingRatio: null,
  tokensUntilForcedCompact: null,
  predictedTurnGrowthTokens: 0,
  tokensUntilPredictedOverflow: null,
  predictedOverflow: false,
  usageRatio: null,
  hardLimitRatio: 1,
  compactionThresholdRatio: 1,
  compactionAdvised: false,
  forcedCompaction: false,
});

const EMPTY_CONTEXT_USAGE: ContextBudgetUsage = Object.freeze({
  tokens: null,
  contextWindow: 0,
  percent: null,
  maxOutputTokens: null,
});

const EMPTY_COMPACTION_GATE_STATUS: ContextCompactionGateStatus = Object.freeze({
  required: false,
  reason: null,
  status: EMPTY_CONTEXT_STATUS,
  recentCompaction: false,
  windowTurns: 0,
  lastCompactionTurn: null,
  turnsSinceCompaction: null,
});

function canonicalToOperationalEvent(event: CanonicalEvent): RuntimeEventRecord {
  if (event.type === "custom") {
    const payload = event.payload;
    if (
      payload &&
      typeof payload === "object" &&
      "namespace" in payload &&
      "kind" in payload &&
      (payload as { namespace?: unknown }).namespace === "gateway.ops" &&
      typeof (payload as { kind?: unknown }).kind === "string"
    ) {
      return {
        schema: "brewva.event.v1",
        id: event.id,
        sessionId: event.sessionId,
        type: (payload as { kind: string }).kind,
        category: eventCategory((payload as { kind: string }).kind),
        timestamp: event.timestamp,
        isoTime: new Date(event.timestamp).toISOString(),
        turn: event.turnId ? Number(event.turnId) : undefined,
        payload: (payload as { payload?: RuntimeEventRecord["payload"] }).payload,
      } as RuntimeEventRecord;
    }
  }
  return {
    schema: "brewva.event.v1",
    id: event.id,
    sessionId: event.sessionId,
    type: event.type,
    category: eventCategory(event.type),
    timestamp: event.timestamp,
    isoTime: new Date(event.timestamp).toISOString(),
    turn: event.turnId,
    payload: event.payload as RuntimeEventRecord["payload"],
  } as RuntimeEventRecord;
}

function eventCategory(type: string): string {
  if (type.startsWith("session_") || type.startsWith("channel_session_")) return "session";
  if (type.startsWith("tool_") || type.startsWith("tool.")) return "tool";
  if (type.startsWith("task_") || type.startsWith("task.")) return "task";
  if (type.startsWith("cost.") || type === "cost_update") return "cost";
  return "other";
}

function readStringArrayRecord(value: unknown, key: string): string[] {
  if (!value || typeof value !== "object" || !(key in value)) {
    return [];
  }
  const item = (value as Record<string, unknown>)[key];
  return Array.isArray(item)
    ? item.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function collectSkillDocumentPaths(root: string): string[] {
  if (!existsSync(root)) {
    return [];
  }
  const paths: string[] = [];
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const absolutePath = join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(absolutePath);
        continue;
      }
      if (entry.isFile() && entry.name === "SKILL.md") {
        paths.push(absolutePath);
      }
    }
  };
  visit(root);
  return paths.toSorted((left, right) => left.localeCompare(right));
}

function listDurableTapeSessionIds(runtime: BrewvaRuntime): string[] {
  if (!runtime.config.tape.enabled) {
    return [];
  }
  const tapeRoot = join(runtime.identity.workspaceRoot, runtime.config.tape.dir);
  if (!existsSync(tapeRoot)) {
    return [];
  }
  return readdirSync(tapeRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
    .flatMap((entry) => {
      const encoded = entry.name.slice(0, -".jsonl".length);
      try {
        return [decodeURIComponent(encoded)];
      } catch {
        return [];
      }
    })
    .toSorted((left, right) => left.localeCompare(right));
}

function skillCategoryFromPath(root: string, filePath: string): string {
  const [category] = relative(root, filePath).split(/[\\/]/u);
  return category && category.length > 0 ? category : "core";
}

function loadSkillCatalog(workspaceRoot: string): SkillCatalogSnapshot {
  const roots = [
    { root: join(process.cwd(), "skills"), overlay: false },
    { root: join(workspaceRoot, ".brewva", "skills"), overlay: true },
  ];
  const byName = new Map<string, SkillDocument>();
  const overlaySkills = new Set<string>();
  const failed: Array<{ readonly filePath: string; readonly error: string }> = [];

  for (const root of roots) {
    for (const filePath of collectSkillDocumentPaths(root.root)) {
      try {
        const category = skillCategoryFromPath(root.root, filePath);
        const parsed = parseSkillDocument(filePath, category);
        const existing = byName.get(parsed.name);
        const overlayFiles =
          root.overlay || Array.isArray(existing?.overlayFiles)
            ? [...((existing?.overlayFiles as string[] | undefined) ?? [])]
            : [];
        if (root.overlay) {
          overlayFiles.push(filePath);
          overlaySkills.add(parsed.name);
        }
        byName.set(parsed.name, {
          ...existing,
          ...parsed,
          category,
          filePath,
          overlayFiles,
        });
      } catch (error) {
        failed.push({
          filePath,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  const skills = [...byName.values()].toSorted((left, right) =>
    left.name.localeCompare(right.name),
  );
  const loadedSkills = skills.map((skill) => skill.name);
  return {
    skills,
    report: {
      loadedSkills,
      selectableSkills: loadedSkills,
      overlaySkills: [...overlaySkills].toSorted((left, right) => left.localeCompare(right)),
      roots: roots.map((root) => root.root).filter((root) => existsSync(root)),
      projectGuidance: [],
      failed,
    },
  };
}

function readObjectPayload(value: unknown): ProtocolRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as ProtocolRecord)
    : {};
}

function readForkPoint(value: unknown): ForkPoint {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { kind: "session_root" };
  }
  const record = value as ProtocolRecord;
  switch (record.kind) {
    case "reasoning_checkpoint":
      return typeof record.reasoningCheckpointId === "string"
        ? { kind: "reasoning_checkpoint", reasoningCheckpointId: record.reasoningCheckpointId }
        : { kind: "session_root" };
    case "turn":
      return typeof record.turnId === "string"
        ? { kind: "turn", turnId: record.turnId }
        : { kind: "session_root" };
    case "context_entry":
      return typeof record.lineageNodeId === "string" && typeof record.entryId === "string"
        ? { kind: "context_entry", lineageNodeId: record.lineageNodeId, entryId: record.entryId }
        : { kind: "session_root" };
    case "tool_call":
      return typeof record.toolCallId === "string"
        ? { kind: "tool_call", toolCallId: record.toolCallId }
        : { kind: "session_root" };
    case "patch_set":
      return typeof record.patchSetId === "string"
        ? { kind: "patch_set", patchSetId: record.patchSetId }
        : { kind: "session_root" };
    case "worker_run":
      return typeof record.workerRunId === "string"
        ? { kind: "worker_run", workerRunId: record.workerRunId }
        : { kind: "session_root" };
    case "session_root":
      return {
        kind: "session_root",
        parentSessionId:
          typeof record.parentSessionId === "string" ? record.parentSessionId : undefined,
      };
    default:
      return { kind: "session_root" };
  }
}

export function createHostedRuntimeOps(options: {
  readonly runtime: BrewvaRuntime;
  readonly listSessionIds?: () => readonly string[];
}): HostedRuntimeOpsPort {
  const subscribers = new Set<RuntimeListener>();
  const sessionWireSubscribers = new Map<string, Set<SessionListener>>();
  const operationalSessionIds = new Set<string>();
  const taskSpecs = new Map<string, unknown>();
  const taskItems = new Map<string, TaskItem[]>();
  const taskBlockers = new Map<string, ProtocolRecord[]>();
  const taskProgressAt = new Map<string, number>();
  const latestContextEvidence = new Map<string, Map<string, ContextEvidenceSample>>();
  const activeTaskStalls = new Map<
    string,
    {
      readonly detectedAt: number;
      readonly baselineProgressAt: number;
      readonly thresholdMs: number;
      readonly idleMs: number;
    }
  >();
  const workerResults = new Map<string, WorkerResult[]>();
  const clearListeners = new Set<(sessionId: string) => void>();

  function evaluateRuntimeToolAccess(input: {
    readonly sessionId?: string;
    readonly toolName?: string;
    readonly args?: Record<string, unknown>;
    readonly cwd?: string;
  }): { allowed: boolean; reason?: string; warning?: string } {
    const toolName = typeof input.toolName === "string" ? input.toolName : "";
    if (toolName.trim().length === 0) {
      return { allowed: false, reason: "missing_tool_name" };
    }
    const boundary = evaluateBoundaryClassification(
      resolveBoundaryPolicy(options.runtime.config.security),
      classifyToolBoundaryRequest({
        toolName,
        args: input.args,
        cwd: input.cwd,
        workspaceRoot: options.runtime.identity.workspaceRoot,
      }),
    );
    if (!boundary.allowed) {
      return { allowed: false, reason: boundary.reason };
    }
    return { allowed: true };
  }

  function explainRuntimeToolAccess(input: unknown): {
    allowed: boolean;
    reason?: string;
    warning?: string;
  } {
    const record = readObjectPayload(input);
    return evaluateRuntimeToolAccess({
      sessionId: typeof record.sessionId === "string" ? record.sessionId : undefined,
      toolName: typeof record.toolName === "string" ? record.toolName : undefined,
      args: readObjectPayload(record.args),
      cwd: typeof record.cwd === "string" ? record.cwd : undefined,
    });
  }

  function emit(
    sessionId: string,
    type: string,
    payload?: object,
    emitOptions: { readonly timestamp?: number; readonly turn?: number } = {},
  ): RuntimeEventRecord {
    const timestamp = emitOptions.timestamp ?? Date.now();
    const eventId = `ops:${sessionId}:${randomUUID()}`;
    const { event: canonicalEvent } = options.runtime.kernel.recordAdvisoryEvent({
      id: eventId,
      sessionId,
      ...(typeof emitOptions.turn === "number" ? { turnId: String(emitOptions.turn) } : {}),
      timestamp,
      namespace: "gateway.ops",
      kind: type,
      version: 1,
      payload: toJsonValue(payload ?? {}),
    });
    const event = canonicalToOperationalEvent(canonicalEvent);
    operationalSessionIds.add(sessionId);
    for (const subscriber of subscribers) {
      subscriber(event);
    }
    return event;
  }

  function emitInput(type: string, inputValue: RuntimeEventInput): RuntimeEventRecord {
    return emit(inputValue.sessionId ?? "default", type, inputValue.payload, {
      timestamp: inputValue.timestamp,
      turn: inputValue.turn,
    });
  }

  function recordProgress(sessionId: string, at = Date.now()): void {
    taskProgressAt.set(sessionId, at);
  }

  function taskBlockersFor(sessionId: string): { message: string; source?: string }[] {
    const fromTape = listEvents(sessionId, { type: "task.blocker.recorded" }).map(
      (event) => event.payload,
    );
    const blockerSource = fromTape.length > 0 ? fromTape : (taskBlockers.get(sessionId) ?? []);
    return blockerSource
      .map((value) => {
        if (!value || typeof value !== "object") {
          return undefined;
        }
        const record = value as Record<string, unknown>;
        const message = typeof record.message === "string" ? record.message.trim() : "";
        if (!message) {
          return undefined;
        }
        const blockerRecordSource = typeof record.source === "string" ? record.source : undefined;
        return blockerRecordSource ? { message, source: blockerRecordSource } : { message };
      })
      .filter((value): value is { message: string; source?: string } => value !== undefined);
  }

  function sessionWireFramesFor(sessionId: string): SessionWireFrame[] {
    const events = listEvents(sessionId);
    const frames: SessionWireFrame[] = buildRuntimeTurnSessionWireFrames({
      sessionId,
      events,
    });
    for (const event of events) {
      if (event.type === "session_shutdown") {
        const payload =
          event.payload && typeof event.payload === "object"
            ? (event.payload as Record<string, unknown>)
            : {};
        frames.push({
          schema: "brewva.session-wire.v2",
          sessionId,
          frameId: `canonical:${event.id}:session.closed`,
          ts: event.timestamp,
          source: "replay",
          durability: "durable",
          sourceEventId: event.id,
          sourceEventType: event.type,
          type: "session.closed",
          reason: typeof payload.reason === "string" ? payload.reason : undefined,
        });
      }
    }
    return frames.toSorted((left, right) => {
      const leftTs =
        typeof (left as { ts?: unknown }).ts === "number" ? (left as { ts: number }).ts : 0;
      const rightTs =
        typeof (right as { ts?: unknown }).ts === "number" ? (right as { ts: number }).ts : 0;
      return leftTs - rightTs;
    });
  }

  function clearStallIfProgressResumed(sessionId: string, clearedAt = Date.now()): void {
    const stall = activeTaskStalls.get(sessionId);
    if (!stall) return;
    const progressAt = taskProgressAt.get(sessionId);
    if (typeof progressAt !== "number" || progressAt <= stall.detectedAt) return;
    emit(sessionId, "task_stuck_cleared", {
      schema: "brewva.task-watchdog.v1",
      detectedAt: stall.detectedAt,
      baselineProgressAt: stall.baselineProgressAt,
      clearedAt,
      resumedProgressAt: progressAt,
    });
    activeTaskStalls.delete(sessionId);
  }

  function listEvents(sessionId: string, query?: BrewvaEventQuery): RuntimeEventRecord[] {
    const sourceEvents = options.runtime.tape.list(sessionId);
    let orderedEvents = sourceEvents;
    for (let index = 1; index < sourceEvents.length; index += 1) {
      const previous = sourceEvents[index - 1];
      const current = sourceEvents[index];
      if (previous && current && previous.timestamp > current.timestamp) {
        orderedEvents = [...sourceEvents].toSorted(
          (left, right) => left.timestamp - right.timestamp,
        );
        break;
      }
    }

    const after =
      typeof query?.after === "number" && Number.isFinite(query.after)
        ? query.after
        : typeof query?.since === "number" && Number.isFinite(query.since)
          ? query.since
          : null;
    const before =
      typeof query?.before === "number" && Number.isFinite(query.before) ? query.before : null;
    const offset =
      typeof query?.offset === "number" && Number.isFinite(query.offset)
        ? Math.max(0, Math.trunc(query.offset))
        : null;
    const limit =
      typeof query?.limit === "number" && Number.isFinite(query.limit)
        ? Math.max(0, Math.trunc(query.limit))
        : null;
    const last =
      typeof query?.last === "number" && Number.isFinite(query.last)
        ? Math.max(0, Math.trunc(query.last))
        : null;

    const matchesQuery = (event: RuntimeEventRecord): boolean => {
      if (query?.type && event.type !== query.type) {
        return false;
      }
      if (query?.category && event.category !== query.category) {
        return false;
      }
      if (after !== null && event.timestamp <= after) {
        return false;
      }
      if (before !== null && event.timestamp >= before) {
        return false;
      }
      return true;
    };

    if (last !== null) {
      if (last === 0) {
        return [];
      }
      const tail: RuntimeEventRecord[] = [];
      for (let index = orderedEvents.length - 1; index >= 0; index -= 1) {
        const event = orderedEvents[index];
        if (!event) {
          continue;
        }
        const operationalEvent = canonicalToOperationalEvent(event);
        if (!matchesQuery(operationalEvent)) {
          continue;
        }
        tail.push(operationalEvent);
        if (tail.length >= last) {
          break;
        }
      }
      tail.reverse();
      let window = tail;
      if (offset !== null && offset > 0) {
        window = window.slice(offset);
      }
      if (limit !== null) {
        window = window.slice(0, limit);
      }
      return window;
    }

    const matches: RuntimeEventRecord[] = [];
    for (const event of orderedEvents) {
      const operationalEvent = canonicalToOperationalEvent(event);
      if (matchesQuery(operationalEvent)) {
        matches.push(operationalEvent);
      }
    }
    let window = matches;
    if (offset !== null && offset > 0) {
      window = window.slice(offset);
    }
    if (limit !== null) {
      window = window.slice(0, limit);
    }
    return window;
  }

  function queryEvents(sessionId: string, query?: BrewvaEventQuery): RuntimeEventRecord[] {
    return listEvents(sessionId, query);
  }

  function structuredEvent(event: RuntimeEventRecord): RuntimeEventRecord {
    return {
      ...event,
      schema: "brewva.event.v1",
      category: eventCategory(event.type),
      isoTime: new Date(event.timestamp ?? Date.now()).toISOString(),
    } as RuntimeEventRecord;
  }

  function queryStructuredEvents(
    sessionId: string,
    query?: BrewvaEventQuery,
  ): RuntimeEventRecord[] {
    return queryEvents(sessionId, query).map(structuredEvent);
  }

  function scheduleIntentIdFor(event: RuntimeEventRecord, payload: ProtocolRecord): string {
    const intentId = payload.intentId ?? payload.id;
    return typeof intentId === "string" && intentId.trim().length > 0 ? intentId : event.id;
  }

  function scheduleStatusFor(kind: unknown, previousStatus: unknown): string {
    if (kind === "cancelled" || kind === "intent_cancelled") {
      return "cancelled";
    }
    if (kind === "converged" || kind === "intent_converged") {
      return "converged";
    }
    if (typeof previousStatus === "string" && previousStatus.trim().length > 0) {
      return previousStatus;
    }
    return "active";
  }

  function toScheduleIntentProjection(
    input: ProtocolRecord,
    fallbackSessionId: string,
  ): ScheduleIntentProjectionRecord {
    const intentId =
      typeof input.intentId === "string" && input.intentId.trim().length > 0
        ? input.intentId
        : typeof input.id === "string" && input.id.trim().length > 0
          ? input.id
          : `intent-${Date.now()}`;
    return {
      ...input,
      intentId,
      status: typeof input.status === "string" ? input.status : "active",
      reason: typeof input.reason === "string" ? input.reason : "scheduled",
      parentSessionId:
        typeof input.parentSessionId === "string" && input.parentSessionId.trim().length > 0
          ? input.parentSessionId
          : fallbackSessionId,
      continuityMode: typeof input.continuityMode === "string" ? input.continuityMode : "resume",
      ...(typeof input.runAt === "number" ? { runAt: input.runAt } : {}),
      ...(typeof input.nextRunAt === "number" ? { nextRunAt: input.nextRunAt } : {}),
      ...(typeof input.cron === "string" ? { cron: input.cron } : {}),
      ...(typeof input.timeZone === "string" ? { timeZone: input.timeZone } : {}),
      runCount: typeof input.runCount === "number" ? input.runCount : 0,
      maxRuns: typeof input.maxRuns === "number" ? input.maxRuns : 1,
    };
  }

  function listScheduleIntentRows(query?: ProtocolRecord): ProtocolRecord[] {
    const parentSessionId =
      typeof query?.parentSessionId === "string" && query.parentSessionId.trim().length > 0
        ? query.parentSessionId
        : undefined;
    const candidateSessionIds = parentSessionId ? [parentSessionId] : sessionIds();
    const byIntentId = new Map<string, ProtocolRecord>();
    for (const event of candidateSessionIds.flatMap((sessionId) =>
      listEvents(sessionId, { type: SCHEDULE_EVENT_TYPE }),
    )) {
      const payload = readObjectPayload(event.payload);
      const intentId = scheduleIntentIdFor(event, payload);
      const previous = byIntentId.get(intentId);
      const runCount =
        (typeof previous?.runCount === "number" ? previous.runCount : 0) +
        (payload.kind === "fired" || payload.kind === "intent_fired" ? 1 : 0);
      const status = scheduleStatusFor(payload.kind, payload.status ?? previous?.status);
      const maxRuns =
        typeof payload.maxRuns === "number" && Number.isFinite(payload.maxRuns)
          ? Math.max(1, Math.trunc(payload.maxRuns))
          : typeof previous?.maxRuns === "number" && Number.isFinite(previous.maxRuns)
            ? Math.max(1, Math.trunc(previous.maxRuns))
            : 1;
      const nextRunAt =
        status !== "active" || runCount >= maxRuns
          ? undefined
          : typeof payload.nextRunAt === "number" && Number.isFinite(payload.nextRunAt)
            ? Math.trunc(payload.nextRunAt)
            : typeof payload.runAt === "number" && Number.isFinite(payload.runAt)
              ? Math.trunc(payload.runAt)
              : typeof payload.cron === "string" && payload.cron.trim().length > 0
                ? event.timestamp + 60_000
                : undefined;
      byIntentId.set(intentId, {
        ...previous,
        ...payload,
        id: intentId,
        intentId,
        parentSessionId: payload.parentSessionId ?? event.sessionId,
        status,
        runCount,
        nextRunAt,
        lastEventId: event.id,
        updatedAt: event.timestamp,
      });
    }
    return [...byIntentId.values()].toSorted((left, right) => {
      const leftTime = typeof left.updatedAt === "number" ? left.updatedAt : 0;
      const rightTime = typeof right.updatedAt === "number" ? right.updatedAt : 0;
      return rightTime - leftTime;
    });
  }

  function latestPayload(sessionId: string, type: string): ProtocolRecord | undefined {
    const event = listEvents(sessionId, { type, last: 1 })[0];
    const payload = event?.payload;
    return payload && typeof payload === "object" && !Array.isArray(payload) ? payload : undefined;
  }

  function taskSpecFor(sessionId: string): unknown {
    return latestPayload(sessionId, "task.spec.set")?.spec ?? taskSpecs.get(sessionId);
  }

  function claimStateFor(sessionId: string): ClaimState {
    const events = listEvents(sessionId, { type: "claim.upserted" });
    const claimsById = new Map<string, ProtocolRecord>();
    let updatedAt: number | null = null;
    for (const event of events) {
      const payload = event.payload;
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        continue;
      }
      const claim: ProtocolRecord = { status: "active", ...payload };
      const id =
        typeof claim.id === "string" && claim.id.trim().length > 0 ? claim.id : `claim:${event.id}`;
      claimsById.set(id, claim);
      updatedAt = typeof event.timestamp === "number" ? event.timestamp : updatedAt;
    }
    return {
      claims: [...claimsById.values()],
      updatedAt,
    };
  }

  function lastAnchorFor(sessionId: string): ProtocolRecord | string | null {
    const handoff = listEvents(sessionId, { type: "tape.handoff", last: 1 })[0];
    if (handoff) {
      const payload =
        handoff.payload && typeof handoff.payload === "object" && !Array.isArray(handoff.payload)
          ? handoff.payload
          : {};
      return {
        id:
          typeof payload.id === "string" && payload.id.trim().length > 0 ? payload.id : handoff.id,
        ...payload,
      };
    }
    const baseline = options.runtime.tape.replayBaseline(sessionId);
    return baseline.checkpoint?.id ?? null;
  }

  function lineageTreeFor(sessionId: string): SessionLineageTree {
    const nodesById = new Map<string, MutableSessionLineageNodeRecord>();
    for (const event of listEvents(sessionId, { type: "session.lineage.node.created" })) {
      const payload = event.payload;
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        continue;
      }
      const record = payload;
      const lineageNodeId =
        typeof record.lineageNodeId === "string" && record.lineageNodeId.trim().length > 0
          ? record.lineageNodeId
          : undefined;
      if (!lineageNodeId) {
        continue;
      }
      nodesById.set(lineageNodeId, {
        lineageNodeId,
        eventId: event.id,
        timestamp: event.timestamp,
        parentLineageNodeId:
          typeof record.parentLineageNodeId === "string" ? record.parentLineageNodeId : null,
        kind: typeof record.kind === "string" ? record.kind : "branch",
        forkPoint: readForkPoint(record.forkPoint),
        title: typeof record.title === "string" ? record.title : null,
        createdBy: typeof record.createdBy === "string" ? record.createdBy : null,
        summaries: [],
        outcomes: [],
        adoptedOutcomes: [],
      });
    }
    const attach = (type: string, field: "summaries" | "outcomes" | "adoptedOutcomes"): void => {
      for (const event of listEvents(sessionId, { type })) {
        const payload = event.payload;
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
          continue;
        }
        const record = payload;
        const lineageNodeId =
          typeof record.lineageNodeId === "string" && record.lineageNodeId.trim().length > 0
            ? record.lineageNodeId
            : undefined;
        const node = lineageNodeId ? nodesById.get(lineageNodeId) : undefined;
        if (node) {
          const annotated = { ...record, eventId: event.id, timestamp: event.timestamp };
          if (field === "adoptedOutcomes") {
            node.adoptedOutcomes.push(annotated);
          } else if (field === "outcomes") {
            node.outcomes.push(annotated);
          } else {
            node.summaries.push(annotated);
          }
        }
      }
    };
    attach("session.lineage.summary.recorded", "summaries");
    attach("session.lineage.outcome.recorded", "outcomes");
    attach("session.lineage.outcome.adopted", "adoptedOutcomes");

    const nodes = [...nodesById.values()];
    const root =
      nodes.find((node) => node.kind === "main") ??
      nodes.find((node) => !node.parentLineageNodeId) ??
      null;
    if (!root) {
      throw new Error(`session_lineage_root_missing:${sessionId}`);
    }
    const edges = nodes.flatMap((node) =>
      typeof node.parentLineageNodeId === "string" && nodesById.has(node.parentLineageNodeId)
        ? [
            {
              parentLineageNodeId: node.parentLineageNodeId,
              childLineageNodeId: node.lineageNodeId,
            },
          ]
        : [],
    );
    const selectedByChannel: Record<string, string> = {};
    for (const event of listEvents(sessionId, { type: "session.lineage.selection.recorded" })) {
      const payload = event.payload;
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        continue;
      }
      const record = payload;
      if (
        typeof record.channelId === "string" &&
        record.channelId.trim().length > 0 &&
        typeof record.lineageNodeId === "string" &&
        record.lineageNodeId.trim().length > 0
      ) {
        selectedByChannel[record.channelId] = record.lineageNodeId;
      }
    }
    return {
      sessionId,
      rootNodeId: root?.lineageNodeId ?? null,
      nodes,
      edges,
      selectedByChannel,
    };
  }

  function listContextEntryPath(
    sessionId: string,
    inputValue: { readonly entryId?: string | null; readonly lineageNodeId?: string | null } = {},
  ): ContextEntryRecord[] {
    const entries = listEvents(sessionId, { type: "context.entry.recorded" })
      .map<ProtocolRecord | undefined>((event) => {
        const payload = event.payload;
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
          return undefined;
        }
        const record = payload;
        return typeof record.entryId === "string" && record.entryId.trim().length > 0
          ? Object.assign({}, record, { eventId: event.id, timestamp: event.timestamp })
          : undefined;
      })
      .filter((entry): entry is ProtocolRecord => entry !== undefined);
    if (!inputValue.entryId) {
      if (inputValue.lineageNodeId) {
        return entries.filter(
          (entry) => entry.lineageNodeId === inputValue.lineageNodeId,
        ) as ContextEntryRecord[];
      }
      return entries as ContextEntryRecord[];
    }
    const byEntryId = new Map(entries.map((entry) => [String(entry.entryId), entry] as const));
    const path: ProtocolRecord[] = [];
    const seen = new Set<string>();
    let cursor: string | null = inputValue.entryId;
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor);
      const entry = byEntryId.get(cursor);
      if (!entry) {
        break;
      }
      path.push(entry);
      cursor = typeof entry.parentEntryId === "string" ? entry.parentEntryId : null;
    }
    return path.toReversed() as ContextEntryRecord[];
  }

  function sessionIds(): string[] {
    const sessions = new Set<string>([
      ...(options.listSessionIds?.() ?? []),
      ...listDurableTapeSessionIds(options.runtime),
      ...operationalSessionIds,
    ]);
    return [...sessions].toSorted();
  }

  function listReplaySessions(limit?: number): BrewvaReplaySession[] {
    const rows = sessionIds()
      .map((sessionId) => {
        const events = listEvents(sessionId);
        const lastEvent = events.at(-1);
        let titleEvent: RuntimeEventRecord | undefined;
        for (const event of events) {
          if (event.type === "session_title_recorded") {
            titleEvent = event;
          }
        }
        const titlePayload =
          titleEvent?.payload && typeof titleEvent.payload === "object"
            ? (titleEvent.payload as Record<string, unknown>)
            : undefined;
        return {
          sessionId,
          title: typeof titlePayload?.title === "string" ? titlePayload.title : "New session",
          eventCount: events.length,
          lastEventAt: lastEvent?.timestamp ?? 0,
        };
      })
      .filter((row) => row.eventCount > 0)
      .toSorted((left, right) => right.lastEventAt - left.lastEventAt);
    return typeof limit === "number" && Number.isFinite(limit)
      ? rows.slice(0, Math.max(0, Math.trunc(limit)))
      : rows;
  }

  function toRuntimeEventInput(args: readonly unknown[]): RuntimeEventInput {
    const first = args[0];
    if (typeof first === "string") {
      const payload = args[1];
      return {
        sessionId: first,
        payload: payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {},
      };
    }
    if (first && typeof first === "object" && !Array.isArray(first)) {
      return first as RuntimeEventInput;
    }
    return {};
  }

  function recordSemanticEvent(type: string): (...args: unknown[]) => RuntimeEventRecord {
    return (...args: unknown[]) => emitInput(type, toRuntimeEventInput(args));
  }

  function recordSessionPayload(
    type: string,
  ): (sessionId: string, payload?: object | null) => RuntimeEventRecord {
    return (sessionId: string, payload: object | null = {}) => emit(sessionId, type, payload ?? {});
  }

  function latestRecordedPayload(sessionId: string, type: string): object | undefined {
    const latest = listEvents(sessionId, { type, last: 1 })[0]?.payload;
    return latest && typeof latest === "object" && !Array.isArray(latest) ? latest : undefined;
  }

  function recordInputPayload(
    type: string,
  ): (inputValue: { readonly sessionId?: string } & Record<string, unknown>) => RuntimeEventRecord {
    return (inputValue: { readonly sessionId?: string } & Record<string, unknown>) => {
      const { payload, sessionId, timestamp, turn, ...rest } = inputValue;
      const eventPayload =
        payload && typeof payload === "object" && !Array.isArray(payload) ? payload : rest;
      return emit(sessionId ?? "default", type, eventPayload, {
        timestamp: typeof timestamp === "number" ? timestamp : undefined,
        turn: typeof turn === "number" ? turn : undefined,
      });
    };
  }

  const ops = {
    events: {
      recordMetricObservation: recordSessionPayload("iteration.metric.observed"),
      recordGuardResult: recordSessionPayload("iteration.guard.recorded"),
      records: {
        listSessionIds: sessionIds,
        list: listEvents,
        query: queryEvents,
        queryStructured: queryStructuredEvents,
        toStructured: (event: RuntimeEventRecord) => structuredEvent(event),
        subscribe(listener: RuntimeListener) {
          subscribers.add(listener);
          return () => subscribers.delete(listener);
        },
      },
      replay: {
        listSessions: listReplaySessions,
      },
      effects: {
        renderTurnDigest: (_sessionId: string, value: RenderTurnConsequenceDigestOptions = {}) =>
          renderTurnConsequenceDigest(value),
        getTurnProjection: (_sessionId: string, value: RenderTurnConsequenceDigestOptions = {}) =>
          deriveTurnEffectCommitmentProjection(value),
      },
      iteration: {
        listGuardResults: () => [],
        listMetricObservations: () => [],
      },
    },
    cost: {
      summary: {
        get: () => EMPTY_COST_SUMMARY,
      },
      usage: {
        recordAssistant(inputValue: { sessionId?: string; payload?: object }) {
          return emit(inputValue.sessionId ?? "default", "cost.observed", inputValue.payload);
        },
      },
    },
    task: {
      spec: {
        set(sessionId: string, spec: TaskSpec): void {
          taskSpecs.set(sessionId, spec);
          recordProgress(sessionId);
          emit(sessionId, "task.spec.set", { spec });
        },
      },
      state: {
        get(sessionId: string) {
          return {
            spec: taskSpecFor(sessionId),
            status: { phase: "active" },
            acceptance: { status: "pending" },
            items: taskItems.get(sessionId) ?? [],
            blockers: taskBlockersFor(sessionId),
            updatedAt: null,
          };
        },
      },
      items: {
        add(
          sessionId: string,
          item: {
            id?: string;
            text: string;
            status?: TaskItemStatus;
            timestamp?: number;
            turn?: number;
          },
        ): TaskItemAddResult {
          const taskItem: TaskItem = {
            id: item.id ?? `task-item:${sessionId}:${Date.now()}`,
            text: item.text,
            status: item.status,
          };
          const items = taskItems.get(sessionId) ?? [];
          items.push(taskItem);
          taskItems.set(sessionId, items);
          recordProgress(sessionId);
          emit(sessionId, "task.item.added", taskItem, {
            timestamp: item.timestamp,
            turn: item.turn,
          });
          return { ok: true, itemId: taskItem.id, item: taskItem };
        },
        update(
          sessionId: string,
          item: {
            id: string;
            text?: string;
            status?: TaskItemStatus;
            timestamp?: number;
            turn?: number;
          },
        ): TaskItemUpdateResult {
          const itemId = item.id;
          const items = taskItems.get(sessionId) ?? [];
          let updated: TaskItem | undefined;
          const next = items.map((entry) => {
            if (entry.id !== itemId) {
              return entry;
            }
            updated = {
              ...entry,
              text: item.text ?? entry.text,
              status: item.status ?? entry.status,
            };
            return updated;
          });
          taskItems.set(sessionId, next);
          recordProgress(sessionId);
          emit(
            sessionId,
            "task.item.updated",
            {
              id: item.id,
              text: item.text,
              status: item.status,
            },
            { timestamp: item.timestamp, turn: item.turn },
          );
          return updated
            ? { ok: true, itemId, item: updated }
            : { ok: false, reason: `Task item not found: ${itemId}` };
        },
      },
      blockers: {
        record(
          sessionId: string,
          blocker: { id?: string; message: string; source?: string; claimId?: string },
        ): TaskBlockerRecordResult {
          const blockerId = blocker.id ?? `task-blocker:${sessionId}:${Date.now()}`;
          const blockerRecord = { ...blocker, id: blockerId };
          const blockers = taskBlockers.get(sessionId) ?? [];
          blockers.push(blockerRecord);
          taskBlockers.set(sessionId, blockers);
          recordProgress(sessionId);
          emit(sessionId, "task.blocker.recorded", blockerRecord);
          return { ok: true, blockerId };
        },
        resolve(sessionId: string, blockerId: string): TaskBlockerResolveResult {
          const blockers = taskBlockers.get(sessionId) ?? [];
          let removed = false;
          taskBlockers.set(
            sessionId,
            blockers.filter((entry) => {
              const matches =
                entry &&
                typeof entry === "object" &&
                !Array.isArray(entry) &&
                entry.id === blockerId;
              removed ||= matches;
              return !matches;
            }),
          );
          recordProgress(sessionId);
          emit(sessionId, "task.blocker.resolved", { blockerId });
          return removed ? { ok: true, blockerId } : { ok: false, reason: "Blocker not found" };
        },
      },
      target: {
        getDescriptor: () => ({
          primaryRoot: options.runtime.identity.workspaceRoot,
          roots: [options.runtime.identity.workspaceRoot],
        }),
      },
      acceptance: {
        record(
          sessionId: string,
          inputValue: {
            status: "pending" | "accepted" | "rejected";
            decidedBy?: string;
            notes?: string;
          },
        ): TaskAcceptanceRecordResult {
          emit(sessionId, "task.acceptance.recorded", inputValue);
          return { ok: true, status: inputValue.status };
        },
      },
    },
    claim: {
      facts: {
        resolve: () => ({ ok: true }),
        upsert(sessionId: string, claim: object) {
          return emit(sessionId, "claim.upserted", claim);
        },
      },
      state: {
        get: (sessionId: string) => claimStateFor(sessionId),
      },
    },
    tape: {
      status: {
        get(sessionId: string) {
          const baseline = options.runtime.tape.replayBaseline(sessionId);
          const totalEntries = options.runtime.tape.list(sessionId).length;
          const anchor = lastAnchorFor(sessionId);
          const lastAnchor =
            typeof anchor === "string"
              ? { id: anchor }
              : anchor && typeof anchor === "object" && !Array.isArray(anchor)
                ? typeof anchor.id === "string" && anchor.id.trim().length > 0
                  ? {
                      id: anchor.id,
                      name: typeof anchor.name === "string" ? anchor.name : undefined,
                      summary: typeof anchor.summary === "string" ? anchor.summary : undefined,
                      nextSteps:
                        typeof anchor.nextSteps === "string" ? anchor.nextSteps : undefined,
                    }
                  : null
                : null;
          return {
            lastAnchor,
            tapePressure: "none",
            totalEntries,
            entriesSinceAnchor: totalEntries,
            entriesSinceCheckpoint: baseline.events.length,
            thresholds: {
              low: 0.35,
              medium: 0.65,
              high: 0.85,
            },
          };
        },
        getPressureThresholds: () => ({
          low: 0.35,
          medium: 0.65,
          high: 0.85,
        }),
      },
      handoff: {
        record(
          sessionId: string,
          payload: { name: string; summary?: string; nextSteps?: string },
        ): TapeHandoffResult {
          const event = emit(sessionId, "tape.handoff", payload);
          return { ok: true, eventId: event.id, createdAt: event.timestamp };
        },
      },
      search: {
        search: (sessionId: string, query: { query: string; limit?: number }): TapeSearchResult => {
          const needle = (query.query ?? "").trim().toLowerCase();
          const limit = query.limit ?? 20;
          if (!needle) {
            return { matches: [], scannedEvents: 0 };
          }
          const events = options.runtime.tape.list(sessionId);
          const matches = events
            .flatMap((event) => {
              const haystack = JSON.stringify(event).toLowerCase();
              if (!haystack.includes(needle)) {
                return [];
              }
              return [
                {
                  eventId: event.id,
                  type: event.type,
                  turn: event.turnId ?? null,
                  timestamp: event.timestamp,
                  excerpt: haystack.slice(0, 240),
                },
              ];
            })
            .slice(0, limit);
          return { matches, scannedEvents: events.length };
        },
      },
    },
    tools: {
      access: {
        getActionPolicy: (toolName: string) => getToolActionPolicy(toolName),
        check: (sessionId: string, toolName: string, args?: Record<string, unknown>) =>
          evaluateRuntimeToolAccess({ sessionId, toolName, args }),
        explain: explainRuntimeToolAccess,
      },
      actionPolicies: {
        register: recordInputPayload("tool.action-policy.registered"),
        unregister: recordInputPayload("tool.action-policy.unregistered"),
      },
      invocation: {
        start(inputValue: ToolInvocationStartInput): ToolInvocationStartReceipt {
          const access = inputValue.runtimeCapabilityAccess;
          const allowed = access?.allowed ?? true;
          const event = emit(inputValue.sessionId ?? "default", "tool.invocation.started", {
            ...inputValue,
            allowed,
            ...(access?.reason ? { reason: access.reason } : {}),
            ...(access?.advisory ? { advisory: access.advisory } : {}),
          });
          return {
            ...event,
            allowed,
            ...(access?.reason ? { reason: access.reason } : {}),
            ...(access?.advisory ? { advisory: access.advisory } : {}),
          };
        },
        finish(inputValue: { sessionId?: string; callId?: string; toolName?: string }) {
          return emit(inputValue.sessionId ?? "default", "tool.invocation.finished", inputValue);
        },
        recordResult(inputValue: { sessionId?: string; callId?: string; toolName?: string }) {
          return emit(inputValue.sessionId ?? "default", "tool.result.recorded", inputValue);
        },
      },
      recordResult: recordInputPayload("tool.result.recorded"),
      lifecycle: {
        callObserved: recordInputPayload("tool_call_observed"),
        callBlocked: recordInputPayload("tool_call_blocked"),
        boxReleased: recordInputPayload("tool_box_released"),
        executionStarted: recordInputPayload("tool_execution_started"),
        executionEnded: recordInputPayload("tool_execution_ended"),
        parallelRead: recordInputPayload("tool_parallel_read"),
      },
      execution: {
        recordAudit: recordInputPayload("tool_execution_audit"),
      },
      observability: {
        assertionRecorded: recordInputPayload("tool_assertion_recorded"),
        queryExecuted: recordInputPayload("tool_query_executed"),
      },
      operatorQuestions: {
        answerRecorded: recordInputPayload(OPERATOR_QUESTION_ANSWERED_EVENT_TYPE),
        asked: recordInputPayload("operator.question.asked"),
        resolved: recordInputPayload("operator.question.resolved"),
      },
      surface: {
        recordResolved(sessionId: string, payload: object) {
          return emit(sessionId, "tool.surface.resolved", payload);
        },
      },
      capabilitySelection: {
        latest: (sessionId: string) => latestRecordedPayload(sessionId, "tool.capability.selected"),
        record(sessionId: string, payload: object) {
          return emit(sessionId, "tool.capability.selected", payload);
        },
      },
      parallel: {
        acquire: () => ({ accepted: true }),
        acquireAsync: async () => ({ accepted: true }),
        release: () => undefined,
      },
      resourceLeases: {
        request: recordInputPayload("resource_lease_requested"),
        cancel: recordInputPayload("resource_lease_cancelled"),
        list: () => [],
      },
      patches: {
        rollbackLastPatchSet: () => ({ ok: false, reason: "not_available" }),
        redoLastPatchSet: () => ({ ok: false, reason: "not_available" }),
        rollbackLastMutation: () => ({ ok: false, reason: "not_available" }),
      },
      rollbackLastMutation: () => ({ ok: false, reason: "not_available" }),
      readPath: {
        discoveryObserved: recordInputPayload("tool_read_path_discovery_observed"),
        gateArmed: recordInputPayload("tool_read_path_gate_armed"),
        contractWarning: recordInputPayload("tool_read_path_contract_warning"),
      },
      steering: {
        queued: recordSemanticEvent("tool_steering_queued"),
        applied: recordSemanticEvent("tool_steering_applied"),
        dropped: recordSemanticEvent("tool_steering_dropped"),
      },
      tracking: {
        markCall: recordInputPayload("tool_call_marked"),
        trackCallStart: recordInputPayload("tool_call_started"),
        trackCallEnd: recordInputPayload("tool_call_ended"),
      },
      outputs: {
        observed: recordInputPayload("tool_output_observed"),
        distilled: recordInputPayload("tool_output_distilled"),
        artifactPersisted: recordInputPayload("tool_output_artifact_persisted"),
        artifactPersistFailed: recordInputPayload("tool_output_artifact_persist_failed"),
        search: recordInputPayload("tool_output_search"),
        sourceIntelligenceQuery: recordInputPayload("tool_source_intelligence"),
      },
      recall: {
        curationRecorded: recordInputPayload(RECALL_CURATION_RECORDED_EVENT_TYPE),
        resultsSurfaced: recordInputPayload(RECALL_RESULTS_SURFACED_EVENT_TYPE),
      },
      undo: {
        resolveSessionId: (sessionId: string) => sessionId,
      },
    },
    context: {
      usage: {
        get: (_sessionId: string): ContextBudgetUsage | undefined => EMPTY_CONTEXT_USAGE,
        getStatus: (_sessionId: string, _usage?: ContextBudgetUsage): ContextStatus =>
          EMPTY_CONTEXT_STATUS,
        getRatio: (_usage?: ContextBudgetUsage): number | null => null,
        observe: recordSessionPayload("context_usage_observed"),
      },
      compaction: {
        getGateStatus: (
          _sessionId: string,
          _usage?: ContextBudgetUsage,
        ): ContextCompactionGateStatus => EMPTY_COMPACTION_GATE_STATUS,
        getPendingReason: (_sessionId: string): string | null => null,
        getInstructions: (): string => "",
        getHardLimitRatio: (_sessionId?: string, _usage?: ContextBudgetUsage): number =>
          EMPTY_CONTEXT_STATUS.hardLimitRatio ?? 1,
        getThresholdRatio: (_sessionId?: string, _usage?: ContextBudgetUsage): number =>
          EMPTY_CONTEXT_STATUS.compactionThresholdRatio ?? 1,
        resolveEligibility: () => ({
          eligible: false,
          reason: "disabled",
          decision: "skip",
        }),
        getWindowTurns: () => 0,
        rememberDeferredReason(sessionId: string, reason: string | null) {
          return emit(sessionId, "context_compaction_deferred", { reason });
        },
        checkGate: (_sessionId: string, _toolName?: string, _usage?: ContextBudgetUsage) =>
          EMPTY_COMPACTION_GATE_STATUS,
        request(sessionId: string, inputValue?: RuntimeCompactionRequestInput) {
          const payload =
            typeof inputValue === "string"
              ? { reason: inputValue }
              : inputValue && typeof inputValue === "object"
                ? inputValue
                : {};
          return emit(sessionId, "checkpoint.committed", payload);
        },
        checkAndRequest: () => ({
          requested: false,
          required: false,
          reason: "not_required",
          status: EMPTY_CONTEXT_STATUS,
        }),
      },
      evidence: {
        latest(sessionId: string, kind: string) {
          return latestContextEvidence.get(sessionId)?.get(kind);
        },
        append(sessionId: string, payload: object) {
          const record = readObjectPayload(payload);
          const kind = typeof record.kind === "string" ? record.kind : undefined;
          const samplePayload = readObjectPayload(record.payload);
          if (kind) {
            const sessionEvidence = latestContextEvidence.get(sessionId) ?? new Map();
            sessionEvidence.set(kind, {
              kind,
              turn: typeof record.turn === "number" ? record.turn : 0,
              timestamp: typeof record.timestamp === "number" ? record.timestamp : Date.now(),
              payload: samplePayload,
            });
            latestContextEvidence.set(sessionId, sessionEvidence);
          }
          return emit(sessionId, "context_evidence_appended", payload);
        },
      },
      prompt: {
        getHistoryViewBaseline: () => undefined,
      },
      visibleRead: {
        getEpoch: () => 0,
        isCurrent: () => true,
        advanceEpoch: recordSessionPayload("context_visible_read_epoch_advanced"),
        rememberState: recordSessionPayload("context_visible_read_state_remembered"),
      },
      sanitizeInput: (text: string) => text,
      lifecycle: {
        onUserInput: recordSessionPayload("context_user_input"),
        onTurnStart(sessionId: string) {
          clearStallIfProgressResumed(sessionId);
          return emit(sessionId, "turn.started", {});
        },
        onTurnEnd: recordSessionPayload("turn.ended"),
      },
      telemetry: {
        autoCompleted: recordInputPayload("context.compaction.auto.completed"),
        autoFailed: recordInputPayload("context.compaction.auto.failed"),
        autoRequested: recordInputPayload("context.compaction.auto.requested"),
        compactionAdvisory: recordInputPayload("context.compaction.advisory"),
        compactionSkipped: recordInputPayload("context.compaction.skipped"),
        contextComposed: recordInputPayload("context.composed"),
        criticalWithoutCompact: recordInputPayload("context.critical_without_compact"),
        gateCleared: recordInputPayload("context.compaction.gate.cleared"),
        hardGateRequired: recordInputPayload("context.compaction.gate.armed"),
        sessionCompact: recordInputPayload("session.compact"),
      },
    },
    lifecycle: {
      getSnapshot(sessionId: string) {
        return {
          sessionId,
          hydration: "fresh",
          execution: { kind: "idle" },
          integrity: "ok",
          recovery: {
            mode: "idle",
            latestReason: null,
            latestStatus: null,
            pendingFamily: null,
            degradedReason: null,
            duplicateSideEffectSuppressionCount: 0,
            latestSourceEventId: null,
            latestSourceEventType: null,
            recentTransitions: [],
          },
          approval: {
            status: "idle",
            pendingCount: 0,
            requestId: null,
            toolCallId: null,
            toolName: null,
            subject: null,
          },
          tooling: {
            openToolCalls: [],
          },
          summary: {
            kind: "idle",
            reason: null,
            detail: null,
          },
        };
      },
    },
    session: {
      state: {
        clear(sessionId: string) {
          taskSpecs.delete(sessionId);
          taskItems.delete(sessionId);
          taskBlockers.delete(sessionId);
          taskProgressAt.delete(sessionId);
          latestContextEvidence.delete(sessionId);
          activeTaskStalls.delete(sessionId);
          workerResults.delete(sessionId);
          for (const listener of clearListeners) listener(sessionId);
        },
        onClear(listener: (sessionId: string) => void) {
          clearListeners.add(listener);
          return () => clearListeners.delete(listener);
        },
      },
      credentials: {
        resolveBindings: () => ({}),
      },
      lifecycle: {
        agentStarted: recordSemanticEvent("agent_started"),
        agentEnded: recordSemanticEvent("agent_ended"),
        beforeCompact: recordSemanticEvent("before_compact"),
        bootstrap: recordSemanticEvent("session_bootstrap"),
        branchSummaryRecorded: recordSemanticEvent("branch_summary_recorded"),
        compactFailed: recordSemanticEvent("compact_failed"),
        compactRequestFailed: recordSemanticEvent("compact_request_failed"),
        compactRequested: recordSemanticEvent("compact_requested"),
        getHydration: () => ({
          status: "ready",
          hydratedAt: Date.now(),
          latestEventId: null,
          issues: [],
        }),
        getIntegrity: () => ({
          status: "healthy",
          issues: [],
        }),
        getOpenToolCalls: () => [],
        getUncleanShutdownDiagnostic: () => undefined,
        inputObserved: recordSemanticEvent("session_input_observed"),
        messageStarted: recordSemanticEvent("message_start"),
        messageEnded: recordSemanticEvent("message.end"),
        modelPresetSelected: recordSemanticEvent("model_preset_select"),
        modelSelected: recordSemanticEvent("model_select"),
        shutdown: recordSemanticEvent("session_shutdown"),
        started: recordSemanticEvent("session_started"),
        thinkingLevelSelected: recordSemanticEvent("thinking_level_select"),
        turnStarted: recordSemanticEvent("turn_started"),
        turnEnded: recordSemanticEvent("turn_ended"),
      },
      workerResults: {
        list: (sessionId: string): WorkerResult[] => workerResults.get(sessionId) ?? [],
        record(sessionId: string, value: WorkerResult) {
          const next = workerResults.get(sessionId) ?? [];
          next.push(value);
          workerResults.set(sessionId, next);
          return emit(sessionId, "worker.result.recorded", { value });
        },
        clear(sessionId: string) {
          workerResults.delete(sessionId);
          return emit(sessionId, "worker.results.cleared", {});
        },
        applyMerged(sessionId: string, value?: unknown) {
          const workerIds = readStringArrayRecord(value, "workerIds");
          const appliedPaths = readStringArrayRecord(value, "appliedPaths");
          const failedPaths = readStringArrayRecord(value, "failedPaths");
          const status =
            failedPaths.length > 0
              ? ("apply_failed" as const)
              : appliedPaths.length > 0
                ? ("applied" as const)
                : workerIds.length > 0
                  ? ("empty" as const)
                  : ("empty" as const);
          const rawReason =
            typeof value === "object" && value !== null && "reason" in value
              ? (value as { reason?: unknown }).reason
              : undefined;
          const report: WorkerApplyReport = {
            status,
            workerIds,
            appliedPaths,
            failedPaths,
            reason: typeof rawReason === "string" ? rawReason : undefined,
          };
          emit(sessionId, "worker.results.apply_merged", report);
          return report;
        },
        merge(sessionId: string, value?: unknown) {
          const workerIds = readStringArrayRecord(value, "workerIds");
          const stored = workerResults.get(sessionId) ?? [];
          const report: WorkerMergeReport =
            stored.length === 0
              ? { status: "empty", workerIds }
              : { status: "merged", workerIds, mergedPatchSet: undefined };
          emit(sessionId, "worker.results.merged", report);
          return report;
        },
      },
      title: {
        get: () => undefined,
        recordGenerated(sessionId: string, payload: object) {
          return emit(sessionId, "session.title.generated", payload);
        },
      },
      lineage: {
        getNode(sessionId: string, lineageNodeId: string) {
          return (
            lineageTreeFor(sessionId).nodes.find((node) => node.lineageNodeId === lineageNodeId) ??
            undefined
          );
        },
        getTree: lineageTreeFor,
        listChildren(sessionId: string, lineageNodeId: string) {
          const tree = lineageTreeFor(sessionId);
          const childIds = new Set(
            tree.edges
              .filter((edge) => edge.parentLineageNodeId === lineageNodeId)
              .map((edge) => edge.childLineageNodeId),
          );
          return tree.nodes.filter((node) => childIds.has(node.lineageNodeId));
        },
        getContextEntryPath: listContextEntryPath,
        createNode(sessionId: string, payload: object) {
          return emit(sessionId, "session.lineage.node.created", payload);
        },
        recordSummary(sessionId: string, payload: object) {
          return emit(sessionId, "session.lineage.summary.recorded", payload);
        },
        recordContextEntry(sessionId: string, payload: object) {
          return emit(sessionId, "context.entry.recorded", payload);
        },
        recordCapabilityState(sessionId: string, payload: object) {
          return emit(sessionId, "session.lineage.capability-state.recorded", payload);
        },
        recordSelection(sessionId: string, payload: object) {
          return emit(sessionId, "session.lineage.selection.recorded", payload);
        },
        recordOutcome(sessionId: string, payload: object) {
          return emit(sessionId, "session.lineage.outcome.recorded", payload);
        },
        adoptOutcome(sessionId: string, payload: object) {
          return emit(sessionId, "session.lineage.outcome.adopted", payload);
        },
      },
      compaction: {
        commit(sessionId: string, payload: object) {
          return emit(sessionId, "session.compaction.committed", payload);
        },
      },
      mcp: {
        serverConnected: recordInputPayload("mcp_server_connected"),
        serverDisconnected: recordInputPayload("mcp_server_disconnected"),
        toolListRefreshed: recordInputPayload("mcp_tool_list_refreshed"),
        toolCallFailed: recordInputPayload("mcp_tool_call_failed"),
      },
      rewind: {
        getState: () => ({
          checkpoints: [],
          rewindAvailable: false,
          redoAvailable: false,
          redoStack: [],
        }),
        listTargets: () => [],
        recordCheckpoint: recordSessionPayload("session_rewind_checkpoint"),
        rewind: (_sessionId: string, input: SessionRewindInput = {}): SessionRewindResult => ({
          ok: false,
          reason: "no_checkpoint",
          trigger: "rewind",
          mode: input.mode ?? "both",
          summary: input.summary ?? "carry",
        }),
        redo: (): SessionRedoResult => ({ ok: false, reason: "no_redo" }),
      },
      stall: {
        poll(sessionId: string, inputValue: { now?: number; thresholdMs?: number }) {
          if (!taskSpecs.has(sessionId)) return undefined;
          const now = inputValue.now ?? Date.now();
          const baselineProgressAt = taskProgressAt.get(sessionId) ?? now;
          taskProgressAt.set(sessionId, baselineProgressAt);
          const thresholdMs = Math.max(1, Math.trunc(inputValue.thresholdMs ?? 300_000));
          const idleMs = Math.max(0, now - baselineProgressAt);
          if (idleMs <= thresholdMs || activeTaskStalls.has(sessionId)) {
            return undefined;
          }
          const payload = {
            schema: "brewva.task-watchdog.v1",
            thresholdMs,
            baselineProgressAt,
            detectedAt: now,
            idleMs,
            openItemCount: taskItems.get(sessionId)?.length ?? 0,
          };
          activeTaskStalls.set(sessionId, payload);
          return emit(sessionId, TASK_STUCK_DETECTED_EVENT_TYPE, payload, { timestamp: now });
        },
      },
      taskWatchdog: {
        adjudicated: recordSemanticEvent(TASK_STALL_ADJUDICATED_EVENT_TYPE),
        adjudicationError: recordSemanticEvent(TASK_STALL_ADJUDICATION_ERROR_EVENT_TYPE),
      },
    },
    sessionWire: {
      subscribe: (sessionId: string, listener: SessionListener) => {
        const listeners = sessionWireSubscribers.get(sessionId) ?? new Set<SessionListener>();
        listeners.add(listener);
        sessionWireSubscribers.set(sessionId, listeners);
        return () => listeners.delete(listener);
      },
      query: (sessionId: string) => sessionWireFramesFor(sessionId),
    },
    skills: {
      catalog: {
        list: () => loadSkillCatalog(options.runtime.identity.workspaceRoot).skills,
        get: (name: string) =>
          loadSkillCatalog(options.runtime.identity.workspaceRoot).skills.find(
            (skill) => skill.name === name,
          ),
        getLoadReport: () => loadSkillCatalog(options.runtime.identity.workspaceRoot).report,
        listProducers: () => [],
        getProducer: () => undefined,
        refresh: () => loadSkillCatalog(options.runtime.identity.workspaceRoot).report,
      },
      selection: {
        latest: (sessionId: string) => latestRecordedPayload(sessionId, "skill.selection.recorded"),
        record(sessionId: string, payload: object) {
          return emit(sessionId, "skill.selection.recorded", payload);
        },
      },
    },
    proposals: {
      requests: {
        listPending: () => [],
        list: () => [],
        decide: (
          sessionId: string,
          requestId: string,
          input: DecideEffectCommitmentInput,
        ): DecideEffectCommitmentResult => {
          emit(sessionId, "approval.decided", {
            requestId,
            decision: input.decision,
            actor: input.actor,
            reason: input.reason,
          });
          return { requestId, decision: input.decision };
        },
      },
      proposals: {
        list: () => [],
        submit: (sessionId: string, proposal: EffectCommitmentProposal): DecisionReceipt => {
          const receipt: DecisionReceipt = {
            proposalId: proposal.id,
            decision: "defer",
            policyBasis: "runtime_ops",
            reasons: [],
            committedEffects: [],
            evidenceRefs: proposal.evidenceRefs,
            turn: String(Date.now()),
            timestamp: Date.now(),
          };
          emit(sessionId, "proposal.submitted", { proposal, receipt });
          return receipt;
        },
      },
      governance: {
        turnDecisionRecorded: recordInputPayload("proposal.turn_decision_recorded"),
      },
    },
    workbench: {
      commitBaseline: (): WorkbenchEntry[] => [],
      list: (): WorkbenchEntry[] => [],
      note(sessionId: string, payload: object) {
        return emit(sessionId, "workbench.note.recorded", payload);
      },
      evict: recordSessionPayload("workbench.evicted"),
      undoEviction: recordSessionPayload("workbench.eviction_undone"),
    },
    schedule: {
      intents: {
        async create(
          sessionId: string,
          payload: ScheduleIntentCreateInput,
        ): Promise<ScheduleIntentCreateResult> {
          const intent = toScheduleIntentProjection(
            {
              ...payload,
              intentId:
                typeof payload.intentId === "string" && payload.intentId.trim().length > 0
                  ? payload.intentId
                  : `intent-${Date.now()}`,
              status: "active",
              parentSessionId: sessionId,
            },
            sessionId,
          );
          emit(sessionId, SCHEDULE_EVENT_TYPE, { kind: "intent_created", ...intent });
          return { ok: true, intent };
        },
        async update(
          sessionId: string,
          payload: ScheduleIntentUpdateInput,
        ): Promise<ScheduleIntentUpdateResult> {
          emit(sessionId, SCHEDULE_EVENT_TYPE, {
            kind: "intent_updated",
            ...payload,
          });
          const intent = listScheduleIntentRows({
            parentSessionId: sessionId,
          }).find((row) => row.intentId === payload.intentId);
          return { ok: true, intent: toScheduleIntentProjection(intent ?? payload, sessionId) };
        },
        async cancel(
          sessionId: string,
          payload: ScheduleIntentCancelInput,
        ): Promise<ScheduleIntentCancelResult> {
          emit(sessionId, SCHEDULE_EVENT_TYPE, {
            kind: "intent_cancelled",
            ...payload,
          });
          const intent = listScheduleIntentRows({
            parentSessionId: sessionId,
          }).find((row) => row.intentId === payload.intentId);
          return {
            ok: true,
            intent: toScheduleIntentProjection(
              {
                ...(intent ?? payload),
                status: "cancelled",
              },
              sessionId,
            ),
          };
        },
        async getProjectionSnapshot(): Promise<ScheduleProjectionSnapshot> {
          return {
            watermarkOffset: sessionIds().reduce(
              (sum, sessionId) => sum + listEvents(sessionId, { type: SCHEDULE_EVENT_TYPE }).length,
              0,
            ),
          };
        },
        async list(query?: ScheduleIntentListQuery): Promise<ScheduleIntentProjectionRecord[]> {
          return listScheduleIntentRows(query).map((row) =>
            toScheduleIntentProjection(row, "schedule"),
          );
        },
      },
      events: {
        recordIntent(payload: object) {
          const eventPayload = readObjectPayload(payload);
          const sessionId =
            typeof eventPayload.parentSessionId === "string" && eventPayload.parentSessionId
              ? eventPayload.parentSessionId
              : "schedule";
          return emit(sessionId, SCHEDULE_EVENT_TYPE, payload);
        },
        recordRecoveryDeferred(sessionId: string, payload: object) {
          return emit(sessionId, "schedule.recovery.deferred", payload);
        },
        recordRecoverySummary(sessionId: string, payload: object) {
          return emit(sessionId, "schedule.recovery.summary", payload);
        },
        recordWakeup(sessionId: string, payload: object) {
          return emit(sessionId, "schedule.wakeup", payload);
        },
        recordChildStarted(sessionId: string, payload: object) {
          return emit(sessionId, "schedule.child_session.started", payload);
        },
        recordChildFinished(sessionId: string, payload: object) {
          return emit(sessionId, "schedule.child_session.finished", payload);
        },
        recordChildFailed(sessionId: string, payload: object) {
          return emit(sessionId, "schedule.child_session.failed", payload);
        },
      },
    },
    channel: {
      a2a: {
        blocked: recordInputPayload("channel_a2a_blocked"),
        invoked: recordInputPayload("channel_a2a_invoked"),
      },
      agent: {
        created: recordInputPayload("channel_agent_created"),
        deleted: recordInputPayload("channel_agent_deleted"),
        focusChanged: recordInputPayload("channel_agent_focus_changed"),
      },
      command: {
        operatorQuestionAnswered: recordInputPayload("operator.question.answered"),
        received: recordInputPayload("channel_command_received"),
        rejected: recordInputPayload("channel_command_rejected"),
        updateLockBlocked: recordInputPayload("channel_update_lock_blocked"),
        updateRequested: recordInputPayload("channel_update_requested"),
      },
      discussion: {
        round: recordInputPayload("channel_discussion_round"),
      },
      fanout: {
        finished: recordInputPayload("channel_fanout_finished"),
        started: recordInputPayload("channel_fanout_started"),
      },
      ingress: {
        started: recordInputPayload("channel_ingress_started"),
        stopped: recordInputPayload("channel_ingress_stopped"),
      },
      recovery: {
        walAppended: recordInputPayload("channel_recovery_wal_appended"),
        walCompacted: recordInputPayload("channel_recovery_wal_compacted"),
        walRecoveryCompleted: recordInputPayload("channel_recovery_wal_recovery_completed"),
        walStatusChanged: recordInputPayload("channel_recovery_wal_status_changed"),
      },
      runtime: {
        evicted: recordInputPayload("channel_runtime_evicted"),
      },
      session: {
        bound: recordInputPayload("channel.session.bound"),
        conversationBound: recordInputPayload(CHANNEL_SESSION_CONVERSATION_BOUND_EVENT_TYPE),
        workspaceCostSummary: recordInputPayload("channel_session_workspace_cost_summary"),
      },
      turn: {
        approvalTargetUnresolved: recordInputPayload("channel_turn_approval_target_unresolved"),
        bridgeError: recordInputPayload("channel_turn_bridge_error"),
        dispatchEnd: recordInputPayload("channel_turn_dispatch_end"),
        dispatchStart: recordInputPayload("channel_turn_dispatch_start"),
        emitted: recordInputPayload("channel_turn_emitted"),
        ingested: recordInputPayload("channel_turn_ingested"),
        outboundComplete: recordInputPayload("channel_turn_outbound_complete"),
        outboundError: recordInputPayload("channel_turn_outbound_error"),
      },
    },
    delegation: {
      lifecycle: {
        cancelled: recordInputPayload("subagent_cancelled"),
        completed: recordInputPayload("subagent_completed"),
        deliverySurfaced: recordInputPayload("subagent_delivery_surfaced"),
        failed: recordInputPayload("subagent_failed"),
        knowledgeAdoptionRecorded: recordInputPayload("subagent.knowledge_adoption.recorded"),
        outcomeParseFailed: recordInputPayload("subagent_outcome_parse_failed"),
        running: recordInputPayload("subagent_running"),
        spawned: recordInputPayload("subagent_spawned"),
      },
      workerResults: {
        applied: recordInputPayload("delegation_worker_results_applied"),
        applyFailed: recordInputPayload("delegation_worker_results_apply_failed"),
      },
    },
    recovery: {
      getPosture: () => undefined,
      getWorkingSet: () => undefined,
      listPending: () => [],
    },
    verification: {
      checks: {
        evaluate: () => ({ ok: true }),
        verify: () => ({ ok: true }),
      },
    },
    reasoning: {
      checkpoints: {
        get: () => undefined,
        list: () => [],
        record(
          sessionId: string,
          input: RecordReasoningCheckpointInput,
        ): ReasoningCheckpointRecord {
          const record: ReasoningCheckpointRecord = {
            checkpointId:
              typeof input.checkpointId === "string"
                ? input.checkpointId
                : `checkpoint-${Date.now()}`,
            branchId: typeof input.branchId === "string" ? input.branchId : "main",
            boundary: typeof input.boundary === "string" ? input.boundary : "manual",
            leafEntryId: typeof input.leafEntryId === "string" ? input.leafEntryId : null,
          };
          emit(sessionId, "reasoning_checkpoint_recorded", record);
          return record;
        },
      },
      reverts: {
        canRevertTo: () => false,
        list: () => [],
        revert(sessionId: string, input: ReasoningRevertInput): ReasoningRevertRecord {
          const record: ReasoningRevertRecord = {
            revertId: typeof input.revertId === "string" ? input.revertId : `revert-${Date.now()}`,
            toCheckpointId:
              typeof input.toCheckpointId === "string" ? input.toCheckpointId : "unknown",
            fromCheckpointId:
              typeof input.fromCheckpointId === "string" ? input.fromCheckpointId : null,
            trigger: typeof input.trigger === "string" ? input.trigger : "manual",
            newBranchId:
              typeof input.newBranchId === "string" ? input.newBranchId : `branch-${Date.now()}`,
          };
          emit(sessionId, "reasoning_revert_recorded", record);
          return record;
        },
      },
      state: {
        getActive: () => undefined,
      },
    },
    ledger: {
      store: {
        getDigest: () => undefined,
        getPath: () => "",
        listRows: (): TapeLedgerRow[] => [],
        query: () => "",
        verifyIntegrity: () => ({ ok: true, valid: true }),
      },
    },
  };
  return ops as unknown as HostedRuntimeOpsPort;
}

type RuntimeInputRecorder = (
  input: { readonly sessionId?: string } & ProtocolRecord,
) => RuntimeEventRecord;
type RuntimeSessionRecorder = (sessionId: string, payload?: object | null) => RuntimeEventRecord;
type RuntimeDeferredReasonRecorder = (
  sessionId: string,
  reason: string | null,
) => RuntimeEventRecord;
type RuntimeSemanticRecorder = (...args: unknown[]) => RuntimeEventRecord;
type RuntimeStateUnsubscribe = () => boolean;
type RuntimeLineageRecordInput = ProtocolRecord;
type RuntimeCompactionRequestInput = object | string | null;
type RuntimeCompactionRequestResult = {
  readonly requested: boolean;
  readonly required: boolean;
  readonly reason?: string;
  readonly status: ContextStatus;
};
type RuntimeSessionHydration = {
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
type RuntimeSessionIntegrity = {
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
type MutableSessionLineageNodeRecord = Omit<
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
      applyMerged(sessionId: string, input?: unknown): WorkerApplyReport;
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
      getActionPolicy(toolName: string): ReturnType<typeof getToolActionPolicy>;
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
