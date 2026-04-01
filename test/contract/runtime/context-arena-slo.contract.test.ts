import { describe, expect, test } from "bun:test";
import { ContextArena } from "@brewva/brewva-runtime";

function makeEntry(source: string, id: string, content: string) {
  return {
    category: "narrative" as const,
    budgetClass: "core" as const,
    source,
    id,
    content,
  };
}

describe("ContextArena SLO enforcement", () => {
  const sessionId = "context-arena-slo-session";

  test("rejects append when arena is full and cannot compact below maxEntries", () => {
    const arena = new ContextArena({
      maxEntriesPerSession: 2,
    });

    const first = arena.append(sessionId, makeEntry("brewva.identity", "id-1", "identity entry 1"));
    const second = arena.append(
      sessionId,
      makeEntry("brewva.task-state", "task-1", "task entry 1"),
    );
    const third = arena.append(
      sessionId,
      makeEntry("brewva.runtime-status", "runtime-1", "runtime entry 1"),
    );

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
