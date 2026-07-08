import { payloadOf, type BrewvaEventRecord } from "./events.js";
import type { ProtocolRecord } from "./types/foundation.js";

/**
 * The durable cross-session planning map (RFC: durable-cross-session-planning-map).
 *
 * The map is the third answer to "the work does not fit in one context," beside
 * compaction (lossy continuation) and the goal control plane (single persistent
 * intent). It holds a frontier of open decisions as append-only receipts that a
 * pure fold rebuilds into `PlanMapState`. This module is the pure contract layer:
 * event-type constants, the state shape, the fold, and the read-only frontier
 * selectors. It performs no I/O — the effort-scoped durable substrate and the
 * emit path live in the gateway, exactly as `foldGoalEvents` is pure and the
 * `goal.*` emit path lives in the runtime-ops controller.
 */

export const PLAN_MAP_SCHEMA = "brewva.plan-map.v1" as const;

export const PLAN_TICKET_TYPE_VALUES = [
  "research",
  "prototype",
  "grilling",
  "task",
  "decision",
] as const;

export type PlanTicketType = (typeof PLAN_TICKET_TYPE_VALUES)[number];

export type PlanTicketStatus = "open" | "closed";

/**
 * A ticket closes for exactly one reason. `resolved` is carried by its own
 * `plan.ticket.resolved` event (it also records the answer); `out_of_scope` and
 * `invalidated` are carried by `plan.ticket.closed`. A ruled-out ticket is closed
 * `out_of_scope`, never resolved — it stays off the route the decisions record.
 */
export const PLAN_TICKET_CLOSE_REASON_VALUES = ["resolved", "out_of_scope", "invalidated"] as const;

export type PlanTicketCloseReason = (typeof PLAN_TICKET_CLOSE_REASON_VALUES)[number];

export const PLAN_MAP_CREATED_EVENT_TYPE = "plan.map.created" as const;
export const PLAN_MAP_DESTINATION_SET_EVENT_TYPE = "plan.map.destination.set" as const;
export const PLAN_MAP_NOTES_SET_EVENT_TYPE = "plan.map.notes.set" as const;
export const PLAN_TICKET_OPENED_EVENT_TYPE = "plan.ticket.opened" as const;
export const PLAN_TICKET_RESOLVED_EVENT_TYPE = "plan.ticket.resolved" as const;
export const PLAN_TICKET_CLOSED_EVENT_TYPE = "plan.ticket.closed" as const;
export const PLAN_TICKET_CLAIMED_EVENT_TYPE = "plan.ticket.claimed" as const;
export const PLAN_TICKET_UNCLAIMED_EVENT_TYPE = "plan.ticket.unclaimed" as const;
export const PLAN_TICKET_RESCOPED_EVENT_TYPE = "plan.ticket.rescoped" as const;
export const PLAN_FOG_RECORDED_EVENT_TYPE = "plan.fog.recorded" as const;
export const PLAN_FOG_GRADUATED_EVENT_TYPE = "plan.fog.graduated" as const;

export const PLAN_MAP_EVENT_TYPES = [
  PLAN_MAP_CREATED_EVENT_TYPE,
  PLAN_MAP_DESTINATION_SET_EVENT_TYPE,
  PLAN_MAP_NOTES_SET_EVENT_TYPE,
  PLAN_TICKET_OPENED_EVENT_TYPE,
  PLAN_TICKET_RESOLVED_EVENT_TYPE,
  PLAN_TICKET_CLOSED_EVENT_TYPE,
  PLAN_TICKET_CLAIMED_EVENT_TYPE,
  PLAN_TICKET_UNCLAIMED_EVENT_TYPE,
  PLAN_TICKET_RESCOPED_EVENT_TYPE,
  PLAN_FOG_RECORDED_EVENT_TYPE,
  PLAN_FOG_GRADUATED_EVENT_TYPE,
] as const;

export type PlanMapEventType = (typeof PLAN_MAP_EVENT_TYPES)[number];

