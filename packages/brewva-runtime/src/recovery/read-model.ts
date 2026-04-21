import type {
  BrewvaEventRecord,
  OpenToolCallRecord,
  OpenTurnRecord,
  RecoveryPendingFamily,
  RecoveryPostureSnapshot,
  RecoveryWorkingSetSnapshot,
  SessionUncleanShutdownReason,
  SessionUncleanShutdownDiagnostic,
  TaskState,
} from "../contracts/index.js";
import { asBrewvaToolCallId, asBrewvaToolName } from "../contracts/index.js";
import {
  SESSION_UNCLEAN_SHUTDOWN_RECONCILED_EVENT_TYPE,
  SESSION_SHUTDOWN_EVENT_TYPE,
  SESSION_TURN_TRANSITION_EVENT_TYPE,
  SKILL_ACTIVATED_EVENT_TYPE,
  SKILL_COMPLETED_EVENT_TYPE,
  SKILL_COMPLETION_REJECTED_EVENT_TYPE,
  SKILL_CONTRACT_FAILED_EVENT_TYPE,
  TOOL_CALL_EVENT_TYPE,
  TOOL_CALL_BLOCKED_EVENT_TYPE,
  TOOL_EXECUTION_END_EVENT_TYPE,
  TOOL_EXECUTION_START_EVENT_TYPE,
  TURN_END_EVENT_TYPE,
  TURN_START_EVENT_TYPE,
} from "../events/event-types.js";

type TransitionStatus = "entered" | "completed" | "failed" | "skipped";

// Keep enough transition history to cover multi-family recovery bursts within a
// single turn without making lifecycle snapshots unbounded.
const RECENT_TRANSITIONS_LIMIT = 32;

export interface RecoveryTransitionSnapshot {
  reason: string;
  status: TransitionStatus;
  family: RecoveryPendingFamily | null;
  sourceEventId: string | null;
  sourceEventType: string | null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readToolCallId(
  payload: Record<string, unknown> | null,
): import("../contracts/index.js").BrewvaToolCallId | null {
  const v = payload ? readString(payload.toolCallId) : null;
  return v !== null ? asBrewvaToolCallId(v) : null;
}

function readToolName(
  payload: Record<string, unknown> | null,
): import("../contracts/index.js").BrewvaToolName | null {
  const v = payload ? readString(payload.toolName) : null;
  return v !== null ? asBrewvaToolName(v) : null;
}

function normalizeText(value: string | null | undefined): string | null {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized.length > 0 ? normalized : null;
}

function readTurnNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.max(0, Math.floor(value));
}

function readSkillName(payload: Record<string, unknown> | null): string | null {
  return payload ? readString(payload.skillName) : null;
}

function readUncleanShutdownReason(value: unknown): SessionUncleanShutdownReason | null {
  return value === "open_tool_calls_without_terminal_receipt" ||
    value === "open_turn_without_terminal_receipt" ||
    value === "active_skill_without_terminal_receipt"
    ? value
    : null;
}

function readTransitionStatus(value: unknown): TransitionStatus | null {
  return value === "entered" || value === "completed" || value === "failed" || value === "skipped"
    ? value
    : null;
}

function readRecoveryPendingFamily(value: unknown): RecoveryPendingFamily | null {
  return value === "context" ||
    value === "output_budget" ||
    value === "approval" ||
    value === "delegation" ||
    value === "interrupt" ||
    value === "recovery"
    ? value
    : null;
}

function readOpenToolCallRecord(value: unknown): OpenToolCallRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  const toolCallId =
    readString(candidate.toolCallId) !== null
      ? asBrewvaToolCallId(readString(candidate.toolCallId)!)
      : null;
  const toolName =
    readString(candidate.toolName) !== null
      ? asBrewvaToolName(readString(candidate.toolName)!)
      : null;
  const openedAt =
    typeof candidate.openedAt === "number" && Number.isFinite(candidate.openedAt)
      ? candidate.openedAt
      : null;
  if (!toolCallId || !toolName || openedAt === null) {
    return null;
  }
  const turn = readTurnNumber(candidate.turn);
  const eventId = readString(candidate.eventId) ?? undefined;
  return {
    toolCallId,
    toolName,
    openedAt,
    ...(turn !== undefined ? { turn } : {}),
    ...(eventId ? { eventId } : {}),
  };
}

