import { randomUUID } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { BrewvaRuntime, CanonicalEvent } from "@brewva/brewva-runtime";
import {
  classifyToolBoundaryRequest,
  evaluateBoundaryClassification,
  resolveBoundaryPolicy,
} from "@brewva/brewva-runtime/security";
import { toJsonValue } from "@brewva/brewva-std/json";
import type {
  ContextBudgetUsage,
  ContextCompactionGateStatus,
  ContextEvidenceSample,
  ContextStatus,
} from "@brewva/brewva-vocabulary/context";
import type { WorkerResult } from "@brewva/brewva-vocabulary/delegation";
import type { BrewvaEventQuery, ProtocolRecord } from "@brewva/brewva-vocabulary/events";
import type { ResourceLeaseRecord } from "@brewva/brewva-vocabulary/iteration";
import type { BrewvaReplaySession, SessionCostSummary } from "@brewva/brewva-vocabulary/session";
import type { TaskItem, TaskSpec } from "@brewva/brewva-vocabulary/task";
import type { WorkbenchEntry } from "@brewva/brewva-vocabulary/workbench";
import type {
  RuntimeEventRecord,
  RuntimeInputRecorder,
  RuntimeListener,
  RuntimeSemanticRecorder,
  RuntimeSessionRecorder,
  SessionListener,
} from "./runtime-ops-port.js";

type RuntimeEventInput = {
  readonly sessionId?: string;
  readonly payload?: object;
  readonly timestamp?: number;
  readonly turn?: number;
};

export type HostedRuntimeOpsState = {
  readonly subscribers: Set<RuntimeListener>;
  readonly sessionWireSubscribers: Map<string, Set<SessionListener>>;
  readonly operationalSessionIds: Set<string>;
  readonly taskSpecs: Map<string, TaskSpec>;
  readonly taskItems: Map<string, TaskItem[]>;
  readonly taskBlockers: Map<string, ProtocolRecord[]>;
  readonly taskProgressAt: Map<string, number>;
  readonly latestContextEvidence: Map<string, Map<string, ContextEvidenceSample>>;
  readonly resourceLeases: Map<string, ResourceLeaseRecord[]>;
  readonly workbenchEntries: Map<string, WorkbenchEntry[]>;
  readonly activeTaskStalls: Map<
    string,
    {
      readonly detectedAt: number;
      readonly baselineProgressAt: number;
      readonly thresholdMs: number;
      readonly idleMs: number;
    }
  >;
  readonly workerResults: Map<string, WorkerResult[]>;
  readonly clearListeners: Set<(sessionId: string) => void>;
};

export type HostedRuntimeOpsContext = {
  readonly runtime: BrewvaRuntime;
  readonly state: HostedRuntimeOpsState;
  readonly emptyCostSummary: SessionCostSummary;
  readonly emptyContextStatus: ContextStatus;
  readonly emptyContextUsage: ContextBudgetUsage;
  readonly emptyCompactionGateStatus: ContextCompactionGateStatus;
  evaluateRuntimeToolAccess(input: {
    readonly sessionId?: string;
    readonly toolName?: string;
    readonly args?: Record<string, unknown>;
    readonly cwd?: string;
  }): { allowed: boolean; reason?: string; warning?: string };
  explainRuntimeToolAccess(input: unknown): { allowed: boolean; reason?: string; warning?: string };
  emit(
    sessionId: string,
    type: string,
    payload?: object,
    options?: { readonly timestamp?: number; readonly turn?: number },
  ): RuntimeEventRecord;
  emitInput(type: string, input: RuntimeEventInput): RuntimeEventRecord;
  recordProgress(sessionId: string, at?: number): void;
  clearStallIfProgressResumed(sessionId: string, clearedAt?: number): void;
  listEvents(sessionId: string, query?: BrewvaEventQuery): RuntimeEventRecord[];
  queryEvents(sessionId: string, query?: BrewvaEventQuery): RuntimeEventRecord[];
  structuredEvent(event: RuntimeEventRecord): RuntimeEventRecord;
  queryStructuredEvents(sessionId: string, query?: BrewvaEventQuery): RuntimeEventRecord[];
  sessionIds(): string[];
  listReplaySessions(limit?: number): BrewvaReplaySession[];
  toRuntimeEventInput(args: readonly unknown[]): RuntimeEventInput;
  recordSemanticEvent(type: string): RuntimeSemanticRecorder;
  recordSessionPayload(type: string): RuntimeSessionRecorder;
  latestRecordedPayload(sessionId: string, type: string): object | undefined;
  recordInputPayload(type: string): RuntimeInputRecorder;
  readObjectPayload(value: unknown): ProtocolRecord;
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
        ...turnFields(event.turnId),
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
    ...turnFields(event.turnId),
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

function turnFields(turnId: string | undefined): {
  readonly turnId?: string;
  readonly turn?: number;
} {
  if (!turnId) {
    return {};
  }
  const numericTurn = Number(turnId);
  return {
    turnId,
    ...(Number.isFinite(numericTurn) ? { turn: numericTurn } : {}),
  };
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

function readObjectPayload(value: unknown): ProtocolRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as ProtocolRecord)
    : {};
}