export interface PlanTicket extends ProtocolRecord {
  readonly id: string;
  readonly type: PlanTicketType;
  readonly title: string;
  readonly question: string;
  /** Sibling ticket ids that must close before this ticket enters the frontier. */
  readonly blockedBy: readonly string[];
  readonly status: PlanTicketStatus;
  readonly closeReason?: PlanTicketCloseReason;
  /** The owner of the first claim; cleared by an unclaim. */
  readonly claimedBy?: string;
  readonly claimedAt?: number;
  /** Recorded on resolve. */
  readonly answer?: string;
  readonly assetRefs?: readonly string[];
  /** The `why` recorded on a close — `out_of_scope` or `invalidated`. */
  readonly closeNote?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** A "Not yet specified" patch: in-scope fog too unsharp to ticket yet (Phase 2). */
export interface PlanFogPatch extends ProtocolRecord {
  readonly id: string;
  readonly text: string;
  readonly createdAt: number;
}

/**
 * A graduated fog patch: the projected lineage of a fog patch that became fresh
 * tickets. Retained so `get_plan_map` can show "this fog became those tickets"
 * rather than the graduation being a write-only audit on the tape.
 */
export interface PlanFogGraduation extends ProtocolRecord {
  readonly patchId: string;
  readonly text: string;
  readonly intoTicketIds: readonly string[];
  readonly graduatedAt: number;
}

export interface PlanMapState extends ProtocolRecord {
  readonly schema: typeof PLAN_MAP_SCHEMA;
  readonly mapId: string;
  readonly destination: string;
  readonly notes: string;
  /** All tickets in open order; frontier/decisions/etc. are derived selectors. */
  readonly tickets: readonly PlanTicket[];
  readonly notYetSpecified: readonly PlanFogPatch[];
  /** Fog patches that graduated, with the tickets they became (lineage projection). */
  readonly graduatedFog: readonly PlanFogGraduation[];
  readonly createdAt: number;
  readonly updatedAt: number;
}

/**
 * Mutation inputs for the runtime-ops controller. Each carries the authoring
 * `sessionId` (the receipt author and future claim owner) and an optional `now`
 * (a deterministic clock for tests; the controller defaults to wall-clock).
 */
export interface PlanMapCreateInput extends ProtocolRecord {
  readonly sessionId: string;
  readonly destination: string;
  readonly notes?: string;
  readonly now?: number;
}

export interface PlanTicketOpenInput extends ProtocolRecord {
  readonly sessionId: string;
  readonly type: PlanTicketType;
  readonly title: string;
  readonly question: string;
  readonly blockedBy?: readonly string[];
  readonly now?: number;
}

export interface PlanTicketResolveInput extends ProtocolRecord {
  readonly sessionId: string;
  readonly ticketId: string;
  readonly answer: string;
  readonly assetRefs?: readonly string[];
  readonly now?: number;
}

export interface PlanTicketCloseInput extends ProtocolRecord {
  readonly sessionId: string;
  readonly ticketId: string;
  readonly reason: Exclude<PlanTicketCloseReason, "resolved">;
  readonly why?: string;
  readonly now?: number;
}

export interface PlanTicketClaimInput extends ProtocolRecord {
  readonly sessionId: string;
  /** The ticket to claim; when omitted, the controller claims the first frontier ticket. */
  readonly ticketId?: string;
  /** The claim owner; defaults to the authoring `sessionId` when omitted. */
  readonly owner?: string;
  readonly now?: number;
}

/**
 * Release a claim so the ticket returns to the frontier. Open to any session (not
 * only the claim owner) so a stranded claim from a crashed or abandoned session can
 * be recovered — the map's liveness escape hatch, symmetric with claim.
 */
export interface PlanTicketUnclaimInput extends ProtocolRecord {
  readonly sessionId: string;
  readonly ticketId: string;
  readonly now?: number;
}

/**
 * Re-frame an already-open ticket in place: a mis-typed or mis-worded ticket that
 * is still on the route. At least one of `type` / `title` / `question` must change;
 * the ticket keeps its id and its inbound blocking edges (so siblings blocked on it
 * stay wired). Distinct from a close — a rescope never settles the ticket.
 */
export interface PlanTicketRescopeInput extends ProtocolRecord {
  readonly sessionId: string;
  readonly ticketId: string;
  readonly type?: PlanTicketType;
  readonly title?: string;
  readonly question?: string;
  readonly now?: number;
}

/** Record a "Not yet specified" fog patch: an in-scope question too unsharp to ticket. */
export interface PlanFogRecordInput extends ProtocolRecord {
  readonly sessionId: string;
  readonly text: string;
  readonly now?: number;
}

/**
 * Graduate a fog patch: it leaves the Not-yet-specified list and lives on only as
 * the fresh tickets it became (opened separately via `open`, cited here by id).
 */
export interface PlanFogGraduateInput extends ProtocolRecord {
  readonly sessionId: string;
  readonly patchId: string;
  readonly intoTicketIds: readonly string[];
  readonly now?: number;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readStringArray(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value
        .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
        .filter((entry) => entry.length > 0)
    : [];
}

function readTicketType(value: unknown): PlanTicketType | undefined {
  return typeof value === "string" && PLAN_TICKET_TYPE_VALUES.includes(value as PlanTicketType)
    ? (value as PlanTicketType)
    : undefined;
}

function readClosedReason(value: unknown): Exclude<PlanTicketCloseReason, "resolved"> | undefined {
  return value === "out_of_scope" || value === "invalidated" ? value : undefined;
}

function eventNow(event: BrewvaEventRecord, payload: ProtocolRecord): number {
  return readNumber(payload.now) ?? event.timestamp;
}

/**
 * Rebuild the map projection for one `mapId` from its append-only receipt stream.
 *
 * Pure and deterministic: the same events in the same order always produce the
 * same state. First-write-wins on identity (a duplicate `created`/`opened` is
 * ignored), and a mutation to an already-closed ticket is ignored — so a torn or
 * replayed suffix cannot rewrite a settled decision. Ticket order is open order
 * (a `Map` preserves insertion position across in-place updates).
 */
export function foldPlanMapEvents(
  events: readonly BrewvaEventRecord[],
  mapId: string,
): PlanMapState | null {
  const wantMapId = mapId.trim();
  let created = false;
  let destination = "";
  let notes = "";
  let createdAt = 0;
  let updatedAt = 0;
  const tickets = new Map<string, PlanTicket>();
  const fog = new Map<string, PlanFogPatch>();
  const graduated = new Map<string, PlanFogGraduation>();

  const touch = (now: number): void => {
    if (now > updatedAt) updatedAt = now;
  };

  for (const event of events) {
    if (!PLAN_MAP_EVENT_TYPES.includes(event.type as PlanMapEventType)) continue;
    const payload = payloadOf(event);
    if (readString(payload.mapId) !== wantMapId) continue;
    const now = eventNow(event, payload);

    switch (event.type) {
      case PLAN_MAP_CREATED_EVENT_TYPE: {
        if (created) break; // first-write-wins; a duplicate create is idempotent
        created = true;
        destination = readString(payload.destination) ?? "";
        notes = readString(payload.notes) ?? "";
        createdAt = now;
        updatedAt = now;
        break;
      }
      case PLAN_MAP_DESTINATION_SET_EVENT_TYPE: {
        const next = readString(payload.destination);
        if (created && next !== undefined) {
          destination = next;
          touch(now);
        }
        break;
      }
      case PLAN_MAP_NOTES_SET_EVENT_TYPE: {
        const next = readString(payload.notes);
        if (created && next !== undefined) {
          notes = next;
          touch(now);
        }
        break;
      }
      case PLAN_TICKET_OPENED_EVENT_TYPE: {
        const ticketId = readString(payload.ticketId);
        const title = readString(payload.title);
        const question = readString(payload.question);
        const type = readTicketType(payload.type);
        if (!created || !ticketId || !title || !question || !type || tickets.has(ticketId)) break;
        tickets.set(
          ticketId,
          Object.freeze({
            id: ticketId,
            type,
            title,
            question,
            blockedBy: readStringArray(payload.blockedBy),
            status: "open",
            createdAt: now,
            updatedAt: now,
          }),
        );
        touch(now);
        break;
      }
      case PLAN_TICKET_RESOLVED_EVENT_TYPE: {
        const ticketId = readString(payload.ticketId);
        const ticket = ticketId ? tickets.get(ticketId) : undefined;
        const answer = readString(payload.answer);
        // A resolve carries the decision; without an answer (a torn or malformed
        // receipt) the ticket is left open rather than settled into an empty,
        // gist-less decision — symmetric with the close branch, fail closed.
        if (!ticket || ticket.status !== "open" || !answer) break;
        tickets.set(
          ticket.id,
          Object.freeze({
            ...ticket,
            status: "closed",
            closeReason: "resolved",
            answer,
            assetRefs: readStringArray(payload.assetRefs),
            updatedAt: now,
          }),
        );
        touch(now);
        break;
      }
      case PLAN_TICKET_CLOSED_EVENT_TYPE: {
        const ticketId = readString(payload.ticketId);
        const ticket = ticketId ? tickets.get(ticketId) : undefined;
        const reason = readClosedReason(payload.reason);
        // A close with no legal reason (a torn or malformed receipt) is ignored,
        // leaving the ticket open and visible rather than settling it into an
        // invisible `invalidated` sink it could never leave (fail closed).
        if (!ticket || ticket.status !== "open" || !reason) break;
        const note = readString(payload.why);
        tickets.set(
          ticket.id,
          Object.freeze({
            ...ticket,
            status: "closed",
            closeReason: reason,
            ...(note ? { closeNote: note } : {}),
            updatedAt: now,
          }),
        );
        touch(now);
        break;
      }
      case PLAN_TICKET_CLAIMED_EVENT_TYPE: {
        const ticketId = readString(payload.ticketId);
        const owner = readString(payload.owner) ?? readString(event.sessionId);
        const ticket = ticketId ? tickets.get(ticketId) : undefined;
        // First claim in file order wins: a claim on an unclaimed, open ticket sets
        // the owner; a later claim (another session raced) is ignored — deterministic
        // mutual exclusion from the append order, no lock.
        if (!ticket || ticket.status !== "open" || ticket.claimedBy || !owner) break;
        tickets.set(
          ticket.id,
          Object.freeze({ ...ticket, claimedBy: owner, claimedAt: now, updatedAt: now }),
        );
        touch(now);
        break;
      }
      case PLAN_TICKET_UNCLAIMED_EVENT_TYPE: {
        const ticketId = readString(payload.ticketId);
        const ticket = ticketId ? tickets.get(ticketId) : undefined;
        // Release a claim: the ticket returns to the frontier. Any session may
        // unclaim (a crashed/abandoned owner's claim must be recoverable), so there
        // is no owner gate here — the receipt records who released it. An open ticket
        // carries no close/resolve fields, so the base rebuild drops only the claim.
        if (!ticket || ticket.status !== "open" || !ticket.claimedBy) break;
        tickets.set(
          ticket.id,
          Object.freeze({
            id: ticket.id,
            type: ticket.type,
            title: ticket.title,
            question: ticket.question,
            blockedBy: ticket.blockedBy,
            status: ticket.status,
            createdAt: ticket.createdAt,
            updatedAt: now,
          }),
        );
        touch(now);
        break;
      }
      case PLAN_TICKET_RESCOPED_EVENT_TYPE: {
        const ticketId = readString(payload.ticketId);
        const ticket = ticketId ? tickets.get(ticketId) : undefined;
        // Re-frame an open ticket in place, keeping its id and inbound blocking edges.
        // A settled ticket is immutable (a torn or replayed rescope cannot rewrite a
        // decision), and a rescope carrying no legal field is ignored — leaving the
        // ticket as it was rather than blanking its title/question.
        if (!ticket || ticket.status !== "open") break;
        const nextType = readTicketType(payload.type);
        const nextTitle = readString(payload.title);
        const nextQuestion = readString(payload.question);
        if (!nextType && !nextTitle && !nextQuestion) break;
        tickets.set(
          ticket.id,
          Object.freeze({
            ...ticket,
            ...(nextType ? { type: nextType } : {}),
            ...(nextTitle ? { title: nextTitle } : {}),
            ...(nextQuestion ? { question: nextQuestion } : {}),
            updatedAt: now,
          }),
        );
        touch(now);
        break;
      }
      case PLAN_FOG_RECORDED_EVENT_TYPE: {
        const patchId = readString(payload.patchId);
        const text = readString(payload.text);
        // First-write-wins on patch identity; a recorded patch with no text (a torn
        // receipt) is dropped rather than surfaced as an empty fog line.
        if (!created || !patchId || !text || fog.has(patchId)) break;
        fog.set(patchId, Object.freeze({ id: patchId, text, createdAt: now }));
        touch(now);
        break;
      }
      case PLAN_FOG_GRADUATED_EVENT_TYPE: {
        const patchId = readString(payload.patchId);
        const patch = patchId ? fog.get(patchId) : undefined;
        // A graduated patch leaves the Not-yet-specified list and is projected as its
        // lineage (which tickets it became), so `get_plan_map` can show the
        // graduation rather than it being a write-only tape audit. The fresh tickets
        // are opened separately (cited on the receipt by id). An unknown patch no-ops.
        if (!patch) break;
        graduated.set(
          patch.id,
          Object.freeze({
            patchId: patch.id,
            text: patch.text,
            intoTicketIds: readStringArray(payload.intoTicketIds),
            graduatedAt: now,
          }),
        );
        fog.delete(patch.id);
        touch(now);
        break;
      }
      default:
        break;
    }
  }

  if (!created) return null;
  return Object.freeze({
    schema: PLAN_MAP_SCHEMA,
    mapId: wantMapId,
    destination,
    notes,
    tickets: Object.freeze([...tickets.values()]),
    notYetSpecified: Object.freeze([...fog.values()]),
    graduatedFog: Object.freeze([...graduated.values()]),
    createdAt,
    updatedAt,
  });
}

function openTicketIds(state: PlanMapState): ReadonlySet<string> {
  return new Set(state.tickets.filter((ticket) => ticket.status === "open").map((t) => t.id));
}

/**
 * The frontier: open, unblocked, and unclaimed tickets — the takeable edge of the
 * map. A ticket is unblocked when no `blockedBy` id still names an open ticket; a
 * dangling blocker (an id with no open ticket) does not block, because the
 * controller validates blockers at open time, so the fold stays lenient.
 */
export function planMapFrontier(state: PlanMapState): readonly PlanTicket[] {
  const open = openTicketIds(state);
  return state.tickets.filter(
    (ticket) =>
      ticket.status === "open" &&
      !ticket.claimedBy &&
      ticket.blockedBy.every((blockerId) => !open.has(blockerId)),
  );
}

/** Open, unclaimed tickets still waiting on at least one open blocker. */
export function planMapBlocked(state: PlanMapState): readonly PlanTicket[] {
  const open = openTicketIds(state);
  return state.tickets.filter(
    (ticket) =>
      ticket.status === "open" &&
      !ticket.claimedBy &&
      ticket.blockedBy.some((blockerId) => open.has(blockerId)),
  );
}

/** Open tickets a session currently holds a claim on (an unclaim returns them to the frontier). */
export function planMapClaimed(state: PlanMapState): readonly PlanTicket[] {
  return state.tickets.filter((ticket) => ticket.status === "open" && Boolean(ticket.claimedBy));
}

/** The route actually walked: tickets closed by resolution. */
export function planMapDecisions(state: PlanMapState): readonly PlanTicket[] {
  return state.tickets.filter((ticket) => ticket.closeReason === "resolved");
}

/** Tickets ruled beyond the destination; recorded, never on the decisions route. */
export function planMapOutOfScope(state: PlanMapState): readonly PlanTicket[] {
  return state.tickets.filter((ticket) => ticket.closeReason === "out_of_scope");
}

/**
 * Tickets deliberately invalidated: settled, but off both the decisions route and
 * the scope ledger. A named selector so a surface can show them rather than
 * leaving invalidation an invisible sink reachable only through raw `tickets`.
 */
export function planMapInvalidated(state: PlanMapState): readonly PlanTicket[] {
  return state.tickets.filter((ticket) => ticket.closeReason === "invalidated");
}

// ---------------------------------------------------------------------------
// Command grammar (shared by the `/map` interactive + channel surfaces)
// ---------------------------------------------------------------------------

/**
 * The `/map` command grammar. Every subcommand names the map explicitly (the mapId
 * is the effort's key), so both surfaces stay stateless — there is no per-session
 * "active map" pointer to drift from, or outlive, the durable cross-session log.
 */
export type PlanMapCommand =
  | { readonly kind: "chart"; readonly mapId: string; readonly destination: string }
  | { readonly kind: "show"; readonly mapId: string }
  | { readonly kind: "take"; readonly mapId: string; readonly ticketId?: string }
  | {
      readonly kind: "resolve";
      readonly mapId: string;
      readonly ticketId: string;
      readonly answer: string;
    };

export type PlanMapCommandParseResult =
  | { readonly ok: true; readonly command: PlanMapCommand }
  | { readonly ok: false; readonly error: string };

const PLAN_MAP_USAGE =
  "Usage: /map chart <mapId> <destination> | show <mapId> | take <mapId> [ticketId] | resolve <mapId> <ticketId> <answer>";

function tokenizePlanMapCommand(input: string): string[] {
  return input
    .trim()
    .split(/\s+/u)
    .filter((token) => token.length > 0);
}

/**
 * Parse the body of a `/map` command (the text after `/map`). Pure and surface-
 * agnostic: the CLI reducer and the channel parser both call it, then dispatch the
 * returned command to the same `planMap` runtime capability.
 */
export function parsePlanMapCommand(input: string): PlanMapCommandParseResult {
  const tokens = tokenizePlanMapCommand(input);
  const sub = tokens[0];
  if (!sub) return { ok: false, error: PLAN_MAP_USAGE };

  switch (sub) {
    case "chart": {
      const mapId = tokens[1];
      const destination = tokens.slice(2).join(" ").trim();
      if (!mapId || !destination) {
        return { ok: false, error: "Usage: /map chart <mapId> <destination>" };
      }
      return { ok: true, command: { kind: "chart", mapId, destination } };
    }
    case "show": {
      const mapId = tokens[1];
      if (!mapId) return { ok: false, error: "Usage: /map show <mapId>" };
      return { ok: true, command: { kind: "show", mapId } };
    }
    case "take": {
      const mapId = tokens[1];
      if (!mapId) return { ok: false, error: "Usage: /map take <mapId> [ticketId]" };
      const ticketId = tokens[2];
      return { ok: true, command: { kind: "take", mapId, ...(ticketId ? { ticketId } : {}) } };
    }
    case "resolve": {
      const mapId = tokens[1];
      const ticketId = tokens[2];
      const answer = tokens.slice(3).join(" ").trim();
      if (!mapId || !ticketId || !answer) {
        return { ok: false, error: "Usage: /map resolve <mapId> <ticketId> <answer>" };
      }
      return { ok: true, command: { kind: "resolve", mapId, ticketId, answer } };
    }
    default:
      return { ok: false, error: `Unsupported /map subcommand: ${sub}` };
  }
}
