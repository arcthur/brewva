import type { PlanMapRuntimeMutationResult } from "@brewva/brewva-tools/contracts";
import {
  foldPlanMapEvents,
  planMapFrontier,
  PLAN_FOG_GRADUATED_EVENT_TYPE,
  PLAN_FOG_RECORDED_EVENT_TYPE,
  PLAN_MAP_CREATED_EVENT_TYPE,
  PLAN_TICKET_CLAIMED_EVENT_TYPE,
  PLAN_TICKET_CLOSED_EVENT_TYPE,
  PLAN_TICKET_OPENED_EVENT_TYPE,
  PLAN_TICKET_RESCOPED_EVENT_TYPE,
  PLAN_TICKET_RESOLVED_EVENT_TYPE,
  PLAN_TICKET_TYPE_VALUES,
  PLAN_TICKET_UNCLAIMED_EVENT_TYPE,
  type PlanFogGraduateInput,
  type PlanFogRecordInput,
  type PlanMapCreateInput,
  type PlanMapEventType,
  type PlanMapState,
  type PlanTicketClaimInput,
  type PlanTicketCloseInput,
  type PlanTicketOpenInput,
  type PlanTicketRescopeInput,
  type PlanTicketResolveInput,
  type PlanTicketType,
  type PlanTicketUnclaimInput,
} from "@brewva/brewva-vocabulary/plan-map";
import type { HostedRuntimeOpsContext } from "./runtime-ops-context.js";
import {
  createPlanMapSidecarStore,
  type PlanMapSidecarStore,
} from "./runtime-ops-plan-map-store.js";

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readStringArray(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value
        .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
        .filter((e) => e.length > 0)
    : [];
}

function normalizeNow(now: number | undefined): number {
  return typeof now === "number" && Number.isFinite(now) ? now : Date.now();
}

function isTicketType(value: unknown): value is PlanTicketType {
  return typeof value === "string" && PLAN_TICKET_TYPE_VALUES.includes(value as PlanTicketType);
}

/**
 * The plan-map runtime controller: the emit + validate side of the durable map,
 * mirroring the goal controller but keyed by `mapId` (many concurrent maps) and
 * backed by the effort-scoped sidecar store instead of the session tape.
 *
 * It is the enforcement seam the pure fold deliberately leaves lenient: it
 * validates a create is once, a resolve carries an answer, a close carries a legal
 * reason, and — the one the fold cannot do — that a ticket's `blockedBy` names
 * only existing sibling tickets and never itself, so a dangling or self blocker can
 * never be written. Generated ticket / fog ids embed the authoring `sessionId` plus a
 * per-controller monotonic sequence and the wall-clock `now`. The controller is one
 * instance per session (built once by `createHostedRuntimeOps`), so within a session
 * the sequence strictly increases and ids never collide; across sessions the
 * `sessionId` differs. The one soft edge: a rebuilt controller (sequence reset to 0)
 * fed an injected, repeated deterministic `now` could re-mint an id the fold's dedup
 * silently drops — impossible under `Date.now()`, and the `createStore` seam is
 * test-only. A persisted counter would close it fully if this ever runs on a
 * fixed clock in production.
 *
 * `createStore` is injectable purely for tests (e.g. simulating a concurrent claim
 * race to exercise the `claim_lost` path); production always uses the real sidecar.
 */
