import { describe, expect, test } from "bun:test";
import { makeEvent } from "@brewva/brewva-vocabulary/events";
import {
  foldPlanMapEvents,
  parsePlanMapCommand,
  planMapBlocked,
  planMapClaimed,
  planMapDecisions,
  planMapFrontier,
  planMapInvalidated,
  planMapOutOfScope,
} from "@brewva/brewva-vocabulary/plan-map";

const MAP = "map-1";

function created(now: number, extra: Record<string, unknown> = {}) {
  return makeEvent("plan.map.created", {
    mapId: MAP,
    destination: "Decide the storage substrate",
    now,
    ...extra,
  });
}

function opened(id: string, now: number, extra: Record<string, unknown> = {}) {
  return makeEvent("plan.ticket.opened", {
    mapId: MAP,
    ticketId: id,
    type: "decision",
    title: `Ticket ${id}`,
    question: `What about ${id}?`,
    now,
    ...extra,
  });
}

function resolved(id: string, now: number, answer: string) {
  return makeEvent("plan.ticket.resolved", { mapId: MAP, ticketId: id, answer, now });
}

function closed(id: string, now: number, reason: string, why?: string) {
  return makeEvent("plan.ticket.closed", { mapId: MAP, ticketId: id, reason, why, now });
}

function destinationSet(now: number, destination: string) {
  return makeEvent("plan.map.destination.set", { mapId: MAP, destination, now });
}

function notesSet(now: number, notes: string) {
  return makeEvent("plan.map.notes.set", { mapId: MAP, notes, now });
}

function claimed(id: string, now: number, owner: string) {
  return makeEvent("plan.ticket.claimed", { mapId: MAP, ticketId: id, owner, now });
}

function unclaimed(id: string, now: number) {
  return makeEvent("plan.ticket.unclaimed", { mapId: MAP, ticketId: id, now });
}

function rescoped(id: string, now: number, fields: Record<string, unknown>) {
  return makeEvent("plan.ticket.rescoped", { mapId: MAP, ticketId: id, now, ...fields });
}

function fogRecorded(patchId: string, now: number, text: string) {
  return makeEvent("plan.fog.recorded", { mapId: MAP, patchId, text, now });
}

function fogGraduated(patchId: string, now: number, intoTicketIds: string[]) {
  return makeEvent("plan.fog.graduated", { mapId: MAP, patchId, intoTicketIds, now });
}

