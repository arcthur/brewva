import type { TapeSearchResult, TapeStatusState } from "@brewva/brewva-vocabulary/session";
import type { BrewvaToolRuntimeCapabilitiesPort } from "../../contracts/index.js";
import { listFourPortRuntimeEvents, recordFourPortRuntimeOpsEvent } from "./events.js";
import { readRecord } from "./helpers.js";
import type { FourPortRuntimeCapabilityContext } from "./types.js";

const TAPE_PRESSURE_THRESHOLDS = Object.freeze({
  low: 0.35,
  medium: 0.65,
  high: 0.85,
});

function lastAnchorFor(
  context: FourPortRuntimeCapabilityContext,
  sessionId: string,
): {
  readonly id: string;
  readonly name?: string;
  readonly summary?: string;
  readonly nextSteps?: string;
} | null {
  const handoff = listFourPortRuntimeEvents(context.runtime, sessionId, {
    type: "tape.handoff",
    last: 1,
  })[0];
  if (handoff) {
    const payload = readRecord(handoff.payload);
    return {
      id: typeof payload.id === "string" && payload.id.trim().length > 0 ? payload.id : handoff.id,
      ...(typeof payload.name === "string" ? { name: payload.name } : {}),
      ...(typeof payload.summary === "string" ? { summary: payload.summary } : {}),
      ...(typeof payload.nextSteps === "string" ? { nextSteps: payload.nextSteps } : {}),
    };
  }
  const baseline = context.runtime.tape.replayBaseline(sessionId);
  return baseline.checkpoint?.id ? { id: baseline.checkpoint.id } : null;
}

function tapeStatus(context: FourPortRuntimeCapabilityContext, sessionId: string): TapeStatusState {
  const baseline = context.runtime.tape.replayBaseline(sessionId);
  const totalEntries = context.runtime.tape.list(sessionId).length;
  const lastAnchor = lastAnchorFor(context, sessionId);
  return {
    lastAnchor,
    lastCheckpointId: baseline.checkpoint?.id ?? null,
    tapePressure: "none",
    totalEntries,
    entriesSinceAnchor: totalEntries,
    entriesSinceCheckpoint: baseline.events.length,
    thresholds: TAPE_PRESSURE_THRESHOLDS,
  };
}

export function createFourPortTapeRuntimeOps(
  context: FourPortRuntimeCapabilityContext,
): BrewvaToolRuntimeCapabilitiesPort["tape"] {
  return {
    status: {
      get: (sessionId) => tapeStatus(context, sessionId),
      getPressureThresholds: () => TAPE_PRESSURE_THRESHOLDS,
    },
    handoff: {
      record(sessionId, payload) {
        const event = recordFourPortRuntimeOpsEvent(context, {
          sessionId,
          kind: "tape.handoff",
          payload,
        });
        return { ok: true, eventId: event.id, createdAt: event.timestamp };
      },
    },
    search: {
      search(sessionId, query): TapeSearchResult {
        const needle = (query.query ?? "").trim().toLowerCase();
        const limit = query.limit ?? 20;
        if (!needle) {
          return { matches: [], scannedEvents: 0 };
        }
        const events = context.runtime.tape.list(sessionId);
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