function readOpenTurnRecord(value: unknown): OpenTurnRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  const turn = readTurnNumber(candidate.turn);
  const startedAt =
    typeof candidate.startedAt === "number" && Number.isFinite(candidate.startedAt)
      ? candidate.startedAt
      : null;
  if (turn === undefined || startedAt === null) {
    return null;
  }
  const eventId = readString(candidate.eventId) ?? undefined;
  return {
    turn,
    startedAt,
    ...(eventId ? { eventId } : {}),
  };
}

function derivePersistedUncleanShutdownDiagnostic(
  events: readonly BrewvaEventRecord[],
): SessionUncleanShutdownDiagnostic | undefined {
  let latest: SessionUncleanShutdownDiagnostic | undefined;
  for (const event of events) {
    if (event.type === SESSION_SHUTDOWN_EVENT_TYPE) {
      latest = undefined;
      continue;
    }
    if (event.type !== SESSION_UNCLEAN_SHUTDOWN_RECONCILED_EVENT_TYPE) {
      if (event.type === SESSION_TURN_TRANSITION_EVENT_TYPE && latest) {
        const payload =
          event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
            ? (event.payload as Record<string, unknown>)
            : null;
        const status = readTransitionStatus(payload?.status);
        const family = readRecoveryPendingFamily(payload?.family);
        if (
          family === "recovery" &&
          (status === "entered" || status === "completed" || status === "skipped")
        ) {
          latest = undefined;
        }
      }
      continue;
    }
    const payload =
      event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
        ? (event.payload as Record<string, unknown>)
        : null;
    if (!payload) {
      continue;
    }
    const reasons = Array.isArray(payload.reasons)
      ? payload.reasons
          .map((entry) => readUncleanShutdownReason(entry))
          .filter((entry): entry is SessionUncleanShutdownReason => entry !== null)
      : [];
    if (reasons.length === 0) {
      continue;
    }
    const openToolCalls = Array.isArray(payload.openToolCalls)
      ? payload.openToolCalls
          .map((entry) => readOpenToolCallRecord(entry))
          .filter((entry): entry is OpenToolCallRecord => entry !== null)
      : [];
    const openTurns = Array.isArray(payload.openTurns)
      ? payload.openTurns
          .map((entry) => readOpenTurnRecord(entry))
          .filter((entry): entry is OpenTurnRecord => entry !== null)
      : [];
    latest = {
      detectedAt:
        typeof payload.detectedAt === "number" && Number.isFinite(payload.detectedAt)
          ? payload.detectedAt
          : event.timestamp,
      reasons,
      openToolCalls,
      ...(openTurns.length > 0 ? { openTurns } : {}),
      ...(typeof payload.latestEventType === "string"
        ? { latestEventType: payload.latestEventType }
        : {}),
      ...(typeof payload.latestEventAt === "number" && Number.isFinite(payload.latestEventAt)
        ? { latestEventAt: payload.latestEventAt }
        : {}),
    };
  }
  return latest;
}

function deriveHasActiveSkillWithoutTerminalReceipt(events: readonly BrewvaEventRecord[]): boolean {
  let activeSkillName: string | null = null;
  for (const event of events) {
    const payload =
      event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
        ? (event.payload as Record<string, unknown>)
        : null;
    if (event.type === SESSION_SHUTDOWN_EVENT_TYPE) {
      activeSkillName = null;
      continue;
    }
    if (event.type === SKILL_ACTIVATED_EVENT_TYPE) {
      activeSkillName = readSkillName(payload);
      continue;
    }
    if (event.type === SKILL_COMPLETION_REJECTED_EVENT_TYPE) {
      const skillName = readSkillName(payload);
      if (!skillName) {
        continue;
      }
      activeSkillName = payload?.phase === "repair_required" ? skillName : null;
      continue;
    }
    if (
      event.type === SKILL_COMPLETED_EVENT_TYPE ||
      event.type === SKILL_CONTRACT_FAILED_EVENT_TYPE
    ) {
      activeSkillName = null;
    }
  }
  return activeSkillName !== null;
}

