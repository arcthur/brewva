import { asBrewvaToolCallId, asBrewvaToolName } from "../../core/identifiers.js";
import {
  readSessionTurnTransitionEventPayload,
  readSessionUncleanShutdownDiagnosticEventPayload,
  readToolCallBlockedEventPayload,
  readToolLifecycleEventPayload,
} from "../../events/descriptors.js";
import {
  SESSION_UNCLEAN_SHUTDOWN_RECONCILED_EVENT_TYPE,
  SESSION_SHUTDOWN_EVENT_TYPE,
  SESSION_TURN_TRANSITION_EVENT_TYPE,
  TOOL_CALL_EVENT_TYPE,
  TOOL_CALL_BLOCKED_EVENT_TYPE,
  TOOL_EXECUTION_END_EVENT_TYPE,
  TOOL_EXECUTION_START_EVENT_TYPE,
  TURN_END_EVENT_TYPE,
  TURN_START_EVENT_TYPE,
} from "../../events/registry.js";
import type { BrewvaEventRecord } from "../../events/types.js";
import type {
  RecoveryPendingFamily,
  RecoveryPostureSnapshot,
  RecoveryWorkingSetSnapshot,
} from "../context/api.js";
import type {
  OpenToolCallRecord,
  OpenTurnRecord,
  SessionUncleanShutdownDiagnostic,
  SessionUncleanShutdownReason,
} from "../sessions/api.js";
import type { TaskState } from "../task/api.js";

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

function normalizeText(value: string | null | undefined): string | null {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized.length > 0 ? normalized : null;
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
        const payload = readSessionTurnTransitionEventPayload(event);
        const status = payload?.status ?? null;
        const family = payload?.family ?? null;
        if (
          family === "recovery" &&
          (status === "entered" || status === "completed" || status === "skipped")
        ) {
          latest = undefined;
        }
      }
      continue;
    }
    const payload = readSessionUncleanShutdownDiagnosticEventPayload(event);
    if (!payload) {
      continue;
    }
    latest = {
      ...payload,
      detectedAt: payload.detectedAt || event.timestamp,
    };
  }
  return latest;
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
    const payload = readToolCallBlockedEventPayload(event);
    const reason = payload?.reason ?? null;
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
    const payload = readToolLifecycleEventPayload(event);
    if (event.type === TOOL_CALL_EVENT_TYPE || event.type === TOOL_EXECUTION_START_EVENT_TYPE) {
      const toolCallId = payload?.toolCallId ? asBrewvaToolCallId(payload.toolCallId) : null;
      const toolName = payload?.toolName ? asBrewvaToolName(payload.toolName) : null;
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
      const toolCallId = payload?.toolCallId ? asBrewvaToolCallId(payload.toolCallId) : null;
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
    const payload = readSessionTurnTransitionEventPayload(event);
    if (!payload) {
      continue;
    }
    state.latestReason = payload.reason;
    state.latestStatus = payload.status;
    state.pendingFamily = payload.status === "entered" && payload.family ? payload.family : null;
    state.latestSourceEventId = payload.sourceEventId;
    state.latestSourceEventType = payload.sourceEventType;
    const transition: RecoveryTransitionSnapshot = {
      reason: payload.reason,
      status: payload.status,
      family: payload.family,
      sourceEventId: payload.sourceEventId,
      sourceEventType: payload.sourceEventType,
    };
    recentByKey.set(
      `${payload.reason}::${payload.sourceEventId ?? "unknown"}`,
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
