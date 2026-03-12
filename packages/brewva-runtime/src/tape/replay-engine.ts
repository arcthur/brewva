import type { ToolFailureEntry } from "../context/tool-failures.js";
import {
  applyBudgetAlertPayload,
  applyCostUpdatePayload,
  buildCostSummary,
  cloneCostFoldState,
  cloneCostSummary,
  cloneCostSkillLastTurnByName,
  createEmptyCostFoldState,
  recordCostToolCall,
  restoreCostFoldStateFromSummary,
  type CostFoldState,
} from "../cost/fold.js";
import { PROJECTION_REFRESHED_EVENT_TYPE } from "../events/event-types.js";
import {
  TASK_EVENT_TYPE,
  coerceTaskLedgerPayload,
  createEmptyTaskState,
  reduceTaskState,
} from "../task/ledger.js";
import {
  TRUTH_EVENT_TYPE,
  coerceTruthLedgerPayload,
  createEmptyTruthState,
  reduceTruthState,
} from "../truth/ledger.js";
import type { BrewvaEventRecord, SessionCostSummary, TaskState, TruthState } from "../types.js";
import {
  TAPE_ANCHOR_EVENT_TYPE,
  TAPE_CHECKPOINT_EVENT_TYPE,
  coerceTapeCheckpointPayload,
  type TapeCheckpointFailureClassCounts,
  type TapeCheckpointEvidenceState,
  type TapeCheckpointProjectionState,
} from "./events.js";

const TOOL_FAILURE_ANCHOR_TTL = 3;
const MAX_RECENT_TOOL_FAILURES = 48;
const TOOL_FAILURE_INFRASTRUCTURE_TOOLS = new Set([
  "ledger_checkpoint",
  "brewva_cost",
  "brewva_context_compaction",
  "brewva_rollback",
  "brewva_verify",
]);

export interface ReplayToolFailureEntry extends ToolFailureEntry {
  anchorEpoch: number;
  timestamp: number;
}

export interface ReplayEvidenceState {
  totalRecords: number;
  failureRecords: number;
  anchorEpoch: number;
  recentFailures: ReplayToolFailureEntry[];
  failureClassCounts: TapeCheckpointFailureClassCounts;
}

export interface ReplayProjectionState {
  updatedAt: number | null;
  unitCount: number;
}

export interface ReplayCostState {
  summary: SessionCostSummary;
  updatedAt: number | null;
  skillLastTurnByName: Record<string, number>;
}

export interface TurnReplayView {
  turn: number;
  latestEventId: string | null;
  checkpointEventId: string | null;
  taskState: TaskState;
  truthState: TruthState;
  costState: ReplayCostState;
  evidenceState: ReplayEvidenceState;
  projectionState: ReplayProjectionState;
}

interface TurnReplayEngineOptions {
  listEvents: (sessionId: string) => BrewvaEventRecord[];
  getTurn: (sessionId: string) => number;
}

