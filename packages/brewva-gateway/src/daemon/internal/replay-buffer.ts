import { randomUUID } from "node:crypto";
import { asBrewvaSessionId } from "@brewva/brewva-runtime/core";
import { SESSION_WIRE_SCHEMA } from "@brewva/brewva-runtime/protocol";
import type {
  ContextStatusView,
  SessionWireFrame,
  SessionWireStatusState,
} from "@brewva/brewva-runtime/protocol";
import { type GatewayEvent, validateSessionWireFramePayload } from "../../protocol/api.js";

export interface ReplayBufferedEvent {
  event: GatewayEvent;
  payload?: unknown;
  seq: number;
}

export type ReplayStateBySession = Map<
  string,
  {
    bufferedEvents: ReplayBufferedEvent[];
  }
>;

export type ReplayDeliveredDurableFrameIdsBySession = Map<string, Set<string>>;

function isDurableSessionWireFrame(value: unknown): value is SessionWireFrame {
  const validated = validateSessionWireFramePayload(value);
  return validated.ok && validated.frame.durability === "durable";
}

export function normalizeProjectedSessionWireFramePayload(
  payload: unknown,
): { ok: true; sessionId: string; frame: SessionWireFrame } | { ok: false; error: string } {
  if (payload && typeof payload === "object") {
    const outer = payload as { sessionId?: unknown; frame?: unknown };
    if (outer.frame && typeof outer.frame === "object") {
      const rawFrame = outer.frame as SessionWireFrame;
      const projectedSessionId =
        typeof outer.sessionId === "string" && outer.sessionId.trim().length > 0
          ? outer.sessionId.trim()
          : rawFrame.sessionId;
      const projectedFrame = projectSessionWireFrame(projectedSessionId, rawFrame);
      const validated = validateSessionWireFramePayload(projectedFrame);
      if (!validated.ok) {
        return validated;
      }
      return {
        ok: true,
        sessionId: projectedSessionId,
        frame: validated.frame,
      };
    }
  }
  const validated = validateSessionWireFramePayload(payload);
  if (!validated.ok) {
    return validated;
  }
  return {
    ok: true,
    sessionId: validated.frame.sessionId,
    frame: validated.frame,
  };
}

export function rememberDeliveredReplayDurableFrame(
  replayDeliveredDurableFrameIdsBySession: ReplayDeliveredDurableFrameIdsBySession,
  sessionId: string,
  payload: unknown,
): boolean {
  if (!isDurableSessionWireFrame(payload)) {
    return true;
  }
  const tracker = replayDeliveredDurableFrameIdsBySession.get(sessionId);
  if (!tracker) {
    return true;
  }
  // Replay/live overlap dedupe must stay exact for the active replay window.
  // The tracker is scoped to replay only and cleared immediately after flush.
  if (tracker.has(payload.frameId)) {
    return false;
  }
  tracker.add(payload.frameId);
  return true;
}

export function getReplayBufferedEvents(
  replayStateBySession: ReplayStateBySession,
  sessionId: string,
): ReplayBufferedEvent[] {
  return replayStateBySession.get(sessionId)?.bufferedEvents ?? [];
}

export function readBufferedSessionWireFrames(
  bufferedEvents: readonly ReplayBufferedEvent[],
  sessionId: string,
): SessionWireFrame[] {
  const frames: SessionWireFrame[] = [];
  for (const entry of bufferedEvents) {
    if (entry.event !== "session.wire.frame") {
      continue;
    }
    const validated = validateSessionWireFramePayload(entry.payload);
    if (!validated.ok || validated.frame.sessionId !== sessionId) {
      continue;
    }
    frames.push(validated.frame);
  }
  return frames;
}

export function findLastBufferedSessionStatusFrame(
  bufferedEvents: readonly ReplayBufferedEvent[],
  sessionId: string,
): Extract<SessionWireFrame, { type: "session.status" }> | null {
  for (let index = bufferedEvents.length - 1; index >= 0; index -= 1) {
    const entry = bufferedEvents[index];
    if (!entry || entry.event !== "session.wire.frame") {
      continue;
    }
    const validated = validateSessionWireFramePayload(entry.payload);
    if (!validated.ok || validated.frame.sessionId !== sessionId) {
      continue;
    }
    if (validated.frame.type === "session.status") {
      return validated.frame;
    }
  }
  return null;
}

export function buildSessionStatusFrame(input: {
  sessionId: string;
  state: SessionWireStatusState;
  reason?: string;
  detail?: string;
  contextStatus?: ContextStatusView;
}): Extract<SessionWireFrame, { type: "session.status" }> {
  return {
    schema: SESSION_WIRE_SCHEMA,
    sessionId: asBrewvaSessionId(input.sessionId),
    frameId: `session.status:${input.sessionId}:${Date.now()}:${randomUUID()}`,
    ts: Date.now(),
    source: "live",
    durability: "cache",
    type: "session.status",
    state: input.state,
    reason: input.reason,
    detail: input.detail,
    contextStatus: input.contextStatus,
  };
}

export function projectSessionWireFrame(
  sessionId: string,
  frame: SessionWireFrame,
): SessionWireFrame {
  if (frame.sessionId === sessionId) {
    return frame;
  }
  return {
    ...frame,
    sessionId: asBrewvaSessionId(sessionId),
  };
}

export function buildReplayControlFrame(
  sessionId: string,
  type: Extract<SessionWireFrame["type"], "replay.begin" | "replay.complete">,
): SessionWireFrame {
  return {
    schema: SESSION_WIRE_SCHEMA,
    sessionId: asBrewvaSessionId(sessionId),
    frameId: `${type}:${sessionId}:${Date.now()}:${randomUUID()}`,
    ts: Date.now(),
    source: "replay",
    durability: "cache",
    type,
  };
}
