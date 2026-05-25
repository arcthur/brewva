import type { ProtocolRecord } from "@brewva/brewva-vocabulary/events";
import type { HostedRuntimeOpsContext } from "../runtime-ops-context.js";
import type { HostedRuntimeOpsPort } from "../runtime-ops-port.js";

export function buildTapeRuntimeOps(ctx: HostedRuntimeOpsContext): HostedRuntimeOpsPort["tape"] {
  return {
    status: {
      get(sessionId) {
        const baseline = ctx.runtime.tape.replayBaseline(sessionId);
        const totalEntries = ctx.runtime.tape.list(sessionId).length;
        const anchor = lastAnchorFor(ctx, sessionId);
        const lastAnchor =
          typeof anchor === "string"
            ? { id: anchor }
            : anchor && typeof anchor === "object" && !Array.isArray(anchor)
              ? typeof anchor.id === "string" && anchor.id.trim().length > 0
                ? {
                    id: anchor.id,
                    name: typeof anchor.name === "string" ? anchor.name : undefined,
                    summary: typeof anchor.summary === "string" ? anchor.summary : undefined,
                    nextSteps: typeof anchor.nextSteps === "string" ? anchor.nextSteps : undefined,
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
      record(sessionId, payload) {
        const event = ctx.emit(sessionId, "tape.handoff", payload);
        return { ok: true, eventId: event.id, createdAt: event.timestamp };
      },
    },
    search: {
      search(sessionId, query) {
        const needle = (query.query ?? "").trim().toLowerCase();
        const limit = query.limit ?? 20;
        if (!needle) {
          return { matches: [], scannedEvents: 0 };
        }
        const events = ctx.runtime.tape.list(sessionId);
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
  };
}

function lastAnchorFor(
  ctx: HostedRuntimeOpsContext,
  sessionId: string,
): ProtocolRecord | string | null {
  const handoff = ctx.listEvents(sessionId, { type: "tape.handoff", last: 1 })[0];
  if (handoff) {
    const payload =
      handoff.payload && typeof handoff.payload === "object" && !Array.isArray(handoff.payload)
        ? handoff.payload
        : {};
    return {
      id: typeof payload.id === "string" && payload.id.trim().length > 0 ? payload.id : handoff.id,
      ...payload,
    };
  }
  const baseline = ctx.runtime.tape.replayBaseline(sessionId);
  return baseline.checkpoint?.id ?? null;
}