const DUPLICATE_SIDE_EFFECT_SUPPRESSION_REASON_PREFIXES = [
  "effect_commitment_request_in_flight:",
  "effect_commitment_operator_approval_consumed:",
] as const;

export function deriveDuplicateSideEffectSuppressionCount(
  events: readonly BrewvaEventRecord[],
): number {
  let count = 0;
  for (const event of events) {
    if (event.type !== TOOL_CALL_BLOCKED_EVENT_TYPE) {
      continue;
    }
    const payload =
      event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
        ? (event.payload as Record<string, unknown>)
        : null;
    const reason = payload ? readString(payload.reason) : null;
    if (
      reason &&
      DUPLICATE_SIDE_EFFECT_SUPPRESSION_REASON_PREFIXES.some((prefix) => reason.startsWith(prefix))
    ) {
      count += 1;
    }
  }
  return count;
}

export interface RecoveryCanonicalizationResult {
  mode: "resumable" | "degraded" | "diagnostic_only";
  degradedReason: string | null;
  reasons: SessionUncleanShutdownReason[];
  openToolCalls: OpenToolCallRecord[];
  openTurns: OpenTurnRecord[];
}

export function deriveOpenToolCallsFromEvents(
  events: readonly BrewvaEventRecord[],
): OpenToolCallRecord[] {
  const openToolCalls = new Map<string, OpenToolCallRecord>();
  for (const event of events) {
    const payload =
      event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
        ? (event.payload as Record<string, unknown>)
        : null;
    if (event.type === TOOL_CALL_EVENT_TYPE || event.type === TOOL_EXECUTION_START_EVENT_TYPE) {
      const toolCallId = readToolCallId(payload);
      const toolName = readToolName(payload);
      if (!toolCallId || !toolName) {
        continue;
      }
      openToolCalls.set(toolCallId, {
        toolCallId,
        toolName,
        openedAt: event.timestamp,
        ...(typeof event.turn === "number" && Number.isFinite(event.turn)
          ? { turn: Math.max(0, Math.floor(event.turn)) }
          : {}),
        eventId: event.id,
      });
      continue;
    }
    if (event.type === TOOL_EXECUTION_END_EVENT_TYPE) {
      const toolCallId = readToolCallId(payload);
      if (toolCallId) {
        openToolCalls.delete(toolCallId);
      }
      continue;
    }
    if (event.type === SESSION_SHUTDOWN_EVENT_TYPE) {
      openToolCalls.clear();
    }
  }
  return [...openToolCalls.values()].toSorted(
    (left, right) =>
      left.openedAt - right.openedAt || left.toolCallId.localeCompare(right.toolCallId),
  );
}

export function deriveOpenTurnsFromEvents(events: readonly BrewvaEventRecord[]): OpenTurnRecord[] {
  const openTurns = new Map<number, OpenTurnRecord>();
  for (const event of events) {
    if (typeof event.turn !== "number" || !Number.isFinite(event.turn)) {
      continue;
    }
    const turn = Math.max(0, Math.floor(event.turn));
    if (event.type === TURN_START_EVENT_TYPE) {
      openTurns.set(turn, {
        turn,
        startedAt: event.timestamp,
        eventId: event.id,
      });
      continue;
    }
    if (event.type === TURN_END_EVENT_TYPE) {
      openTurns.delete(turn);
      continue;
    }
    if (event.type === SESSION_SHUTDOWN_EVENT_TYPE) {
      openTurns.clear();
    }
  }
  return [...openTurns.values()].toSorted((left, right) => left.turn - right.turn);
}