describe("plan-map vocabulary", () => {
  test("folds a map with tickets, resolution, and out-of-scope close", () => {
    const state = foldPlanMapEvents(
      [
        created(10, { notes: "domain: substrate" }),
        opened("t1", 20),
        opened("t2", 30, { blockedBy: ["t1"] }),
        resolved("t1", 40, "Use the effort-scoped sidecar"),
        closed("t2", 50, "out_of_scope", "belongs to a later effort"),
      ],
      MAP,
    );

    expect(state).not.toBeNull();
    expect(state).toMatchObject({
      schema: "brewva.plan-map.v1",
      mapId: MAP,
      destination: "Decide the storage substrate",
      notes: "domain: substrate",
      createdAt: 10,
      updatedAt: 50,
      notYetSpecified: [],
    });
    expect(state?.tickets).toHaveLength(2);
    expect(state?.tickets[0]).toMatchObject({
      id: "t1",
      status: "closed",
      closeReason: "resolved",
      answer: "Use the effort-scoped sidecar",
    });
    expect(state?.tickets[1]).toMatchObject({
      id: "t2",
      status: "closed",
      closeReason: "out_of_scope",
      closeNote: "belongs to a later effort",
    });
  });

  test("frontier is open and unblocked; a ticket waits on its open blocker", () => {
    const blockedState = foldPlanMapEvents(
      [created(10), opened("t1", 20), opened("t2", 30, { blockedBy: ["t1"] })],
      MAP,
    );
    expect(blockedState).not.toBeNull();
    expect(planMapFrontier(blockedState!).map((t) => t.id)).toEqual(["t1"]);
    expect(planMapBlocked(blockedState!).map((t) => t.id)).toEqual(["t2"]);

    const unblockedState = foldPlanMapEvents(
      [
        created(10),
        opened("t1", 20),
        opened("t2", 30, { blockedBy: ["t1"] }),
        resolved("t1", 40, "done"),
      ],
      MAP,
    );
    expect(planMapFrontier(unblockedState!).map((t) => t.id)).toEqual(["t2"]);
    expect(planMapBlocked(unblockedState!)).toEqual([]);
    expect(planMapDecisions(unblockedState!).map((t) => t.id)).toEqual(["t1"]);
  });

  test("is deterministic: the same receipts fold to a deeply equal state", () => {
    const events = [
      created(10),
      opened("t1", 20),
      opened("t2", 30, { blockedBy: ["t1"] }),
      resolved("t1", 40, "answer"),
      closed("t2", 50, "invalidated"),
    ];
    expect(foldPlanMapEvents(events, MAP)).toEqual(foldPlanMapEvents(events, MAP));
  });

  test("ignores events addressed to another map", () => {
    const state = foldPlanMapEvents(
      [
        created(10),
        opened("t1", 20),
        makeEvent("plan.ticket.opened", {
          mapId: "other-map",
          ticketId: "x9",
          type: "research",
          title: "foreign",
          question: "not ours?",
          now: 25,
        }),
      ],
      MAP,
    );
    expect(state?.tickets.map((t) => t.id)).toEqual(["t1"]);
  });

  test("first-write-wins on identity; a closed ticket is immutable", () => {
    const state = foldPlanMapEvents(
      [
        created(10, { destination: "First" }),
        created(20, { destination: "Second" }), // duplicate create ignored
        opened("t1", 30, { title: "First title" }),
        opened("t1", 40, { title: "Reopened title" }), // duplicate open ignored
        resolved("t1", 50, "first answer"),
        resolved("t1", 60, "second answer"), // mutation to closed ticket ignored
        closed("t1", 70, "invalidated"), // also ignored
      ],
      MAP,
    );
    expect(state?.destination).toBe("First");
    expect(state?.tickets).toHaveLength(1);
    expect(state?.tickets[0]).toMatchObject({
      title: "First title",
      status: "closed",
      closeReason: "resolved",
      answer: "first answer",
    });
  });

  test("returns null when no create receipt anchors the map", () => {
    expect(foldPlanMapEvents([opened("t1", 20)], MAP)).toBeNull();
    expect(foldPlanMapEvents([], MAP)).toBeNull();
  });

  test("a dangling blocker does not wedge the frontier", () => {
    const state = foldPlanMapEvents(
      [created(10), opened("t1", 20, { blockedBy: ["never-opened"] })],
      MAP,
    );
    // The blocker id names no open ticket, so t1 is takeable rather than stuck.
    expect(planMapFrontier(state!).map((t) => t.id)).toEqual(["t1"]);
    expect(planMapOutOfScope(state!)).toEqual([]);
  });

  test("destination.set and notes.set update an existing map", () => {
    const state = foldPlanMapEvents(
      [
        created(10, { destination: "First", notes: "n1" }),
        destinationSet(20, "Second"),
        notesSet(30, "n2"),
        destinationSet(40, "   "), // a blank update is ignored
      ],
      MAP,
    );
    expect(state).toMatchObject({ destination: "Second", notes: "n2", updatedAt: 30 });
  });

  test("a ticket event without mapId is dropped (every receipt must carry mapId)", () => {
    const state = foldPlanMapEvents(
      [
        created(10),
        opened("t1", 20),
        // omits mapId — the emit path must stamp it, or the fold drops it silently
        makeEvent("plan.ticket.resolved", { ticketId: "t1", answer: "done", now: 30 }),
      ],
      MAP,
    );
    expect(state?.tickets[0]?.status).toBe("open");
    expect(planMapDecisions(state!)).toEqual([]);
  });

  test("a close with no legal reason leaves the ticket open (fail closed)", () => {
    const torn = foldPlanMapEvents(
      [
        created(10),
        opened("t1", 20),
        makeEvent("plan.ticket.closed", { mapId: MAP, ticketId: "t1", now: 30 }),
      ],
      MAP,
    );
    expect(torn?.tickets[0]?.status).toBe("open");
    expect(planMapFrontier(torn!).map((t) => t.id)).toEqual(["t1"]);

    // "resolved" is not a legal *closed* reason — resolution has its own event.
    const wrongReason = foldPlanMapEvents(
      [created(10), opened("t1", 20), closed("t1", 30, "resolved")],
      MAP,
    );
    expect(wrongReason?.tickets[0]?.status).toBe("open");
  });

  test("a resolve without an answer leaves the ticket open (fail closed)", () => {
    const state = foldPlanMapEvents(
      [
        created(10),
        opened("t1", 20),
        makeEvent("plan.ticket.resolved", { mapId: MAP, ticketId: "t1", now: 30 }),
      ],
      MAP,
    );
    expect(state?.tickets[0]?.status).toBe("open");
    expect(planMapDecisions(state!)).toEqual([]);
  });

  test("invalidated tickets are their own bucket with a projected close note", () => {
    const state = foldPlanMapEvents(
      [created(10), opened("t1", 20), closed("t1", 30, "invalidated", "superseded by t5")],
      MAP,
    );
    expect(planMapInvalidated(state!).map((t) => t.id)).toEqual(["t1"]);
    // The `why` of an invalidated close is projected, not a write-only sink.
    expect(state?.tickets[0]?.closeNote).toBe("superseded by t5");
    expect(planMapDecisions(state!)).toEqual([]);
    expect(planMapOutOfScope(state!)).toEqual([]);
    expect(planMapFrontier(state!)).toEqual([]);
    expect(planMapBlocked(state!)).toEqual([]);
    expect(planMapClaimed(state!)).toEqual([]);
  });

  test("first claim in file order wins; a claimed ticket leaves the frontier", () => {
    const state = foldPlanMapEvents(
      [
        created(10),
        opened("t1", 20),
        claimed("t1", 30, "session-a"),
        claimed("t1", 40, "session-b"), // a raced second claim is ignored
      ],
      MAP,
    );
    expect(state?.tickets[0]?.claimedBy).toBe("session-a");
    expect(planMapClaimed(state!).map((t) => t.id)).toEqual(["t1"]);
    expect(planMapFrontier(state!)).toEqual([]);
  });

  test("a claim on a closed or unknown ticket is ignored", () => {
    const state = foldPlanMapEvents(
      [
        created(10),
        opened("t1", 20),
        resolved("t1", 30, "done"),
        claimed("t1", 40, "late"), // closed ticket cannot be claimed
        claimed("ghost", 50, "nobody"), // unknown ticket
      ],
      MAP,
    );
    // Both claims no-op: only t1 exists (no ghost), it is unclaimed, and it stayed
    // a resolved decision.
    expect(state?.tickets.map((t) => t.id)).toEqual(["t1"]);
    expect(planMapClaimed(state!)).toEqual([]);
    expect(planMapDecisions(state!).map((t) => t.id)).toEqual(["t1"]);
  });

  test("falls back to the event timestamp when the payload omits now", () => {
    const createEvent = makeEvent("plan.map.created", { mapId: MAP, destination: "d" });
    const state = foldPlanMapEvents([createEvent], MAP);
    expect(state?.createdAt).toBe(createEvent.timestamp);
    expect(state?.updatedAt).toBe(createEvent.timestamp);
  });

  test("rescope re-frames an open ticket in place, keeping its id, edges, and claim", () => {
    const state = foldPlanMapEvents(
      [
        created(10),
        opened("t1", 20),
        opened("t2", 30, { blockedBy: ["t1"] }),
        claimed("t2", 35, "session-a"),
        rescoped("t2", 40, { type: "research", title: "Reframed", question: "Sharper?" }),
      ],
      MAP,
    );
    expect(state?.tickets.find((t) => t.id === "t2")).toMatchObject({
      id: "t2",
      type: "research",
      title: "Reframed",
      question: "Sharper?",
      status: "open",
      blockedBy: ["t1"],
      claimedBy: "session-a",
      updatedAt: 40,
    });
  });

  test("a rescope of a settled ticket, or one carrying no legal field, is ignored", () => {
    const settled = foldPlanMapEvents(
      [
        created(10),
        opened("t1", 20),
        resolved("t1", 30, "done"),
        rescoped("t1", 40, { title: "too late" }),
      ],
      MAP,
    );
    expect(settled?.tickets[0]).toMatchObject({ status: "closed", title: "Ticket t1" });

    const empty = foldPlanMapEvents([created(10), opened("t1", 20), rescoped("t1", 30, {})], MAP);
    expect(empty?.tickets[0]).toMatchObject({ title: "Ticket t1", updatedAt: 20 });
  });

  test("fog is recorded into Not-yet-specified; first-write-wins, empty text dropped", () => {
    const state = foldPlanMapEvents(
      [
        created(10),
        fogRecorded("p1", 20, "How should auth work?"),
        fogRecorded("p1", 30, "duplicate patch id ignored"),
        makeEvent("plan.fog.recorded", { mapId: MAP, patchId: "p2", now: 40 }), // no text
      ],
      MAP,
    );
    expect(state?.notYetSpecified).toEqual([
      { id: "p1", text: "How should auth work?", createdAt: 20 },
    ]);
  });

  test("graduating a fog patch removes it from Not-yet-specified and projects its lineage", () => {
    const state = foldPlanMapEvents(
      [
        created(10),
        fogRecorded("p1", 20, "auth question"),
        opened("t9", 30),
        fogGraduated("p1", 40, ["t9"]),
      ],
      MAP,
    );
    expect(state?.notYetSpecified).toEqual([]);
    // The fresh ticket the patch became lives on independently.
    expect(state?.tickets.map((t) => t.id)).toEqual(["t9"]);
    // The graduation lineage is projected (not a write-only audit).
    expect(state?.graduatedFog).toEqual([
      { patchId: "p1", text: "auth question", intoTicketIds: ["t9"], graduatedAt: 40 },
    ]);
  });

  test("unclaim releases a claim and returns the ticket to the frontier", () => {
    const state = foldPlanMapEvents(
      [created(10), opened("t1", 20), claimed("t1", 30, "session-a"), unclaimed("t1", 40)],
      MAP,
    );
    expect(state?.tickets[0]).not.toHaveProperty("claimedBy");
    expect(planMapClaimed(state!)).toEqual([]);
    expect(planMapFrontier(state!).map((t) => t.id)).toEqual(["t1"]);
    expect(state?.tickets[0]?.updatedAt).toBe(40);
  });

  test("unclaim of an unclaimed or settled ticket is ignored", () => {
    const stillOpen = foldPlanMapEvents([created(10), opened("t1", 20), unclaimed("t1", 30)], MAP);
    expect(stillOpen?.tickets[0]).toMatchObject({ status: "open", updatedAt: 20 });

    const settled = foldPlanMapEvents(
      [created(10), opened("t1", 20), resolved("t1", 30, "done"), unclaimed("t1", 40)],
      MAP,
    );
    expect(settled?.tickets[0]).toMatchObject({ status: "closed", closeReason: "resolved" });
  });
});

