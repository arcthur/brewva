import { randomUUID } from "node:crypto";
import type { BrewvaRuntime, CanonicalEvent } from "@brewva/brewva-runtime";
import { toJsonValue } from "@brewva/brewva-std/json";
import type {
  BrewvaEventQuery,
  BrewvaEventRecord,
  ProtocolRecord,
} from "@brewva/brewva-vocabulary/events";
import type {
  RenderTurnConsequenceDigestOptions,
  TurnEffectCommitmentProjection,
} from "@brewva/brewva-vocabulary/iteration";
import type { BrewvaReplaySession } from "@brewva/brewva-vocabulary/session";
import type { BrewvaToolRuntimeCapabilitiesPort } from "../../contracts/index.js";
import {
  knownRuntimeEventSessionIds,
  normalizeWindowCount,
  readRecord,
  sliceWindow,
} from "./helpers.js";
import { listGuardResultsFromEvents, listMetricObservationsFromEvents } from "./iteration-facts.js";
import {
  FOUR_PORT_RUNTIME_OPS_EVENT_NAMESPACES,
  type FourPortRuntimeCapabilityContext,
  type FourPortRuntimeEventListener,
  type FourPortRuntimeEventRecord,
} from "./types.js";

type ProjectionInput = RenderTurnConsequenceDigestOptions & Partial<TurnEffectCommitmentProjection>;

const OPS_EVENT_NAMESPACE = FOUR_PORT_RUNTIME_OPS_EVENT_NAMESPACES[0];

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

function customEventKind(event: CanonicalEvent): string | null {
  if (event.type !== "custom") {
    return null;
  }
  const payload = readRecord(event.payload);
  const namespace = payload.namespace;
  const kind = payload.kind;
  return FOUR_PORT_RUNTIME_OPS_EVENT_NAMESPACES.includes(
    namespace as (typeof FOUR_PORT_RUNTIME_OPS_EVENT_NAMESPACES)[number],
  ) && typeof kind === "string"
    ? kind
    : null;
}

function customEventPayload(event: CanonicalEvent): ProtocolRecord | undefined {
  if (event.type !== "custom") {
    return undefined;
  }
  const payload = readRecord(event.payload);
  return readRecord(payload.payload);
}

export function canonicalEventToFourPortRuntimeEvent(
  event: CanonicalEvent,
): FourPortRuntimeEventRecord {
  const customKind = customEventKind(event);
  const type = customKind ?? event.type;
  return {
    schema: "brewva.event.v1",
    id: event.id,
    sessionId: event.sessionId,
    type,
    category: eventCategory(type),
    timestamp: event.timestamp,
    isoTime: new Date(event.timestamp).toISOString(),
    ...turnFields(event.turnId),
    payload: customKind ? customEventPayload(event) : readRecord(event.payload),
  } as FourPortRuntimeEventRecord;
}

export function structureFourPortRuntimeEvent(
  event: BrewvaEventRecord,
): FourPortRuntimeEventRecord {
  return {
    ...event,
    schema: "brewva.event.v1",
    category: eventCategory(event.type),
    isoTime: new Date(event.timestamp ?? Date.now()).toISOString(),
  } as FourPortRuntimeEventRecord;
}

