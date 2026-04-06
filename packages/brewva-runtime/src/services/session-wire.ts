import {
  SESSION_WIRE_SCHEMA,
  type BrewvaEventRecord,
  type BrewvaStructuredEvent,
  type SessionWireAttemptReason,
  type SessionWireCommittedStatus,
  type SessionWireFrame,
  type SessionWireSource,
  type SessionWireTransitionFamily,
  type SessionWireTransitionStatus,
  type ToolOutputView,
  type TurnInputRecordedPayload,
  type TurnRenderCommittedPayload,
} from "../contracts/index.js";
import {
  EFFECT_COMMITMENT_APPROVAL_DECIDED_EVENT_TYPE,
  EFFECT_COMMITMENT_APPROVAL_REQUESTED_EVENT_TYPE,
  SESSION_SHUTDOWN_EVENT_TYPE,
  SESSION_TURN_TRANSITION_EVENT_TYPE,
  SUBAGENT_CANCELLED_EVENT_TYPE,
  SUBAGENT_COMPLETED_EVENT_TYPE,
  SUBAGENT_FAILED_EVENT_TYPE,
  SUBAGENT_RUNNING_EVENT_TYPE,
  SUBAGENT_SPAWNED_EVENT_TYPE,
  TURN_INPUT_RECORDED_EVENT_TYPE,
  TURN_RENDER_COMMITTED_EVENT_TYPE,
} from "../events/event-types.js";
import { readBrewvaEventRecordsFromLogPath } from "../events/store.js";
import { inferEventCategory } from "../runtime-helpers.js";

type SessionWireFrameListener = (frame: SessionWireFrame) => void;

interface SessionWireCompilerState {
  turnIdByTapeTurn: Map<number, string>;
  nextAttemptSequenceByTurnId: Map<string, number>;
  latestAttemptIdByTurnId: Map<string, string>;
  latestDurableFrameKeys: Set<string>;
}

export interface SessionWireServiceOptions {
  queryStructuredEvents(sessionId: string): BrewvaStructuredEvent[];
  subscribeEvents(listener: (event: BrewvaStructuredEvent) => void): () => void;
}

const DURABLE_ATTEMPT_REASONS = new Set<Exclude<SessionWireAttemptReason, "initial">>([
  "output_budget_escalation",
  "compaction_retry",
  "provider_fallback_retry",
  "max_output_recovery",
  "reasoning_revert_resume",
]);

function createCompilerState(): SessionWireCompilerState {
  return {
    turnIdByTapeTurn: new Map<number, string>(),
    nextAttemptSequenceByTurnId: new Map<string, number>(),
    latestAttemptIdByTurnId: new Map<string, string>(),
    latestDurableFrameKeys: new Set<string>(),
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readBoolean(value: unknown): boolean {
  return value === true;
}

function readSessionWireCommittedStatus(value: unknown): SessionWireCommittedStatus | undefined {
  return value === "completed" || value === "failed" || value === "cancelled" ? value : undefined;
}

function readSessionWireTransitionStatus(value: unknown): SessionWireTransitionStatus | undefined {
  return value === "entered" || value === "completed" || value === "failed" || value === "skipped"
    ? value
    : undefined;
}

function readSessionWireTransitionFamily(value: unknown): SessionWireTransitionFamily | undefined {
  return value === "context" ||
    value === "output_budget" ||
    value === "approval" ||
    value === "delegation" ||
    value === "interrupt" ||
    value === "recovery"
    ? value
    : undefined;
}

function readSessionWireAttemptReason(value: unknown): SessionWireAttemptReason | undefined {
  return value === "initial" ||
    value === "output_budget_escalation" ||
    value === "compaction_retry" ||
    value === "provider_fallback_retry" ||
    value === "max_output_recovery" ||
    value === "reasoning_revert_resume"
    ? value
    : undefined;
}

function readToolOutputView(value: unknown): ToolOutputView | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }
  const toolCallId = readString(record.toolCallId);
  const toolName = readString(record.toolName);
  const verdict = record.verdict;
  if (!toolCallId || !toolName) {
    return null;
  }
  if (verdict !== "pass" && verdict !== "fail" && verdict !== "inconclusive") {
    return null;
  }
  return {
    toolCallId,
    toolName,
    verdict,
    isError: readBoolean(record.isError),
    text: readString(record.text) ?? "",
  };
}