interface InternalTurnReplayView extends TurnReplayView {
  costFoldState: CostFoldState;
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cloneTaskState(state: TaskState): TaskState {
  const spec = state.spec
    ? {
        ...state.spec,
        targets: state.spec.targets
          ? {
              files: state.spec.targets.files ? [...state.spec.targets.files] : undefined,
              symbols: state.spec.targets.symbols ? [...state.spec.targets.symbols] : undefined,
            }
          : undefined,
        constraints: state.spec.constraints ? [...state.spec.constraints] : undefined,
        verification: state.spec.verification
          ? {
              level: state.spec.verification.level,
              commands: state.spec.verification.commands
                ? [...state.spec.verification.commands]
                : undefined,
            }
          : undefined,
      }
    : undefined;

  return {
    spec,
    status: state.status
      ? {
          ...state.status,
          truthFactIds: state.status.truthFactIds ? [...state.status.truthFactIds] : undefined,
        }
      : undefined,
    items: state.items.map((item) => ({ ...item })),
    blockers: state.blockers.map((blocker) => ({ ...blocker })),
    updatedAt: state.updatedAt,
  };
}

function cloneTruthState(state: TruthState): TruthState {
  const cloneDetails = (
    details: TruthState["facts"][number]["details"] | undefined,
  ): TruthState["facts"][number]["details"] =>
    details
      ? (JSON.parse(JSON.stringify(details)) as TruthState["facts"][number]["details"])
      : undefined;

  return {
    facts: state.facts.map((fact) => ({
      ...fact,
      evidenceIds: [...fact.evidenceIds],
      details: cloneDetails(fact.details),
    })),
    updatedAt: state.updatedAt,
  };
}

function toReplayCostState(costFoldState: CostFoldState): ReplayCostState {
  return {
    summary: buildCostSummary(costFoldState),
    updatedAt: costFoldState.updatedAt,
    skillLastTurnByName: cloneCostSkillLastTurnByName(costFoldState.skillLastTurnByName),
  };
}

function createEmptyCostState(): CostFoldState {
  return createEmptyCostFoldState("warn");
}

function createEmptyEvidenceState(): ReplayEvidenceState {
  return {
    totalRecords: 0,
    failureRecords: 0,
    anchorEpoch: 0,
    recentFailures: [],
    failureClassCounts: {
      execution: 0,
      invocation_validation: 0,
      shell_syntax: 0,
      script_composition: 0,
    },
  };
}

function cloneToolFailureEntry(entry: ReplayToolFailureEntry): ReplayToolFailureEntry {
  return {
    ...entry,
    args: JSON.parse(JSON.stringify(entry.args)) as Record<string, unknown>,
  };
}

function createEmptyProjectionState(): ReplayProjectionState {
  return {
    updatedAt: null,
    unitCount: 0,
  };
}

function normalizeToolFailureTurn(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}

function normalizeToolFailureClass(
  value: unknown,
): ReplayToolFailureEntry["failureClass"] | undefined {
  if (value === "execution") return value;
  if (value === "invocation_validation") return value;
  if (value === "shell_syntax") return value;
  if (value === "script_composition") return value;
  return undefined;
}

type FailureClassKey = keyof TapeCheckpointFailureClassCounts;

function incrementFailureClassCount(
  counts: TapeCheckpointFailureClassCounts,
  failureClass: FailureClassKey,
): TapeCheckpointFailureClassCounts {
  return {
    ...counts,
    [failureClass]: (counts[failureClass] ?? 0) + 1,
  };
}

function normalizeNonNegativeNumber(value: unknown, fallback = 0): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(0, value);
}

function normalizeNonNegativeInteger(value: unknown, fallback = 0): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}

function parseFailureContext(
  payload: JsonRecord,
  fallbackTurn: number,
  timestamp: number,
  anchorEpoch: number,
): ReplayToolFailureEntry | null {
  const raw = payload.failureContext;
  if (!isRecord(raw)) return null;
  const toolName =
    typeof payload.toolName === "string" && payload.toolName.trim().length > 0
      ? payload.toolName.trim()
      : "unknown_tool";
  const args = isRecord(raw.args) ? (raw.args as Record<string, unknown>) : {};
  const outputText = typeof raw.outputText === "string" ? raw.outputText : "";
  if (!outputText) return null;
  const turn = normalizeToolFailureTurn(raw.turn, fallbackTurn);
  const failureClass = normalizeToolFailureClass(raw.failureClass);

  return {
    toolName,
    args,
    outputText,
    turn,
    failureClass,
    anchorEpoch,
    timestamp,
  };
}

function pruneToolFailures(
  entries: ReplayToolFailureEntry[],
  anchorEpoch: number,
): ReplayToolFailureEntry[] {
  const pruned = entries.filter(
    (entry) => anchorEpoch - entry.anchorEpoch < TOOL_FAILURE_ANCHOR_TTL,
  );
  if (pruned.length <= MAX_RECENT_TOOL_FAILURES) return pruned;
  return pruned.slice(-MAX_RECENT_TOOL_FAILURES);
}