describe("parsePlanMapCommand", () => {
  test("parses each subcommand with its explicit mapId", () => {
    expect(parsePlanMapCommand("chart auth Redesign the auth flow")).toEqual({
      ok: true,
      command: { kind: "chart", mapId: "auth", destination: "Redesign the auth flow" },
    });
    expect(parsePlanMapCommand("show auth")).toEqual({
      ok: true,
      command: { kind: "show", mapId: "auth" },
    });
    expect(parsePlanMapCommand("take auth t1")).toEqual({
      ok: true,
      command: { kind: "take", mapId: "auth", ticketId: "t1" },
    });
    expect(parsePlanMapCommand("take auth")).toEqual({
      ok: true,
      command: { kind: "take", mapId: "auth" },
    });
    expect(parsePlanMapCommand("resolve auth t1 Use the effort-scoped sidecar")).toEqual({
      ok: true,
      command: {
        kind: "resolve",
        mapId: "auth",
        ticketId: "t1",
        answer: "Use the effort-scoped sidecar",
      },
    });
  });

  test("rejects missing arguments and unknown subcommands", () => {
    expect(parsePlanMapCommand("").ok).toBe(false);
    expect(parsePlanMapCommand("chart auth").ok).toBe(false); // no destination
    expect(parsePlanMapCommand("show").ok).toBe(false); // no mapId
    expect(parsePlanMapCommand("resolve auth t1").ok).toBe(false); // no answer
    expect(parsePlanMapCommand("frobnicate whatever").ok).toBe(false);
  });
});