function sliceWindow<T>(values: T[], offset: number | null, limit: number | null): T[] {
  let window = values;
  if (offset !== null && offset > 0) {
    window = window.slice(offset);
  }
  if (limit !== null) {
    window = window.slice(0, limit);
  }
  return window;
}

export function createHostedRuntimeOpsContext(options: {
  readonly runtime: BrewvaRuntime;
  readonly listSessionIds?: () => readonly string[];
}): HostedRuntimeOpsContext {
  const state: HostedRuntimeOpsState = {
    subscribers: new Set<RuntimeListener>(),
    sessionWireSubscribers: new Map<string, Set<SessionListener>>(),
    operationalSessionIds: new Set<string>(),
    taskSpecs: new Map<string, TaskSpec>(),
    taskItems: new Map<string, TaskItem[]>(),
    taskBlockers: new Map<string, ProtocolRecord[]>(),
    taskProgressAt: new Map<string, number>(),
    latestContextEvidence: new Map<string, Map<string, ContextEvidenceSample>>(),
    resourceLeases: new Map<string, ResourceLeaseRecord[]>(),
    workbenchEntries: new Map<string, WorkbenchEntry[]>(),
    activeTaskStalls: new Map(),
    workerResults: new Map<string, WorkerResult[]>(),
    clearListeners: new Set<(sessionId: string) => void>(),
  };

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
    state.operationalSessionIds.add(sessionId);
    for (const subscriber of state.subscribers) {
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
    state.taskProgressAt.set(sessionId, at);
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
      if (query?.type && event.type !== query.type) return false;
      if (query?.category && event.category !== query.category) return false;
      if (after !== null && event.timestamp <= after) return false;
      if (before !== null && event.timestamp >= before) return false;
      return true;
    };
    if (last !== null) {
      if (last === 0) return [];
      const tail: RuntimeEventRecord[] = [];
      for (let index = orderedEvents.length - 1; index >= 0; index -= 1) {
        const event = orderedEvents[index];
        if (!event) continue;
        const operationalEvent = canonicalToOperationalEvent(event);
        if (!matchesQuery(operationalEvent)) continue;
        tail.push(operationalEvent);
        if (tail.length >= last) break;
      }
      tail.reverse();
      return sliceWindow(tail, offset, limit);
    }
    const matches = orderedEvents
      .map(canonicalToOperationalEvent)
      .filter((event) => matchesQuery(event));
    return sliceWindow(matches, offset, limit);
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

  function clearStallIfProgressResumed(sessionId: string, clearedAt = Date.now()): void {
    const stall = state.activeTaskStalls.get(sessionId);
    if (!stall) return;
    const progressAt = state.taskProgressAt.get(sessionId);
    if (typeof progressAt !== "number" || progressAt <= stall.detectedAt) return;
    emit(sessionId, "task_stuck_cleared", {
      schema: "brewva.task-watchdog.v1",
      detectedAt: stall.detectedAt,
      baselineProgressAt: stall.baselineProgressAt,
      clearedAt,
      resumedProgressAt: progressAt,
    });
    state.activeTaskStalls.delete(sessionId);
  }

  function sessionIds(): string[] {
    const sessions = new Set<string>([
      ...(options.listSessionIds?.() ?? []),
      ...listDurableTapeSessionIds(options.runtime),
      ...state.operationalSessionIds,
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

  function recordSemanticEvent(type: string): RuntimeSemanticRecorder {
    return (...args: unknown[]) => emitInput(type, toRuntimeEventInput(args));
  }

  function recordSessionPayload(type: string): RuntimeSessionRecorder {
    return (sessionId: string, payload: object | null = {}) => emit(sessionId, type, payload ?? {});
  }

  function latestRecordedPayload(sessionId: string, type: string): object | undefined {
    const latest = listEvents(sessionId, { type, last: 1 })[0]?.payload;
    return latest && typeof latest === "object" && !Array.isArray(latest) ? latest : undefined;
  }

  function recordInputPayload(type: string): RuntimeInputRecorder {
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

  return {
    runtime: options.runtime,
    state,
    emptyCostSummary: EMPTY_COST_SUMMARY,
    emptyContextStatus: EMPTY_CONTEXT_STATUS,
    emptyContextUsage: EMPTY_CONTEXT_USAGE,
    emptyCompactionGateStatus: EMPTY_COMPACTION_GATE_STATUS,
    evaluateRuntimeToolAccess,
    explainRuntimeToolAccess,
    emit,
    emitInput,
    recordProgress,
    clearStallIfProgressResumed,
    listEvents,
    queryEvents,
    structuredEvent,
    queryStructuredEvents,
    sessionIds,
    listReplaySessions,
    toRuntimeEventInput,
    recordSemanticEvent,
    recordSessionPayload,
    latestRecordedPayload,
    recordInputPayload,
    readObjectPayload,
  };
}

export function readStringArrayRecord(value: unknown, key: string): string[] {
  if (!value || typeof value !== "object" || !(key in value)) {
    return [];
  }
  const item = (value as Record<string, unknown>)[key];
  return Array.isArray(item)
    ? item.filter((entry): entry is string => typeof entry === "string")
    : [];
}