function readToolOutputViews(value: unknown): ToolOutputView[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => readToolOutputView(entry))
    .filter((entry): entry is ToolOutputView => {
      return entry !== null;
    });
}

function readTurnInputRecordedPayload(
  event: BrewvaStructuredEvent,
): TurnInputRecordedPayload | null {
  const payload = asRecord(event.payload);
  if (!payload) {
    return null;
  }
  const turnId = readString(payload.turnId);
  const trigger =
    payload.trigger === "user" ||
    payload.trigger === "schedule" ||
    payload.trigger === "heartbeat" ||
    payload.trigger === "channel" ||
    payload.trigger === "recovery"
      ? payload.trigger
      : undefined;
  const promptText = typeof payload.promptText === "string" ? payload.promptText : undefined;
  if (!turnId || !trigger || promptText === undefined) {
    return null;
  }
  return {
    turnId,
    trigger,
    promptText,
  };
}

function readTurnRenderCommittedPayload(
  event: BrewvaStructuredEvent,
): TurnRenderCommittedPayload | null {
  const payload = asRecord(event.payload);
  if (!payload) {
    return null;
  }
  const turnId = readString(payload.turnId);
  const attemptId = readString(payload.attemptId);
  const status = readSessionWireCommittedStatus(payload.status);
  const assistantText = typeof payload.assistantText === "string" ? payload.assistantText : "";
  if (!turnId || !attemptId || !status) {
    return null;
  }
  return {
    turnId,
    attemptId,
    status,
    assistantText,
    toolOutputs: readToolOutputViews(payload.toolOutputs),
  };
}