export function deriveRecoveryCanonicalization(
  events: readonly BrewvaEventRecord[],
  existingDiagnostic?: SessionUncleanShutdownDiagnostic,
): RecoveryCanonicalizationResult {
  const openToolCalls = deriveOpenToolCallsFromEvents(events);
  const openTurns = deriveOpenTurnsFromEvents(events);
  const persistedDiagnostic =
    existingDiagnostic ?? derivePersistedUncleanShutdownDiagnostic(events);
  if (persistedDiagnostic) {
    return {
      mode: "degraded",
      degradedReason: persistedDiagnostic.reasons.join("+"),
      reasons: [...persistedDiagnostic.reasons],
      openToolCalls,
      openTurns: persistedDiagnostic.openTurns ? [...persistedDiagnostic.openTurns] : openTurns,
    };
  }
  const reasons: SessionUncleanShutdownReason[] = [];
  if (openToolCalls.length > 0) {
    reasons.push("open_tool_calls_without_terminal_receipt");
  }
  if (openTurns.length > 0) {
    reasons.push("open_turn_without_terminal_receipt");
  }
  if (deriveHasActiveSkillWithoutTerminalReceipt(events)) {
    reasons.push("active_skill_without_terminal_receipt");
  }
  if (reasons.length > 0) {
    return {
      mode: "degraded",
      degradedReason: reasons.join("+"),
      reasons,
      openToolCalls,
      openTurns,
    };
  }
  return {
    mode: "resumable",
    degradedReason: null,
    reasons: [],
    openToolCalls,
    openTurns,
  };
}

export interface RecoveryTransitionState {
  latestReason: string | null;
  latestStatus: TransitionStatus | null;
  pendingFamily: RecoveryPendingFamily | null;
  latestSourceEventId: string | null;
  latestSourceEventType: string | null;
  recentTransitions: RecoveryTransitionSnapshot[];
}

export function deriveTransitionState(
  events: readonly BrewvaEventRecord[],
): RecoveryTransitionState {
  const state: RecoveryTransitionState = {
    latestReason: null,
    latestStatus: null,
    pendingFamily: null,
    latestSourceEventId: null,
    latestSourceEventType: null,
    recentTransitions: [],
  };
  const recentByKey = new Map<string, RecoveryTransitionSnapshot & { order: number }>();
  let order = 0;
  for (const event of events) {
    if (event.type !== SESSION_TURN_TRANSITION_EVENT_TYPE) {
      continue;
    }
    const payload =
      event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
        ? (event.payload as Record<string, unknown>)
        : null;
    const reason = payload ? readString(payload.reason) : null;
    const status = readTransitionStatus(payload?.status);
    const family = readRecoveryPendingFamily(payload?.family);
    const sourceEventId = readString(payload?.sourceEventId);
    const sourceEventType = readString(payload?.sourceEventType);
    if (!reason || !status) {
      continue;
    }
    state.latestReason = reason;
    state.latestStatus = status;
    state.pendingFamily = status === "entered" && family ? family : null;
    state.latestSourceEventId = sourceEventId;
    state.latestSourceEventType = sourceEventType;
    const transition: RecoveryTransitionSnapshot = {
      reason,
      status,
      family,
      sourceEventId,
      sourceEventType,
    };
    recentByKey.set(
      `${reason}::${sourceEventId ?? "unknown"}`,
      Object.assign({ order }, transition),
    );
    order += 1;
  }
  state.recentTransitions = [...recentByKey.values()]
    .toSorted((left, right) => right.order - left.order)
    .slice(0, RECENT_TRANSITIONS_LIMIT)
    .map(({ order: _, ...transition }) => transition);
  return state;
}