function reduceEvidenceState(
  state: ReplayEvidenceState,
  payload: JsonRecord,
  timestamp: number,
  eventTurn: number,
): ReplayEvidenceState {
  const verdict =
    payload.verdict === "pass" || payload.verdict === "fail" || payload.verdict === "inconclusive"
      ? payload.verdict
      : null;
  if (!verdict) return state;

  const next: ReplayEvidenceState = {
    ...state,
    totalRecords: state.totalRecords + 1,
    failureRecords: state.failureRecords + (verdict === "fail" ? 1 : 0),
    recentFailures: state.recentFailures.map((entry) => cloneToolFailureEntry(entry)),
    failureClassCounts: { ...state.failureClassCounts },
  };

  if (verdict === "fail") {
    const eventFailureClass: FailureClassKey =
      normalizeToolFailureClass(payload.failureClass) ??
      normalizeToolFailureClass(
        (isRecord(payload.failureContext) ? payload.failureContext : null)?.failureClass,
      ) ??
      "execution";
    next.failureClassCounts = incrementFailureClassCount(
      next.failureClassCounts,
      eventFailureClass,
    );

    const fallbackTurn = normalizeToolFailureTurn(payload.turn, eventTurn);
    const failure = parseFailureContext(payload, fallbackTurn, timestamp, next.anchorEpoch);
    if (failure && !TOOL_FAILURE_INFRASTRUCTURE_TOOLS.has(failure.toolName)) {
      next.recentFailures.push(failure);
      next.recentFailures = pruneToolFailures(next.recentFailures, next.anchorEpoch);
    }
  }
  return next;
}

function reduceProjectionState(
  state: ReplayProjectionState,
  payload: JsonRecord,
  timestamp: number,
): ReplayProjectionState {
  const unitCount = normalizeNonNegativeInteger(payload.unitCount, -1);
  if (unitCount < 0) return state;
  const updatedAt = normalizeNonNegativeNumber(payload.updatedAt, timestamp);

  return {
    updatedAt: Math.max(state.updatedAt ?? 0, updatedAt),
    unitCount,
  };
}

function checkpointEvidenceToReplay(state: TapeCheckpointEvidenceState): ReplayEvidenceState {
  const failureClassCounts = state.failureClassCounts ?? {
    execution: state.failureRecords,
    invocation_validation: 0,
    shell_syntax: 0,
    script_composition: 0,
  };
  const base: ReplayEvidenceState = {
    totalRecords: state.totalRecords,
    failureRecords: state.failureRecords,
    anchorEpoch: state.anchorEpoch,
    recentFailures: state.recentFailures.map((entry) => ({
      toolName: entry.toolName,
      args: JSON.parse(JSON.stringify(entry.args)) as Record<string, unknown>,
      outputText: entry.outputText,
      turn: entry.turn,
      failureClass: entry.failureClass,
      anchorEpoch: entry.anchorEpoch,
      timestamp: entry.timestamp,
    })),
    failureClassCounts: {
      execution: failureClassCounts.execution,
      invocation_validation: failureClassCounts.invocation_validation,
      shell_syntax: failureClassCounts.shell_syntax,
      script_composition: failureClassCounts.script_composition,
    },
  };
  base.recentFailures = pruneToolFailures(base.recentFailures, base.anchorEpoch);
  return base;
}

function checkpointProjectionToReplay(state: TapeCheckpointProjectionState): ReplayProjectionState {
  return {
    updatedAt: state.updatedAt,
    unitCount: state.unitCount,
  };
}

function checkpointCostToReplay(
  summary: SessionCostSummary,
  skillLastTurnByName: Record<string, number>,
): CostFoldState {
  return restoreCostFoldStateFromSummary(summary, skillLastTurnByName);
}

function replayEvidenceToCheckpoint(state: ReplayEvidenceState): TapeCheckpointEvidenceState {
  return {
    totalRecords: state.totalRecords,
    failureRecords: state.failureRecords,
    anchorEpoch: state.anchorEpoch,
    recentFailures: state.recentFailures.map((entry) => ({
      toolName: entry.toolName,
      args: JSON.parse(JSON.stringify(entry.args)) as Record<string, unknown>,
      outputText: entry.outputText,
      turn: entry.turn,
      failureClass: entry.failureClass,
      anchorEpoch: entry.anchorEpoch,
      timestamp: entry.timestamp,
    })),
    failureClassCounts: {
      execution: state.failureClassCounts.execution,
      invocation_validation: state.failureClassCounts.invocation_validation,
      shell_syntax: state.failureClassCounts.shell_syntax,
      script_composition: state.failureClassCounts.script_composition,
    },
  };
}

function replayProjectionToCheckpoint(state: ReplayProjectionState): TapeCheckpointProjectionState {
  return {
    updatedAt: state.updatedAt,
    unitCount: state.unitCount,
  };
}

