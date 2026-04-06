import {
  CONTEXT_COMPACTION_GATE_BLOCKED_TOOL_EVENT_TYPE,
  type BrewvaHostedRuntimePort,
  EFFECT_COMMITMENT_APPROVAL_DECIDED_EVENT_TYPE,
  EFFECT_COMMITMENT_APPROVAL_REQUESTED_EVENT_TYPE,
  ROLLBACK_EVENT_TYPE,
  SESSION_SHUTDOWN_EVENT_TYPE,
  SESSION_TURN_TRANSITION_EVENT_TYPE,
  TURN_INPUT_RECORDED_EVENT_TYPE,
  TURN_RENDER_COMMITTED_EVENT_TYPE,
  type BrewvaStructuredEvent,
} from "@brewva/brewva-runtime";
import { recordRuntimeEvent } from "@brewva/brewva-runtime/internal";

export type TurnTransitionReason =
  | "compaction_gate_blocked"
  | "compaction_retry"
  | "effect_commitment_pending"
  | "output_budget_escalation"
  | "provider_fallback_retry"
  | "max_output_recovery"
  | "subagent_delivery_pending"
  | "wal_recovery_resume"
  | "user_submit_interrupt"
  | "signal_interrupt"
  | "timeout_interrupt";

export type HostedTransitionStatus = "entered" | "completed" | "failed" | "skipped";
export type HostedTransitionFamily =
  | "context"
  | "output_budget"
  | "approval"
  | "delegation"
  | "interrupt"
  | "recovery";

export interface SessionTurnTransitionPayload {
  reason: TurnTransitionReason;
  status: HostedTransitionStatus;
  sequence: number;
  family: HostedTransitionFamily;
  attempt: number | null;
  sourceEventId: string | null;
  sourceEventType: string | null;
  error: string | null;
  breakerOpen: boolean;
  model: string | null;
}

interface HostedSessionTransitionState {
  sequence: number;
  latest: SessionTurnTransitionPayload | null;
  pendingFamily: HostedTransitionFamily | null;
  activeTurnNumber: number | null;
  activeAttemptSequence: number | null;
  activeReasons: Partial<Record<TurnTransitionReason, true>>;
  operatorVisibleFactGeneration: number;
  consecutiveFailuresByReason: Partial<Record<BreakerManagedReason, number>>;
  breakerOpenByReason: Partial<Record<BreakerManagedReason, boolean>>;
  hydrated: boolean;
}

type BreakerManagedReason = Extract<
  TurnTransitionReason,
  "compaction_retry" | "provider_fallback_retry" | "max_output_recovery"
>;

export interface HostedTransitionSnapshot {
  sequence: number;
  latest: SessionTurnTransitionPayload | null;
  pendingFamily: HostedTransitionFamily | null;
  activeAttemptSequence: number | null;
  operatorVisibleFactGeneration: number;
  consecutiveFailuresByReason: Partial<Record<BreakerManagedReason, number>>;
  breakerOpenByReason: Partial<Record<BreakerManagedReason, boolean>>;
}

export interface RecordSessionTurnTransitionInput {
  sessionId: string;
  reason: TurnTransitionReason;
  status: HostedTransitionStatus;
  family?: HostedTransitionFamily;
  attempt?: number | null;
  sourceEventId?: string | null;
  sourceEventType?: string | null;
  error?: string | null;
  breakerOpen?: boolean;
  model?: string | null;
  turn?: number;
}

export const HOSTED_TRANSITION_BREAKER_THRESHOLD = 3;

const coordinatorByRuntime = new WeakMap<
  BrewvaHostedRuntimePort,
  HostedTurnTransitionCoordinator
>();
const operatorVisibleEventTypes = new Set<string>([
  "tool_call_blocked",
  CONTEXT_COMPACTION_GATE_BLOCKED_TOOL_EVENT_TYPE,
  EFFECT_COMMITMENT_APPROVAL_REQUESTED_EVENT_TYPE,
  ROLLBACK_EVENT_TYPE,
]);

const transitionReasonFamily: Record<TurnTransitionReason, HostedTransitionFamily> = {
  compaction_gate_blocked: "context",
  compaction_retry: "recovery",
  effect_commitment_pending: "approval",
  output_budget_escalation: "output_budget",
  provider_fallback_retry: "recovery",
  max_output_recovery: "recovery",
  subagent_delivery_pending: "delegation",
  wal_recovery_resume: "recovery",
  user_submit_interrupt: "interrupt",
  signal_interrupt: "interrupt",
  timeout_interrupt: "interrupt",
};