export function listFourPortRuntimeEvents(
  runtime: Pick<BrewvaRuntime, "tape">,
  sessionId: string,
  query?: BrewvaEventQuery,
): FourPortRuntimeEventRecord[] {
  const sourceEvents = runtime.tape.list(sessionId);
  let orderedEvents = sourceEvents;
  for (let index = 1; index < sourceEvents.length; index += 1) {
    const previous = sourceEvents[index - 1];
    const current = sourceEvents[index];
    if (previous && current && previous.timestamp > current.timestamp) {
      orderedEvents = [...sourceEvents].toSorted((left, right) => left.timestamp - right.timestamp);
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
  const offset = normalizeWindowCount(query?.offset);
  const limit = normalizeWindowCount(query?.limit);
  const last = normalizeWindowCount(query?.last);
  const matchesQuery = (event: FourPortRuntimeEventRecord): boolean => {
    if (query?.type && event.type !== query.type) return false;
    if (query?.category && event.category !== query.category) return false;
    if (after !== null && event.timestamp <= after) return false;
    if (before !== null && event.timestamp >= before) return false;
    return true;
  };
  if (last !== null) {
    if (last === 0) return [];
    const tail: FourPortRuntimeEventRecord[] = [];
    for (let index = orderedEvents.length - 1; index >= 0; index -= 1) {
      const event = orderedEvents[index];
      if (!event) continue;
      const operationalEvent = canonicalEventToFourPortRuntimeEvent(event);
      if (!matchesQuery(operationalEvent)) continue;
      tail.push(operationalEvent);
      if (tail.length >= last) break;
    }
    tail.reverse();
    return sliceWindow(tail, offset, limit);
  }
  const matches = orderedEvents
    .map(canonicalEventToFourPortRuntimeEvent)
    .filter((event) => matchesQuery(event));
  return sliceWindow(matches, offset, limit);
}

export function recordFourPortRuntimeOpsEvent(
  context: FourPortRuntimeCapabilityContext,
  input: {
    readonly sessionId: string;
    readonly kind: string;
    readonly payload?: object | null;
    readonly timestamp?: number;
    readonly turn?: number;
  },
): FourPortRuntimeEventRecord {
  const timestamp = input.timestamp ?? Date.now();
  const eventId = `ops:${input.sessionId}:${randomUUID()}`;
  const { event } = context.runtime.kernel.recordAdvisoryEvent({
    id: eventId,
    sessionId: input.sessionId,
    ...(typeof input.turn === "number" ? { turnId: String(input.turn) } : {}),
    timestamp,
    namespace: OPS_EVENT_NAMESPACE,
    kind: input.kind,
    version: 1,
    payload: toJsonValue(input.payload ?? {}),
  });
  const operationalEvent = canonicalEventToFourPortRuntimeEvent(event);
  context.rememberSessionId?.(input.sessionId);
  context.publishEvent?.(operationalEvent);
  return operationalEvent;
}

export function deriveTurnEffectCommitmentProjection(
  input: ProjectionInput = {},
): TurnEffectCommitmentProjection {
  return {
    runtimeTurn: typeof input.runtimeTurn === "number" ? input.runtimeTurn : 0,
    ...(typeof input.turnId === "string" ? { turnId: input.turnId } : {}),
    declared: input.declared ?? [],
    attempted: input.attempted ?? [],
    decisions: input.decisions ?? [],
    executed: input.executed ?? [],
    recovery: input.recovery ?? [],
    warnings: input.warnings ?? [],
  };
}

export function renderTurnConsequenceDigest(input: ProjectionInput = {}): string {
  const projection = deriveTurnEffectCommitmentProjection(input);
  const digest = `runtimeTurn=${projection.runtimeTurn} declared=${projection.declared.length} attempted=${projection.attempted.length} decisions=${projection.decisions.length} executed=${projection.executed.length} recovery=${projection.recovery.length} warnings=${projection.warnings.length}`;
  const maxChars = typeof input.maxChars === "number" ? Math.max(0, Math.trunc(input.maxChars)) : 0;
  return maxChars > 0 && digest.length > maxChars ? digest.slice(0, maxChars) : digest;
}

function listReplaySessions(
  context: FourPortRuntimeCapabilityContext,
  limit?: number,
): BrewvaReplaySession[] {
  const rows = knownRuntimeEventSessionIds(context)
    .map((sessionId) => {
      const events = listFourPortRuntimeEvents(context.runtime, sessionId);
      const lastEvent = events.at(-1);
      const titleEvent = events.findLast((event) => event.type === "session_title_recorded");
      const titlePayload = readRecord(titleEvent?.payload);
      return {
        sessionId,
        title: typeof titlePayload.title === "string" ? titlePayload.title : "New session",
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

export function createFourPortEventsRuntimeOps(
  context: FourPortRuntimeCapabilityContext,
): BrewvaToolRuntimeCapabilitiesPort["events"] & {
  readonly replay: {
    listSessions(limit?: number): BrewvaReplaySession[];
  };
} {
  return {
    recordMetricObservation: (sessionId, input) =>
      recordFourPortRuntimeOpsEvent(context, {
        sessionId,
        kind: "iteration.metric.observed",
        payload: input,
      }),
    recordGuardResult: (sessionId, input) =>
      recordFourPortRuntimeOpsEvent(context, {
        sessionId,
        kind: "iteration.guard.recorded",
        payload: input,
      }),
    records: {
      listSessionIds: () => knownRuntimeEventSessionIds(context),
      list: (sessionId, query) => listFourPortRuntimeEvents(context.runtime, sessionId, query),
      query: (sessionId, query) => listFourPortRuntimeEvents(context.runtime, sessionId, query),
      queryStructured: (sessionId, query) =>
        listFourPortRuntimeEvents(context.runtime, sessionId, query).map(
          structureFourPortRuntimeEvent,
        ),
      toStructured: (event) => structureFourPortRuntimeEvent(event),
      subscribe(listener) {
        return context.subscribeEvents?.(listener as FourPortRuntimeEventListener) ?? (() => false);
      },
    },
    replay: {
      listSessions: (limit) => listReplaySessions(context, limit),
    },
    effects: {
      renderTurnDigest: (_sessionId, value = {}) => renderTurnConsequenceDigest(value),
      getTurnProjection: (_sessionId, value = {}) => deriveTurnEffectCommitmentProjection(value),
    },
    iteration: {
      listGuardResults: (sessionId, query) =>
        listGuardResultsFromEvents(
          listFourPortRuntimeEvents(context.runtime, sessionId, {
            type: "iteration.guard.recorded",
          }),
          query,
        ),
      listMetricObservations: (sessionId, query) =>
        listMetricObservationsFromEvents(
          listFourPortRuntimeEvents(context.runtime, sessionId, {
            type: "iteration.metric.observed",
          }),
          query,
        ),
    },
  };
}