function applyEventToView(
  previous: InternalTurnReplayView,
  event: BrewvaEventRecord,
  getTurn: (sessionId: string) => number,
): InternalTurnReplayView {
  if (event.type === TAPE_CHECKPOINT_EVENT_TYPE) {
    const payload = coerceTapeCheckpointPayload(event.payload);
    if (!payload) {
      return {
        ...previous,
        turn: getTurn(event.sessionId),
        latestEventId: event.id,
      };
    }
    const costFoldState = checkpointCostToReplay(
      payload.state.cost,
      payload.state.costSkillLastTurnByName,
    );
    return {
      turn: getTurn(event.sessionId),
      latestEventId: event.id,
      checkpointEventId: event.id,
      taskState: cloneTaskState(payload.state.task),
      truthState: cloneTruthState(payload.state.truth),
      costState: toReplayCostState(costFoldState),
      costFoldState,
      evidenceState: checkpointEvidenceToReplay(payload.state.evidence),
      projectionState: checkpointProjectionToReplay(payload.state.projection),
    };
  }

  let taskState = previous.taskState;
  let truthState = previous.truthState;
  let costState = previous.costState;
  let costFoldState = cloneCostFoldState(previous.costFoldState);
  let evidenceState = previous.evidenceState;
  let projectionState = previous.projectionState;

  if (event.type === TASK_EVENT_TYPE) {
    const payload = coerceTaskLedgerPayload(event.payload);
    if (payload) {
      taskState = reduceTaskState(taskState, payload, event.timestamp);
    }
  } else if (event.type === TRUTH_EVENT_TYPE) {
    const payload = coerceTruthLedgerPayload(event.payload);
    if (payload) {
      truthState = reduceTruthState(truthState, payload, event.timestamp);
    }
  } else if (event.type === TAPE_ANCHOR_EVENT_TYPE) {
    const nextAnchorEpoch = evidenceState.anchorEpoch + 1;
    evidenceState = {
      ...evidenceState,
      anchorEpoch: nextAnchorEpoch,
      recentFailures: pruneToolFailures(
        evidenceState.recentFailures.map((entry) => cloneToolFailureEntry(entry)),
        nextAnchorEpoch,
      ),
    };
  } else if (event.type === "tool_result_recorded") {
    if (isRecord(event.payload)) {
      evidenceState = reduceEvidenceState(
        evidenceState,
        event.payload,
        event.timestamp,
        normalizeToolFailureTurn(event.turn, 0),
      );
    }
  } else if (event.type === "tool_call_marked") {
    const payload = isRecord(event.payload) ? event.payload : null;
    const toolName = typeof payload?.toolName === "string" ? payload.toolName.trim() : "";
    if (toolName) {
      recordCostToolCall(costFoldState, {
        toolName,
        turn: normalizeToolFailureTurn(event.turn, 0),
      });
      costState = toReplayCostState(costFoldState);
    }
  } else if (event.type === "cost_update") {
    if (
      applyCostUpdatePayload(
        costFoldState,
        event.payload,
        event.timestamp,
        normalizeToolFailureTurn(event.turn, 0),
      )
    ) {
      costState = toReplayCostState(costFoldState);
    }
  } else if (event.type === "budget_alert") {
    if (applyBudgetAlertPayload(costFoldState, event.payload, event.timestamp)) {
      costState = toReplayCostState(costFoldState);
    }
  } else if (event.type === PROJECTION_REFRESHED_EVENT_TYPE) {
    if (isRecord(event.payload)) {
      projectionState = reduceProjectionState(projectionState, event.payload, event.timestamp);
    }
  }

  return {
    turn: getTurn(event.sessionId),
    latestEventId: event.id,
    checkpointEventId: previous.checkpointEventId,
    taskState,
    truthState,
    costState,
    costFoldState,
    evidenceState,
    projectionState,
  };
}

export class TurnReplayEngine {
  private readonly listEvents: (sessionId: string) => BrewvaEventRecord[];
  private readonly getTurn: (sessionId: string) => number;
  private readonly viewBySession = new Map<string, InternalTurnReplayView>();

  constructor(options: TurnReplayEngineOptions) {
    this.listEvents = options.listEvents;
    this.getTurn = options.getTurn;
  }