export function deriveRecoveryPosture(input: {
  events: readonly BrewvaEventRecord[];
  existingDiagnostic?: SessionUncleanShutdownDiagnostic;
  canonicalization?: RecoveryCanonicalizationResult;
  transitionState?: RecoveryTransitionState;
  duplicateSideEffectSuppressionCount?: number;
  historyViewDegradedReason?: string | null;
  historyViewPostureMode?: "degraded" | "diagnostic_only" | null;
}): RecoveryPostureSnapshot {
  const canonicalization =
    input.existingDiagnostic !== undefined
      ? deriveRecoveryCanonicalization(input.events, input.existingDiagnostic)
      : (input.canonicalization ?? deriveRecoveryCanonicalization(input.events));
  const transition = input.transitionState ?? deriveTransitionState(input.events);
  const duplicateSideEffectSuppressionCount = Math.max(
    0,
    Math.trunc(
      input.duplicateSideEffectSuppressionCount ??
        deriveDuplicateSideEffectSuppressionCount(input.events),
    ),
  );

  if (canonicalization.mode === "degraded") {
    return {
      mode: "degraded",
      latestReason: transition.latestReason,
      latestStatus: transition.latestStatus,
      pendingFamily: transition.pendingFamily,
      degradedReason: canonicalization.degradedReason,
      duplicateSideEffectSuppressionCount,
    };
  }

  if (input.historyViewDegradedReason) {
    return {
      mode: input.historyViewPostureMode ?? "degraded",
      latestReason: transition.latestReason,
      latestStatus: transition.latestStatus,
      pendingFamily: transition.pendingFamily,
      degradedReason: input.historyViewDegradedReason,
      duplicateSideEffectSuppressionCount,
    };
  }

  if (transition.pendingFamily || transition.latestStatus === "entered") {
    return {
      mode: "resumable",
      latestReason: transition.latestReason,
      latestStatus: transition.latestStatus,
      pendingFamily: transition.pendingFamily,
      degradedReason: null,
      duplicateSideEffectSuppressionCount,
    };
  }

  return {
    mode: "idle",
    latestReason: null,
    latestStatus: null,
    pendingFamily: null,
    degradedReason: null,
    duplicateSideEffectSuppressionCount,
  };
}

export function deriveRecoveryWorkingSet(input: {
  posture: RecoveryPostureSnapshot;
  taskState: TaskState;
  openToolCalls?: readonly OpenToolCallRecord[];
}): RecoveryWorkingSetSnapshot | undefined {
  if (input.posture.mode !== "resumable" && input.posture.mode !== "degraded") {
    return undefined;
  }
  return {
    latestReason: input.posture.latestReason,
    latestStatus: input.posture.latestStatus,
    pendingFamily: input.posture.pendingFamily,
    taskGoal: normalizeText(input.taskState.spec?.goal),
    taskPhase: normalizeText(input.taskState.status?.phase),
    taskHealth: normalizeText(input.taskState.status?.health),
    acceptanceStatus: normalizeText(input.taskState.acceptance?.status),
    openBlockers: input.taskState.blockers.length,
    openToolCalls: input.openToolCalls?.length ?? 0,
    duplicateSideEffectSuppressionCount: input.posture.duplicateSideEffectSuppressionCount,
    resumeContract:
      "continue from the current working projection and task state; do not replay completed tool side effects unless correctness requires it.",
  };
}

export function buildRecoveryWorkingSetBlock(
  snapshot: RecoveryWorkingSetSnapshot | undefined,
): string | null {
  if (!snapshot) {
    return null;
  }
  const lines = ["[RecoveryWorkingSet]"];
  if (snapshot.latestReason) {
    lines.push(`latest_reason: ${snapshot.latestReason}`);
  }
  if (snapshot.latestStatus) {
    lines.push(`latest_status: ${snapshot.latestStatus}`);
  }
  if (snapshot.pendingFamily) {
    lines.push(`pending_family: ${snapshot.pendingFamily}`);
  }
  if (snapshot.taskGoal) {
    lines.push(`task_goal: ${snapshot.taskGoal}`);
  }
  if (snapshot.taskPhase) {
    lines.push(`task_phase: ${snapshot.taskPhase}`);
  }
  if (snapshot.taskHealth) {
    lines.push(`task_health: ${snapshot.taskHealth}`);
  }
  if (snapshot.acceptanceStatus) {
    lines.push(`acceptance_status: ${snapshot.acceptanceStatus}`);
  }
  if (snapshot.openBlockers > 0) {
    lines.push(`open_blockers: ${snapshot.openBlockers}`);
  }
  if (snapshot.openToolCalls > 0) {
    lines.push(`open_tool_calls: ${snapshot.openToolCalls}`);
  }
  if (snapshot.duplicateSideEffectSuppressionCount > 0) {
    lines.push(
      `duplicate_side_effect_suppression_count: ${snapshot.duplicateSideEffectSuppressionCount}`,
    );
  }
  lines.push(`resume_contract: ${snapshot.resumeContract}`);
  return lines.join("\n");
}
