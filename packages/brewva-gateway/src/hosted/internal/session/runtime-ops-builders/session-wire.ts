import type { SessionWireFrame } from "@brewva/brewva-vocabulary/wire";
import { buildRuntimeTurnSessionWireFrames } from "../../../../utils/runtime-session-wire-projection.js";
import type { HostedRuntimeOpsContext } from "../runtime-ops-context.js";
import type { HostedRuntimeOpsPort, RuntimeListener } from "../runtime-ops-port.js";

export function buildSessionWireRuntimeOps(
  ctx: HostedRuntimeOpsContext,
): HostedRuntimeOpsPort["sessionWire"] {
  return {
    subscribe(sessionId, listener) {
      const listeners = ctx.state.sessionWireSubscribers.get(sessionId) ?? new Set();
      listeners.add(listener);
      ctx.state.sessionWireSubscribers.set(sessionId, listeners);
      const emittedFrameIds = new Set(
        sessionWireFramesFor(ctx, sessionId).map((frame) => frame.frameId),
      );
      const eventListener: RuntimeListener = (event) => {
        if (event.sessionId !== sessionId) {
          return;
        }
        for (const frame of sessionWireFramesFor(ctx, sessionId)) {
          if (emittedFrameIds.has(frame.frameId)) {
            continue;
          }
          emittedFrameIds.add(frame.frameId);
          listener(frame);
        }
      };
      ctx.state.subscribers.add(eventListener);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          ctx.state.sessionWireSubscribers.delete(sessionId);
        }
        return ctx.state.subscribers.delete(eventListener);
      };
    },
    query: (sessionId) => sessionWireFramesFor(ctx, sessionId),
  };
}

function sessionWireFramesFor(ctx: HostedRuntimeOpsContext, sessionId: string): SessionWireFrame[] {
  const events = ctx.listEvents(sessionId);
  const frames: SessionWireFrame[] = buildRuntimeTurnSessionWireFrames({
    sessionId,
    events,
  });
  for (const event of events) {
    if (event.type !== "session_shutdown") {
      continue;
    }
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
  return frames.toSorted((left, right) => {
    const leftTs =
      typeof (left as { ts?: unknown }).ts === "number" ? (left as { ts: number }).ts : 0;
    const rightTs =
      typeof (right as { ts?: unknown }).ts === "number" ? (right as { ts: number }).ts : 0;
    return leftTs - rightTs;
  });
}