  replay(sessionId: string): TurnReplayView {
    const turn = this.getTurn(sessionId);
    const cached = this.viewBySession.get(sessionId);
    if (cached) {
      if (cached.turn !== turn) {
        const withTurn = {
          ...cached,
          turn,
        };
        this.viewBySession.set(sessionId, withTurn);
        return withTurn;
      }
      return cached;
    }

    const events = this.listEvents(sessionId);
    const view = this.buildView(sessionId, events);
    this.viewBySession.set(sessionId, view);
    return view;
  }

  observeEvent(event: BrewvaEventRecord): void {
    const cached = this.viewBySession.get(event.sessionId);
    if (!cached) return;
    if (cached.latestEventId === event.id) return;
    this.viewBySession.set(event.sessionId, applyEventToView(cached, event, this.getTurn));
  }

  getTaskState(sessionId: string): TaskState {
    return cloneTaskState(this.replay(sessionId).taskState);
  }

  getTruthState(sessionId: string): TruthState {
    return cloneTruthState(this.replay(sessionId).truthState);
  }

  getCostSummary(sessionId: string): SessionCostSummary {
    return cloneCostSummary(this.replay(sessionId).costState.summary);
  }

  getCostSkillLastTurnByName(sessionId: string): Record<string, number> {
    return cloneCostSkillLastTurnByName(this.replay(sessionId).costState.skillLastTurnByName);
  }

  getRecentToolFailures(sessionId: string, maxEntries?: number): ToolFailureEntry[] {
    const view = this.replay(sessionId);
    const limit = Math.max(1, Math.floor(maxEntries ?? MAX_RECENT_TOOL_FAILURES));
    return view.evidenceState.recentFailures.slice(-limit).map((entry) => ({
      toolName: entry.toolName,
      args: JSON.parse(JSON.stringify(entry.args)) as Record<string, unknown>,
      outputText: entry.outputText,
      turn: entry.turn,
      failureClass: entry.failureClass,
    }));
  }

  getCheckpointEvidenceState(sessionId: string): TapeCheckpointEvidenceState {
    return replayEvidenceToCheckpoint(this.replay(sessionId).evidenceState);
  }

  getCheckpointProjectionState(sessionId: string): TapeCheckpointProjectionState {
    return replayProjectionToCheckpoint(this.replay(sessionId).projectionState);
  }

  invalidate(sessionId: string): void {
    this.viewBySession.delete(sessionId);
  }

  clear(sessionId: string): void {
    this.invalidate(sessionId);
  }

  hasSession(sessionId: string): boolean {
    return this.viewBySession.has(sessionId);
  }

  private buildView(sessionId: string, events: BrewvaEventRecord[]): InternalTurnReplayView {
    let checkpointIndex = -1;
    let checkpointEventId: string | null = null;
    let taskState: TaskState = createEmptyTaskState();
    let truthState: TruthState = createEmptyTruthState();
    let costFoldState: CostFoldState = createEmptyCostState();
    let costState: ReplayCostState = toReplayCostState(costFoldState);
    let evidenceState: ReplayEvidenceState = createEmptyEvidenceState();
    let projectionState: ReplayProjectionState = createEmptyProjectionState();

    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (event?.type !== TAPE_CHECKPOINT_EVENT_TYPE) continue;
      const payload = coerceTapeCheckpointPayload(event.payload);
      if (!payload) continue;
      checkpointIndex = index;
      checkpointEventId = event.id;
      taskState = cloneTaskState(payload.state.task);
      truthState = cloneTruthState(payload.state.truth);
      costFoldState = checkpointCostToReplay(
        payload.state.cost,
        payload.state.costSkillLastTurnByName,
      );
      costState = toReplayCostState(costFoldState);
      evidenceState = checkpointEvidenceToReplay(payload.state.evidence);
      projectionState = checkpointProjectionToReplay(payload.state.projection);
      break;
    }

    let view: InternalTurnReplayView = {
      turn: this.getTurn(sessionId),
      latestEventId: checkpointEventId,
      checkpointEventId,
      taskState,
      truthState,
      costState,
      costFoldState,
      evidenceState,
      projectionState,
    };

    const replayStartIndex = checkpointIndex >= 0 ? checkpointIndex + 1 : 0;
    for (let index = replayStartIndex; index < events.length; index += 1) {
      const event = events[index];
      if (!event) continue;
      view = applyEventToView(view, event, this.getTurn);
    }
    return view;
  }
}
