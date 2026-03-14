import { describe, expect, test } from "bun:test";
import { ContextArena } from "@brewva/brewva-runtime";

describe("ContextArena SLO enforcement", () => {
  const sessionId = "context-arena-slo-session";

  test("rejects append when arena is full and cannot compact below maxEntries", () => {
    const arena = new ContextArena({
      maxEntriesPerSession: 2,
    });

    const first = arena.append(sessionId, {
      category: "narrative",
      source: "brewva.identity",
      id: "id-1",
      content: "identity entry 1",
    });
    const second = arena.append(sessionId, {
      category: "narrative",
      source: "brewva.task-state",
      id: "task-1",
      content: "task entry 1",
    });
    const third = arena.append(sessionId, {
      category: "narrative",
      source: "brewva.runtime-status",
      id: "runtime-1",
      content: "runtime entry 1",
    });

    expect(first.accepted).toBe(true);
    expect(second.accepted).toBe(true);
    expect(third.accepted).toBe(false);
    expect(third.sloEnforced).toEqual({
      entriesBefore: 2,
      entriesAfter: 2,
      dropped: true,
    });
  });
});