function parseAttemptSequence(attemptId: string): number | null {
  const match = /^attempt-(\d+)$/.exec(attemptId);
  if (!match) {
    return null;
  }
  const value = Number.parseInt(match[1] ?? "", 10);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function ensureAttemptState(
  state: SessionWireCompilerState,
  turnId: string,
): {
  latestAttemptId: string;
  latestAttemptSequence: number;
  nextAttemptSequence: number;
} {
  let latestAttemptId = state.latestAttemptIdByTurnId.get(turnId);
  let nextAttemptSequence = state.nextAttemptSequenceByTurnId.get(turnId);
  if (!latestAttemptId) {
    latestAttemptId = "attempt-1";
    state.latestAttemptIdByTurnId.set(turnId, latestAttemptId);
  }
  const latestAttemptSequence = parseAttemptSequence(latestAttemptId) ?? 1;
  if (!nextAttemptSequence || nextAttemptSequence <= latestAttemptSequence) {
    nextAttemptSequence = latestAttemptSequence + 1;
    state.nextAttemptSequenceByTurnId.set(turnId, nextAttemptSequence);
  }
  return {
    latestAttemptId,
    latestAttemptSequence,
    nextAttemptSequence,
  };
}

function rememberCommittedAttempt(
  state: SessionWireCompilerState,
  turnId: string,
  attemptId: string,
): void {
  state.latestAttemptIdByTurnId.set(turnId, attemptId);
  const attemptSequence = parseAttemptSequence(attemptId);
  if (attemptSequence !== null) {
    state.nextAttemptSequenceByTurnId.set(turnId, attemptSequence + 1);
  }
}

function resolveTurnId(
  state: SessionWireCompilerState,
  event: Pick<BrewvaStructuredEvent, "turn">,
): string | null {
  if (typeof event.turn === "number" && Number.isFinite(event.turn)) {
    return state.turnIdByTapeTurn.get(event.turn) ?? null;
  }
  return null;
}

function durableFrameId(
  event: BrewvaStructuredEvent,
  frameType: SessionWireFrame["type"],
  index = 0,
): string {
  return index > 0 ? `${event.id}:${frameType}:${index}` : `${event.id}:${frameType}`;
}

function buildDurableBase(
  event: BrewvaStructuredEvent,
  frameType: SessionWireFrame["type"],
  source: SessionWireSource,
  index = 0,
): Pick<
  SessionWireFrame,
  | "schema"
  | "sessionId"
  | "frameId"
  | "ts"
  | "source"
  | "durability"
  | "sourceEventId"
  | "sourceEventType"
> {
  return {
    schema: SESSION_WIRE_SCHEMA,
    sessionId: event.sessionId,
    frameId: durableFrameId(event, frameType, index),
    ts: event.timestamp,
    source,
    durability: "durable",
    sourceEventId: event.id,
    sourceEventType: event.type,
  };
}

function appendDurableFrame(
  state: SessionWireCompilerState,
  frames: SessionWireFrame[],
  frame: SessionWireFrame,
): void {
  if (frame.durability !== "durable") {
    frames.push(frame);
    return;
  }
  if (state.latestDurableFrameKeys.has(frame.frameId)) {
    return;
  }
  state.latestDurableFrameKeys.add(frame.frameId);
  frames.push(frame);
}

function buildTurnTransitionFrames(
  state: SessionWireCompilerState,
  event: BrewvaStructuredEvent,
  source: SessionWireSource,
): SessionWireFrame[] {
  const payload = asRecord(event.payload);
  const turnId = resolveTurnId(state, event);
  const reason = readString(payload?.reason);
  const status = readSessionWireTransitionStatus(payload?.status);
  const family = readSessionWireTransitionFamily(payload?.family);
  if (!turnId || !reason || !status || !family) {
    return [];
  }

  const frames: SessionWireFrame[] = [];
  const attemptReason = readSessionWireAttemptReason(reason);
  const durableAttemptReason =
    attemptReason &&
    DURABLE_ATTEMPT_REASONS.has(attemptReason as Exclude<SessionWireAttemptReason, "initial">)
      ? (attemptReason as Exclude<SessionWireAttemptReason, "initial">)
      : undefined;
  const attemptState = ensureAttemptState(state, turnId);
  const nextAttemptSequence = attemptState.nextAttemptSequence;
  const nextAttemptId = `attempt-${nextAttemptSequence}`;
  const transitionAttemptId =
    status === "entered" && durableAttemptReason ? nextAttemptId : attemptState.latestAttemptId;
  const transitionAttempt =
    status === "entered" && durableAttemptReason
      ? nextAttemptSequence
      : attemptState.latestAttemptSequence;

  frames.push({
    ...buildDurableBase(event, "turn.transition", source),
    type: "turn.transition",
    turnId,
    reason,
    status,
    family,
    attempt: transitionAttempt,
    attemptId: transitionAttemptId,
    error: readString(payload?.error),
  });

  if (status === "entered" && durableAttemptReason) {
    frames.push({
      ...buildDurableBase(event, "attempt.superseded", source, 1),
      type: "attempt.superseded",
      turnId,
      attemptId: attemptState.latestAttemptId,
      supersededByAttemptId: nextAttemptId,
      reason: durableAttemptReason,
    });
    frames.push({
      ...buildDurableBase(event, "attempt.started", source, 2),
      type: "attempt.started",
      turnId,
      attemptId: nextAttemptId,
      reason: durableAttemptReason,
    });
    state.latestAttemptIdByTurnId.set(turnId, nextAttemptId);
    state.nextAttemptSequenceByTurnId.set(turnId, nextAttemptSequence + 1);
  }

  return frames;
}

function buildApprovalRequestedFrame(
  state: SessionWireCompilerState,
  event: BrewvaStructuredEvent,
  source: SessionWireSource,
): SessionWireFrame[] {
  const payload = asRecord(event.payload);
  const turnId = resolveTurnId(state, event);
  const requestId = readString(payload?.requestId);
  const toolName = readString(payload?.toolName);
  const toolCallId = readString(payload?.toolCallId);
  const subject = readString(payload?.subject);
  if (!turnId || !requestId || !toolName || !toolCallId || !subject) {
    return [];
  }
  return [
    {
      ...buildDurableBase(event, "approval.requested", source),
      type: "approval.requested",
      turnId,
      requestId,
      toolName,
      toolCallId,
      subject,
      detail: readString(payload?.argsSummary),
    },
  ];
}

function buildApprovalDecidedFrame(
  state: SessionWireCompilerState,
  event: BrewvaStructuredEvent,
  source: SessionWireSource,
): SessionWireFrame[] {
  const payload = asRecord(event.payload);
  const turnId = resolveTurnId(state, event);
  const requestId = readString(payload?.requestId);
  const decision =
    payload?.decision === "accept"
      ? "approved"
      : payload?.decision === "reject"
        ? "rejected"
        : undefined;
  if (!turnId || !requestId || !decision) {
    return [];
  }
  return [
    {
      ...buildDurableBase(event, "approval.decided", source),
      type: "approval.decided",
      turnId,
      requestId,
      decision,
      actor: readString(payload?.actor),
      reason: readString(payload?.reason),
    },
  ];
}

function buildSubagentStartedFrame(
  state: SessionWireCompilerState,
  event: BrewvaStructuredEvent,
  source: SessionWireSource,
  lifecycle: "spawned" | "running",
): SessionWireFrame[] {
  const payload = asRecord(event.payload);
  const turnId = resolveTurnId(state, event);
  const runId = readString(payload?.runId);
  const delegate = readString(payload?.delegate);
  const kind = payload?.kind;
  if (!turnId || !runId || !delegate || (kind !== "consult" && kind !== "qa" && kind !== "patch")) {
    return [];
  }
  return [
    {
      ...buildDurableBase(event, "subagent.started", source),
      type: "subagent.started",
      turnId,
      runId,
      delegate,
      kind,
      label: readString(payload?.label),
      lifecycle,
    },
  ];
}

function buildSubagentFinishedFrame(
  state: SessionWireCompilerState,
  event: BrewvaStructuredEvent,
  source: SessionWireSource,
  status: "completed" | "failed" | "cancelled",
): SessionWireFrame[] {
  const payload = asRecord(event.payload);
  const turnId = resolveTurnId(state, event);
  const runId = readString(payload?.runId);
  const delegate = readString(payload?.delegate);
  const kind = payload?.kind;
  if (!turnId || !runId || !delegate || (kind !== "consult" && kind !== "qa" && kind !== "patch")) {
    return [];
  }
  return [
    {
      ...buildDurableBase(event, "subagent.finished", source),
      type: "subagent.finished",
      turnId,
      runId,
      delegate,
      kind,
      status,
      summary: readString(payload?.summary),
    },
  ];
}

function compileDurableEvent(
  state: SessionWireCompilerState,
  event: BrewvaStructuredEvent,
  source: SessionWireSource,
): SessionWireFrame[] {
  switch (event.type) {
    case TURN_INPUT_RECORDED_EVENT_TYPE: {
      const payload = readTurnInputRecordedPayload(event);
      if (!payload) {
        return [];
      }
      if (typeof event.turn === "number" && Number.isFinite(event.turn)) {
        state.turnIdByTapeTurn.set(event.turn, payload.turnId);
      }
      ensureAttemptState(state, payload.turnId);
      return [
        {
          ...buildDurableBase(event, "turn.input", source),
          type: "turn.input",
          turnId: payload.turnId,
          trigger: payload.trigger,
          promptText: payload.promptText,
        },
      ];
    }
    case TURN_RENDER_COMMITTED_EVENT_TYPE: {
      const payload = readTurnRenderCommittedPayload(event);
      if (!payload) {
        return [];
      }
      if (typeof event.turn === "number" && Number.isFinite(event.turn)) {
        state.turnIdByTapeTurn.set(event.turn, payload.turnId);
      }
      rememberCommittedAttempt(state, payload.turnId, payload.attemptId);
      return [
        {
          ...buildDurableBase(event, "turn.committed", source),
          type: "turn.committed",
          turnId: payload.turnId,
          attemptId: payload.attemptId,
          status: payload.status,
          assistantText: payload.assistantText,
          toolOutputs: payload.toolOutputs,
        },
      ];
    }
    case SESSION_TURN_TRANSITION_EVENT_TYPE:
      return buildTurnTransitionFrames(state, event, source);
    case EFFECT_COMMITMENT_APPROVAL_REQUESTED_EVENT_TYPE:
      return buildApprovalRequestedFrame(state, event, source);
    case EFFECT_COMMITMENT_APPROVAL_DECIDED_EVENT_TYPE:
      return buildApprovalDecidedFrame(state, event, source);
    case SUBAGENT_SPAWNED_EVENT_TYPE:
      return buildSubagentStartedFrame(state, event, source, "spawned");
    case SUBAGENT_RUNNING_EVENT_TYPE:
      return buildSubagentStartedFrame(state, event, source, "running");
    case SUBAGENT_COMPLETED_EVENT_TYPE:
      return buildSubagentFinishedFrame(state, event, source, "completed");
    case SUBAGENT_FAILED_EVENT_TYPE:
      return buildSubagentFinishedFrame(state, event, source, "failed");
    case SUBAGENT_CANCELLED_EVENT_TYPE:
      return buildSubagentFinishedFrame(state, event, source, "cancelled");
    case SESSION_SHUTDOWN_EVENT_TYPE: {
      return [
        {
          ...buildDurableBase(event, "session.closed", source),
          type: "session.closed",
          reason: readString(asRecord(event.payload)?.reason),
        },
      ];
    }
    default:
      return [];
  }
}

function compileFrames(
  events: readonly BrewvaStructuredEvent[],
  source: SessionWireSource,
): SessionWireFrame[] {
  const state = createCompilerState();
  const frames: SessionWireFrame[] = [];
  for (const event of events) {
    const compiled = compileDurableEvent(state, event, source);
    for (const frame of compiled) {
      appendDurableFrame(state, frames, frame);
    }
  }
  return frames;
}

function toStructuredEvent(event: BrewvaEventRecord): BrewvaStructuredEvent {
  return {
    schema: "brewva.event.v1",
    id: event.id,
    sessionId: event.sessionId,
    type: event.type,
    category: inferEventCategory(event.type),
    timestamp: event.timestamp,
    isoTime: new Date(event.timestamp).toISOString(),
    turn: event.turn,
    payload: event.payload,
  };
}

export function compileSessionWireFrames(
  events: readonly BrewvaStructuredEvent[],
  source: SessionWireSource,
): SessionWireFrame[] {
  return compileFrames(events, source);
}

export function querySessionWireFramesFromEventLog(input: {
  eventLogPath: string;
  sessionId: string;
}): SessionWireFrame[] {
  const structuredEvents = readBrewvaEventRecordsFromLogPath(input.eventLogPath, {
    sessionId: input.sessionId,
  }).map((event) => toStructuredEvent(event));
  return compileFrames(structuredEvents, "replay");
}

function hydrateState(
  state: SessionWireCompilerState,
  events: readonly BrewvaStructuredEvent[],
): void {
  for (const event of events) {
    const compiled = compileDurableEvent(state, event, "replay");
    for (const frame of compiled) {
      appendDurableFrame(state, [], frame);
    }
  }
}

export class SessionWireService {
  private readonly queryStructuredEvents: SessionWireServiceOptions["queryStructuredEvents"];
  private readonly subscribeEvents: SessionWireServiceOptions["subscribeEvents"];

  constructor(options: SessionWireServiceOptions) {
    this.queryStructuredEvents = (sessionId) => options.queryStructuredEvents(sessionId);
    this.subscribeEvents = (listener) => options.subscribeEvents(listener);
  }

  query(sessionId: string): SessionWireFrame[] {
    return compileSessionWireFrames(this.queryStructuredEvents(sessionId), "replay");
  }

  subscribe(sessionId: string, listener: SessionWireFrameListener): () => void {
    const state = createCompilerState();
    hydrateState(state, this.queryStructuredEvents(sessionId));
    return this.subscribeEvents((event) => {
      if (event.sessionId !== sessionId) {
        return;
      }
      const frames = compileDurableEvent(state, event, "live");
      for (const frame of frames) {
        if (frame.durability === "durable" && state.latestDurableFrameKeys.has(frame.frameId)) {
          continue;
        }
        appendDurableFrame(state, [], frame);
        listener(frame);
      }
    });
  }
}