const ATTEMPT_SUPERSESSION_REASONS = new Set<TurnTransitionReason>([
  "output_budget_escalation",
  "compaction_retry",
  "provider_fallback_retry",
  "max_output_recovery",
]);

function parseAttemptIdSequence(value: unknown): number | null {
  if (typeof value !== "string") {
    return null;
  }
  const match = /^attempt-(\d+)$/.exec(value.trim());
  if (!match) {
    return null;
  }
  const parsed = Number.parseInt(match[1] ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function cloneSnapshot(state: HostedSessionTransitionState): HostedTransitionSnapshot {
  return {
    sequence: state.sequence,
    latest: state.latest ? { ...state.latest } : null,
    pendingFamily: state.pendingFamily,
    activeAttemptSequence: state.activeAttemptSequence,
    operatorVisibleFactGeneration: state.operatorVisibleFactGeneration,
    consecutiveFailuresByReason: { ...state.consecutiveFailuresByReason },
    breakerOpenByReason: { ...state.breakerOpenByReason },
  };
}

function resolveActiveHostedTurn(
  state: HostedSessionTransitionState,
  explicitTurn?: number,
): number | undefined {
  if (typeof explicitTurn === "number" && Number.isFinite(explicitTurn)) {
    return explicitTurn;
  }
  return state.activeTurnNumber ?? undefined;
}

function createEmptyState(): HostedSessionTransitionState {
  return {
    sequence: 0,
    latest: null,
    pendingFamily: null,
    activeTurnNumber: null,
    activeAttemptSequence: null,
    activeReasons: {},
    operatorVisibleFactGeneration: 0,
    consecutiveFailuresByReason: {},
    breakerOpenByReason: {},
    hydrated: false,
  };
}

function normalizeString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function normalizeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizeBoolean(value: unknown): boolean {
  return value === true;
}

function isTurnTransitionReason(value: unknown): value is TurnTransitionReason {
  return (
    value === "compaction_gate_blocked" ||
    value === "compaction_retry" ||
    value === "effect_commitment_pending" ||
    value === "output_budget_escalation" ||
    value === "provider_fallback_retry" ||
    value === "max_output_recovery" ||
    value === "subagent_delivery_pending" ||
    value === "wal_recovery_resume" ||
    value === "user_submit_interrupt" ||
    value === "signal_interrupt" ||
    value === "timeout_interrupt"
  );
}

function isHostedTransitionStatus(value: unknown): value is HostedTransitionStatus {
  return value === "entered" || value === "completed" || value === "failed" || value === "skipped";
}

function isHostedTransitionFamily(value: unknown): value is HostedTransitionFamily {
  return (
    value === "context" ||
    value === "output_budget" ||
    value === "approval" ||
    value === "delegation" ||
    value === "interrupt" ||
    value === "recovery"
  );
}

function isBreakerManagedReason(value: TurnTransitionReason): value is BreakerManagedReason {
  return (
    value === "compaction_retry" ||
    value === "provider_fallback_retry" ||
    value === "max_output_recovery"
  );
}

function readTransitionPayload(
  event: Pick<BrewvaStructuredEvent, "payload">,
): SessionTurnTransitionPayload | null {
  const payload = event.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }

  const reason = (payload as { reason?: unknown }).reason;
  const status = (payload as { status?: unknown }).status;
  const sequence = normalizeNumber((payload as { sequence?: unknown }).sequence);
  const family = (payload as { family?: unknown }).family;
  if (
    !isTurnTransitionReason(reason) ||
    !isHostedTransitionStatus(status) ||
    sequence === null ||
    !isHostedTransitionFamily(family)
  ) {
    return null;
  }

  const attempt = normalizeNumber((payload as { attempt?: unknown }).attempt);
  const error = normalizeString((payload as { error?: unknown }).error);
  return {
    reason,
    status,
    sequence,
    family,
    attempt,
    sourceEventId: normalizeString((payload as { sourceEventId?: unknown }).sourceEventId),
    sourceEventType: normalizeString((payload as { sourceEventType?: unknown }).sourceEventType),
    error,
    breakerOpen: normalizeBoolean((payload as { breakerOpen?: unknown }).breakerOpen),
    model: normalizeString((payload as { model?: unknown }).model),
  };
}

function foldObservedHostedTransitionEvent(
  state: HostedSessionTransitionState,
  event: Pick<BrewvaStructuredEvent, "type" | "payload" | "turn">,
): HostedSessionTransitionState {
  if (event.type === TURN_INPUT_RECORDED_EVENT_TYPE) {
    state.activeTurnNumber = typeof event.turn === "number" ? event.turn : state.activeTurnNumber;
    state.activeAttemptSequence = 1;
    return state;
  }
  if (event.type === TURN_RENDER_COMMITTED_EVENT_TYPE) {
    state.activeTurnNumber = null;
    const payload =
      event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
        ? (event.payload as { attemptId?: unknown })
        : undefined;
    state.activeAttemptSequence = parseAttemptIdSequence(payload?.attemptId);
    return state;
  }
  if (operatorVisibleEventTypes.has(event.type)) {
    state.operatorVisibleFactGeneration += 1;
  }
  if (event.type !== SESSION_TURN_TRANSITION_EVENT_TYPE) {
    return state;
  }
  const payload = readTransitionPayload(event);
  if (!payload) {
    return state;
  }
  return foldTransition(state, payload);
}

function foldTransition(
  state: HostedSessionTransitionState,
  payload: SessionTurnTransitionPayload,
): HostedSessionTransitionState {
  state.sequence = Math.max(state.sequence, payload.sequence);
  state.latest = { ...payload };
  if (payload.status === "entered" && ATTEMPT_SUPERSESSION_REASONS.has(payload.reason)) {
    state.activeAttemptSequence = (state.activeAttemptSequence ?? 1) + 1;
  }
  if (payload.status === "entered") {
    state.activeReasons[payload.reason] = true;
    state.pendingFamily = payload.family;
  } else {
    delete state.activeReasons[payload.reason];
    if (
      state.pendingFamily === payload.family &&
      !Object.keys(state.activeReasons).some((reason) => {
        const typedReason = reason as TurnTransitionReason;
        return (
          state.activeReasons[typedReason] === true &&
          transitionReasonFamily[typedReason] === payload.family
        );
      })
    ) {
      state.pendingFamily = null;
    }
  }

  if (isBreakerManagedReason(payload.reason)) {
    if (payload.status === "completed") {
      state.consecutiveFailuresByReason[payload.reason] = 0;
      state.breakerOpenByReason[payload.reason] = false;
    } else if (payload.status === "failed") {
      const failures = (state.consecutiveFailuresByReason[payload.reason] ?? 0) + 1;
      state.consecutiveFailuresByReason[payload.reason] = failures;
      if (failures >= HOSTED_TRANSITION_BREAKER_THRESHOLD) {
        state.breakerOpenByReason[payload.reason] = true;
      }
    } else if (payload.status === "skipped" && payload.breakerOpen) {
      state.breakerOpenByReason[payload.reason] = true;
    }
  }

  return state;
}

class HostedTurnTransitionCoordinator {
  private readonly stateBySession = new Map<string, HostedSessionTransitionState>();
  private readonly unsubscribe: () => void;

  constructor(private readonly runtime: BrewvaHostedRuntimePort) {
    this.unsubscribe = runtime.inspect.events.subscribe((event) => {
      this.handleEvent(event);
    });
  }

  private getOrCreateState(sessionId: string): HostedSessionTransitionState {
    const existing = this.stateBySession.get(sessionId);
    if (existing) {
      return existing;
    }
    const created = createEmptyState();
    this.stateBySession.set(sessionId, created);
    return created;
  }

  private hydrateState(
    sessionId: string,
    state: HostedSessionTransitionState,
    options: {
      excludeEventId?: string;
    } = {},
  ): void {
    if (!state.hydrated) {
      state.hydrated = true;
      const persisted = this.runtime.inspect.events.queryStructured(sessionId);
      for (const event of persisted) {
        if (options.excludeEventId && event.id === options.excludeEventId) {
          continue;
        }
        foldObservedHostedTransitionEvent(state, event);
      }
    }
  }

  private getState(sessionId: string): HostedSessionTransitionState {
    const state = this.getOrCreateState(sessionId);
    this.hydrateState(sessionId, state);
    return state;
  }

  private handleEvent(event: BrewvaStructuredEvent): void {
    const state = this.getOrCreateState(event.sessionId);
    this.hydrateState(event.sessionId, state, {
      excludeEventId: event.id,
    });
    if (event.type === SESSION_SHUTDOWN_EVENT_TYPE) {
      this.stateBySession.delete(event.sessionId);
      return;
    }

    foldObservedHostedTransitionEvent(state, event);
    if (event.type === SESSION_TURN_TRANSITION_EVENT_TYPE) {
      return;
    }

    if (event.type === CONTEXT_COMPACTION_GATE_BLOCKED_TOOL_EVENT_TYPE) {
      if (state.activeReasons.compaction_gate_blocked === true) {
        return;
      }
      this.record({
        sessionId: event.sessionId,
        turn: event.turn,
        reason: "compaction_gate_blocked",
        status: "entered",
        family: "context",
        sourceEventId: event.id,
        sourceEventType: event.type,
      });
      return;
    }

    if (event.type === "context_compaction_gate_cleared") {
      if (state.activeReasons.compaction_gate_blocked !== true) {
        return;
      }
      this.record({
        sessionId: event.sessionId,
        turn: event.turn,
        reason: "compaction_gate_blocked",
        status: "completed",
        family: "context",
        sourceEventId: event.id,
        sourceEventType: event.type,
      });
      return;
    }

    if (event.type === EFFECT_COMMITMENT_APPROVAL_REQUESTED_EVENT_TYPE) {
      if (state.activeReasons.effect_commitment_pending === true) {
        return;
      }
      this.record({
        sessionId: event.sessionId,
        turn: event.turn,
        reason: "effect_commitment_pending",
        status: "entered",
        family: "approval",
        sourceEventId: event.id,
        sourceEventType: event.type,
      });
      return;
    }

    if (event.type === EFFECT_COMMITMENT_APPROVAL_DECIDED_EVENT_TYPE) {
      if (state.activeReasons.effect_commitment_pending !== true) {
        return;
      }
      this.record({
        sessionId: event.sessionId,
        turn: event.turn,
        reason: "effect_commitment_pending",
        status: "completed",
        family: "approval",
        sourceEventId: event.id,
        sourceEventType: event.type,
      });
    }
  }

  captureOperatorVisibleCheckpoint(sessionId: string): number {
    return this.getState(sessionId).operatorVisibleFactGeneration;
  }

  hasOperatorVisibleFactSince(sessionId: string, checkpoint: number): boolean {
    return this.getState(sessionId).operatorVisibleFactGeneration > checkpoint;
  }

  isBreakerOpen(sessionId: string, reason: BreakerManagedReason): boolean {
    return this.getState(sessionId).breakerOpenByReason[reason] === true;
  }

  getFailureCount(sessionId: string, reason: BreakerManagedReason): number {
    return this.getState(sessionId).consecutiveFailuresByReason[reason] ?? 0;
  }

  getSnapshot(sessionId: string): HostedTransitionSnapshot {
    return cloneSnapshot(this.getState(sessionId));
  }

  getActiveAttemptSequence(sessionId: string): number | null {
    return this.getState(sessionId).activeAttemptSequence;
  }

  record(input: RecordSessionTurnTransitionInput): void {
    const state = this.getState(input.sessionId);
    const family = input.family ?? transitionReasonFamily[input.reason];
    const sequence = state.sequence + 1;
    recordRuntimeEvent(this.runtime, {
      sessionId: input.sessionId,
      turn: resolveActiveHostedTurn(state, input.turn),
      type: SESSION_TURN_TRANSITION_EVENT_TYPE,
      payload: {
        reason: input.reason,
        status: input.status,
        sequence,
        family,
        attempt: input.attempt ?? null,
        sourceEventId: input.sourceEventId ?? null,
        sourceEventType: input.sourceEventType ?? null,
        error: input.error ?? null,
        breakerOpen: input.breakerOpen === true,
        model: input.model ?? null,
      } satisfies SessionTurnTransitionPayload,
    });
  }

  dispose(): void {
    this.unsubscribe();
    this.stateBySession.clear();
    coordinatorByRuntime.delete(this.runtime);
  }
}

export function getHostedTurnTransitionCoordinator(
  runtime: BrewvaHostedRuntimePort,
): HostedTurnTransitionCoordinator {
  const existing = coordinatorByRuntime.get(runtime);
  if (existing) {
    return existing;
  }
  const created = new HostedTurnTransitionCoordinator(runtime);
  coordinatorByRuntime.set(runtime, created);
  return created;
}

export function recordSessionTurnTransition(
  runtime: BrewvaHostedRuntimePort,
  input: RecordSessionTurnTransitionInput,
): void {
  getHostedTurnTransitionCoordinator(runtime).record(input);
}

export function projectHostedTransitionSnapshot(
  events: Iterable<Pick<BrewvaStructuredEvent, "type" | "payload" | "turn">>,
): HostedTransitionSnapshot {
  const state = createEmptyState();
  state.hydrated = true;
  for (const event of events) {
    foldObservedHostedTransitionEvent(state, event);
  }
  return cloneSnapshot(state);
}

export const TURN_TRANSITION_TEST_ONLY = {
  createEmptyState,
  foldObservedHostedTransitionEvent,
  foldTransition,
  projectHostedTransitionSnapshot,
  readTransitionPayload,
};