export function createPlanMapRuntimeController(
  ctx: HostedRuntimeOpsContext,
  createStore: typeof createPlanMapSidecarStore = createPlanMapSidecarStore,
) {
  const stores = new Map<string, PlanMapSidecarStore>();
  let ticketSequence = 0;
  let fogSequence = 0;

  function storeFor(mapId: string): PlanMapSidecarStore {
    // Trim before using as the cache key: the store trims the id into the file
    // path, so " m " and "m" address one file — they must resolve to one store
    // instance, or two independent `sequence` counters could mint duplicate ids.
    const key = mapId.trim();
    const existing = stores.get(key);
    if (existing) {
      return existing;
    }
    const store = createStore({
      workspaceRoot: ctx.runtime.identity.workspaceRoot,
      mapId: key,
    });
    stores.set(key, store);
    return store;
  }

  function read(mapId: string): PlanMapState | null {
    return foldPlanMapEvents(storeFor(mapId).load(), mapId);
  }

  function fail(mapId: string, reason: string): PlanMapRuntimeMutationResult {
    return { ok: false, reason, map: read(mapId) };
  }

  function commit(
    mapId: string,
    eventType: PlanMapEventType,
    payload: Record<string, unknown>,
    author: { readonly sessionId: string; readonly now: number },
    ticketId?: string,
    patchId?: string,
  ): PlanMapRuntimeMutationResult {
    const event = storeFor(mapId).append(eventType, payload, author);
    const map = read(mapId);
    if (!map) {
      return { ok: false, reason: "map_rebuild_failed", map: null };
    }
    return {
      ok: true,
      map,
      eventType,
      eventId: event.id,
      ...(ticketId ? { ticketId } : {}),
      ...(patchId ? { patchId } : {}),
    };
  }

  return {
    get: read,

    create(mapId: string, input: PlanMapCreateInput): PlanMapRuntimeMutationResult {
      const sessionId = readString(input.sessionId);
      if (!sessionId) return fail(mapId, "missing_session");
      const destination = readString(input.destination);
      if (!destination) return fail(mapId, "missing_destination");
      if (read(mapId)) return fail(mapId, "map_exists");
      const notes = readString(input.notes);
      return commit(
        mapId,
        PLAN_MAP_CREATED_EVENT_TYPE,
        { destination, ...(notes ? { notes } : {}) },
        { sessionId, now: normalizeNow(input.now) },
      );
    },

    open(mapId: string, input: PlanTicketOpenInput): PlanMapRuntimeMutationResult {
      const sessionId = readString(input.sessionId);
      if (!sessionId) return fail(mapId, "missing_session");
      const map = read(mapId);
      if (!map) return fail(mapId, "map_not_found");
      if (!isTicketType(input.type)) return fail(mapId, "invalid_ticket_type");
      const title = readString(input.title);
      const question = readString(input.question);
      if (!title || !question) return fail(mapId, "missing_ticket_fields");
      const now = normalizeNow(input.now);
      ticketSequence += 1;
      const ticketId = `t:${encodeURIComponent(sessionId)}:${now}:${ticketSequence}`;
      const known = new Set(map.tickets.map((ticket) => ticket.id));
      const blockedBy = readStringArray(input.blockedBy);
      for (const blockerId of blockedBy) {
        if (blockerId === ticketId || !known.has(blockerId)) {
          return fail(mapId, "invalid_blocked_by");
        }
      }
      return commit(
        mapId,
        PLAN_TICKET_OPENED_EVENT_TYPE,
        { ticketId, type: input.type, title, question, blockedBy },
        { sessionId, now },
        ticketId,
      );
    },

    resolve(mapId: string, input: PlanTicketResolveInput): PlanMapRuntimeMutationResult {
      const sessionId = readString(input.sessionId);
      if (!sessionId) return fail(mapId, "missing_session");
      const map = read(mapId);
      if (!map) return fail(mapId, "map_not_found");
      const ticketId = readString(input.ticketId);
      const answer = readString(input.answer);
      if (!ticketId) return fail(mapId, "missing_ticket_id");
      if (!answer) return fail(mapId, "missing_answer");
      const ticket = map.tickets.find((entry) => entry.id === ticketId);
      if (!ticket) return fail(mapId, "ticket_not_found");
      if (ticket.status !== "open") return fail(mapId, "ticket_not_open");
      const assetRefs = readStringArray(input.assetRefs);
      return commit(
        mapId,
        PLAN_TICKET_RESOLVED_EVENT_TYPE,
        { ticketId, answer, ...(assetRefs.length > 0 ? { assetRefs } : {}) },
        { sessionId, now: normalizeNow(input.now) },
        ticketId,
      );
    },

    close(mapId: string, input: PlanTicketCloseInput): PlanMapRuntimeMutationResult {
      const sessionId = readString(input.sessionId);
      if (!sessionId) return fail(mapId, "missing_session");
      const map = read(mapId);
      if (!map) return fail(mapId, "map_not_found");
      const ticketId = readString(input.ticketId);
      if (!ticketId) return fail(mapId, "missing_ticket_id");
      if (input.reason !== "out_of_scope" && input.reason !== "invalidated") {
        return fail(mapId, "invalid_close_reason");
      }
      const ticket = map.tickets.find((entry) => entry.id === ticketId);
      if (!ticket) return fail(mapId, "ticket_not_found");
      if (ticket.status !== "open") return fail(mapId, "ticket_not_open");
      const why = readString(input.why);
      return commit(
        mapId,
        PLAN_TICKET_CLOSED_EVENT_TYPE,
        { ticketId, reason: input.reason, ...(why ? { why } : {}) },
        { sessionId, now: normalizeNow(input.now) },
        ticketId,
      );
    },

    claim(mapId: string, input: PlanTicketClaimInput): PlanMapRuntimeMutationResult {
      const sessionId = readString(input.sessionId);
      if (!sessionId) return fail(mapId, "missing_session");
      const map = read(mapId);
      if (!map) return fail(mapId, "map_not_found");
      // When no ticket is named, take the first frontier ticket — the "take next"
      // convenience, single-sourced here so the CLI and channel surfaces stay thin.
      const ticketId = readString(input.ticketId) ?? planMapFrontier(map)[0]?.id;
      if (!ticketId) return fail(mapId, "no_takeable_ticket");
      const ticket = map.tickets.find((entry) => entry.id === ticketId);
      if (!ticket) return fail(mapId, "ticket_not_found");
      if (ticket.status !== "open") return fail(mapId, "ticket_not_open");
      if (ticket.claimedBy) return fail(mapId, "ticket_already_claimed");
      // Claim is for takeable (frontier) tickets only: an open but still-blocked
      // ticket cannot be worked yet, so a claim-ahead would only strand it off the
      // frontier. Gate on frontier membership, single-sourced from the fold.
      if (!planMapFrontier(map).some((entry) => entry.id === ticketId)) {
        return fail(mapId, "ticket_blocked");
      }
      const owner = readString(input.owner) ?? sessionId;
      const result = commit(
        mapId,
        PLAN_TICKET_CLAIMED_EVENT_TYPE,
        { ticketId, owner },
        { sessionId, now: normalizeNow(input.now) },
        ticketId,
      );
      // First-claim-in-file-order-wins: if a concurrent session's claim landed
      // first, the re-folded map shows their owner — report the loss honestly
      // instead of a false ok.
      if (result.ok && result.map.tickets.find((t) => t.id === ticketId)?.claimedBy !== owner) {
        return { ok: false, reason: "claim_lost", map: result.map };
      }
      return result;
    },

    unclaim(mapId: string, input: PlanTicketUnclaimInput): PlanMapRuntimeMutationResult {
      const sessionId = readString(input.sessionId);
      if (!sessionId) return fail(mapId, "missing_session");
      const map = read(mapId);
      if (!map) return fail(mapId, "map_not_found");
      const ticketId = readString(input.ticketId);
      if (!ticketId) return fail(mapId, "missing_ticket_id");
      const ticket = map.tickets.find((entry) => entry.id === ticketId);
      if (!ticket) return fail(mapId, "ticket_not_found");
      if (ticket.status !== "open") return fail(mapId, "ticket_not_open");
      // Any session may release the claim — a crashed or abandoned owner's claim would
      // otherwise strand the ticket off the frontier forever (the map's one liveness
      // escape hatch). The receipt records who released it.
      if (!ticket.claimedBy) return fail(mapId, "ticket_not_claimed");
      return commit(
        mapId,
        PLAN_TICKET_UNCLAIMED_EVENT_TYPE,
        { ticketId },
        { sessionId, now: normalizeNow(input.now) },
        ticketId,
      );
    },

    rescope(mapId: string, input: PlanTicketRescopeInput): PlanMapRuntimeMutationResult {
      const sessionId = readString(input.sessionId);
      if (!sessionId) return fail(mapId, "missing_session");
      const map = read(mapId);
      if (!map) return fail(mapId, "map_not_found");
      const ticketId = readString(input.ticketId);
      if (!ticketId) return fail(mapId, "missing_ticket_id");
      const ticket = map.tickets.find((entry) => entry.id === ticketId);
      if (!ticket) return fail(mapId, "ticket_not_found");
      if (ticket.status !== "open") return fail(mapId, "ticket_not_open");
      if (input.type !== undefined && !isTicketType(input.type)) {
        return fail(mapId, "invalid_ticket_type");
      }
      const nextType = isTicketType(input.type) ? input.type : undefined;
      const nextTitle = readString(input.title);
      const nextQuestion = readString(input.question);
      // At least one legal field must change: a no-op rescope is rejected at the
      // boundary so the fold never has to settle for an empty re-frame.
      if (!nextType && !nextTitle && !nextQuestion) return fail(mapId, "empty_rescope");
      return commit(
        mapId,
        PLAN_TICKET_RESCOPED_EVENT_TYPE,
        {
          ticketId,
          ...(nextType ? { type: nextType } : {}),
          ...(nextTitle ? { title: nextTitle } : {}),
          ...(nextQuestion ? { question: nextQuestion } : {}),
        },
        { sessionId, now: normalizeNow(input.now) },
        ticketId,
      );
    },

    recordFog(mapId: string, input: PlanFogRecordInput): PlanMapRuntimeMutationResult {
      const sessionId = readString(input.sessionId);
      if (!sessionId) return fail(mapId, "missing_session");
      const map = read(mapId);
      if (!map) return fail(mapId, "map_not_found");
      const text = readString(input.text);
      if (!text) return fail(mapId, "missing_fog_text");
      const now = normalizeNow(input.now);
      fogSequence += 1;
      // The patch id embeds the authoring session so two sessions recording fog in
      // the same millisecond never collide on the fold's dedup key.
      const patchId = `f:${encodeURIComponent(sessionId)}:${now}:${fogSequence}`;
      return commit(
        mapId,
        PLAN_FOG_RECORDED_EVENT_TYPE,
        { patchId, text },
        { sessionId, now },
        undefined,
        patchId,
      );
    },

    graduateFog(mapId: string, input: PlanFogGraduateInput): PlanMapRuntimeMutationResult {
      const sessionId = readString(input.sessionId);
      if (!sessionId) return fail(mapId, "missing_session");
      const map = read(mapId);
      if (!map) return fail(mapId, "map_not_found");
      const patchId = readString(input.patchId);
      if (!patchId) return fail(mapId, "missing_patch_id");
      if (!map.notYetSpecified.some((patch) => patch.id === patchId)) {
        return fail(mapId, "fog_patch_not_found");
      }
      const intoTicketIds = readStringArray(input.intoTicketIds);
      // Graduation must cite the fresh tickets it became; they are opened separately,
      // so the controller validates every cited id already exists on the map.
      if (intoTicketIds.length === 0) return fail(mapId, "missing_into_tickets");
      const known = new Set(map.tickets.map((ticket) => ticket.id));
      for (const intoTicketId of intoTicketIds) {
        if (!known.has(intoTicketId)) return fail(mapId, "unknown_into_ticket");
      }
      return commit(
        mapId,
        PLAN_FOG_GRADUATED_EVENT_TYPE,
        { patchId, intoTicketIds },
        { sessionId, now: normalizeNow(input.now) },
        undefined,
        patchId,
      );
    },
  };
}
