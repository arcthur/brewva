import { describe, expect } from "bun:test";
import { makeEvent } from "@brewva/brewva-vocabulary/events";
import {
  foldPlanMapEvents,
  planMapBlocked,
  planMapClaimed,
  planMapFrontier,
} from "@brewva/brewva-vocabulary/plan-map";
import fc from "fast-check";
import { propertyTest } from "../../helpers/property.js";

const MAP = "map-prop";

type Lifecycle = "open" | "resolved" | "claimed";

interface TicketSpec {
  readonly lifecycle: Lifecycle;
  readonly blockers: readonly number[];
}

// A ticket graph: each ticket may be blocked by earlier tickets (the predicate keeps
// only earlier indices, so the blocking graph is always a DAG), and settles into one
// of open / resolved / claimed.
const ticketGraphArbitrary = fc.array(
  fc.record({
    lifecycle: fc.constantFrom<Lifecycle>("open", "resolved", "claimed"),
    blockers: fc.array(fc.nat(15), { maxLength: 6 }),
  }),
  { minLength: 1, maxLength: 14 },
);

describe("plan-map frontier property", () => {
  propertyTest("the frontier is exactly open, unblocked, and unclaimed tickets", {
    propertyId: "planMap.frontier.open-unblocked-unclaimed",
    layer: "unit",
    arbitraries: [ticketGraphArbitrary],
    predicate: (specs: readonly TicketSpec[]) => {
      const ids = specs.map((_, index) => `t${index}`);
      const events = [makeEvent("plan.map.created", { mapId: MAP, destination: "d", now: 0 })];
      let now = 1;
      specs.forEach((spec, index) => {
        const blockedBy = [...new Set(spec.blockers.filter((blocker) => blocker < index))].map(
          (blocker) => `t${blocker}`,
        );
        events.push(
          makeEvent("plan.ticket.opened", {
            mapId: MAP,
            ticketId: ids[index],
            type: "task",
            title: `T${index}`,
            question: "Q?",
            blockedBy,
            now: (now += 1),
          }),
        );
      });
      specs.forEach((spec, index) => {
        if (spec.lifecycle === "resolved") {
          events.push(
            makeEvent("plan.ticket.resolved", {
              mapId: MAP,
              ticketId: ids[index],
              answer: "a",
              now: (now += 1),
            }),
          );
        } else if (spec.lifecycle === "claimed") {
          events.push(
            makeEvent("plan.ticket.claimed", {
              mapId: MAP,
              ticketId: ids[index],
              owner: "owner",
              now: (now += 1),
            }),
          );
        }
      });

      const state = foldPlanMapEvents(events, MAP);
      if (!state) throw new Error("expected a folded state");

      const openIds = new Set(
        state.tickets.filter((ticket) => ticket.status === "open").map((ticket) => ticket.id),
      );
      // The frontier, computed independently of the selector under test.
      const expectedFrontier = state.tickets
        .filter(
          (ticket) =>
            ticket.status === "open" &&
            !ticket.claimedBy &&
            ticket.blockedBy.every((blocker) => !openIds.has(blocker)),
        )
        .map((ticket) => ticket.id);
      expect(planMapFrontier(state).map((ticket) => ticket.id)).toEqual(expectedFrontier);

      // The three open buckets partition the open tickets: pairwise disjoint and total.
      const frontier = planMapFrontier(state).map((ticket) => ticket.id);
      const blocked = planMapBlocked(state).map((ticket) => ticket.id);
      const claimed = planMapClaimed(state).map((ticket) => ticket.id);
      expect(new Set([...frontier, ...blocked, ...claimed])).toEqual(openIds);
      expect(frontier.length + blocked.length + claimed.length).toBe(openIds.size);
    },
  });
});
