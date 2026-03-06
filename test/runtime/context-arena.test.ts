import { describe, expect, test } from "bun:test";
import { ContextArena } from "@brewva/brewva-runtime";

describe("ContextArena", () => {
  const sessionId = "context-arena-session";

  test("append keeps historical entries (append-only)", () => {
    const arena = new ContextArena();
    arena.append(sessionId, {
      source: "brewva.truth-facts",
      id: "truth-facts",
      content: "fact v1",
    });
    arena.append(sessionId, {
      source: "brewva.truth-facts",
      id: "truth-facts",
      content: "fact v2",
    });

    const snapshot = arena.snapshot(sessionId);
    expect(snapshot.totalAppended).toBe(2);
    expect(snapshot.activeKeys).toBe(1);
  });

  test("plan uses latest value per key (last-write-wins)", () => {
    const arena = new ContextArena();
    arena.append(sessionId, {
      source: "brewva.truth-facts",
      id: "truth-facts",
      content: "old fact",
    });
    arena.append(sessionId, {
      source: "brewva.truth-facts",
      id: "truth-facts",
      content: "new fact",
    });

    const plan = arena.plan(sessionId, 10_000);
    expect(plan.entries).toHaveLength(1);
    expect(plan.entries[0]?.content).toBe("new fact");
  });

  test("re-registering existing key keeps deterministic key order while updating content", () => {
    const arena = new ContextArena();
    arena.append(sessionId, {
      source: "source-a",
      id: "same",
      content: "a-old",
    });
    arena.append(sessionId, {
      source: "source-b",
      id: "b",
      content: "b",
    });
    arena.append(sessionId, {
      source: "source-a",
      id: "same",
      content: "a-new",
    });

    const plan = arena.plan(sessionId, 10_000);
    expect(plan.entries).toHaveLength(2);
    expect(plan.entries[0]?.source).toBe("source-a");
    expect(plan.entries[0]?.content).toBe("a-new");
    expect(plan.entries[1]?.source).toBe("source-b");
  });

  test("markPresented keeps stored entries and suppresses next plan", () => {
    const arena = new ContextArena();
    arena.append(sessionId, {
      source: "brewva.truth-facts",
      id: "truth-facts",
      content: "fact",
    });

    const first = arena.plan(sessionId, 10_000);
    expect(first.entries).toHaveLength(1);
    arena.markPresented(sessionId, first.consumedKeys);
    const snapshot = arena.snapshot(sessionId);
    expect(snapshot.totalAppended).toBe(1);

    const second = arena.plan(sessionId, 10_000);
    expect(second.entries).toHaveLength(0);
  });

  test("oncePerSession prevents re-append after presentation", () => {
    const arena = new ContextArena();
    arena.append(sessionId, {
      source: "brewva.identity",
      id: "identity-1",
      content: "identity",
      oncePerSession: true,
    });
    const first = arena.plan(sessionId, 10_000);
    arena.markPresented(sessionId, first.consumedKeys);

    arena.append(sessionId, {
      source: "brewva.identity",
      id: "identity-1",
      content: "identity-v2",
      oncePerSession: true,
    });
    const second = arena.plan(sessionId, 10_000);
    expect(second.entries).toHaveLength(0);
  });

  test("plan preserves deterministic append order", () => {
    const arena = new ContextArena();
    arena.append(sessionId, {
      source: "brewva.projection-working",
      id: "projection-working",
      content: "projection",
    });
    arena.append(sessionId, {
      source: "brewva.truth-facts",
      id: "truth-facts",
      content: "truth",
    });
    arena.append(sessionId, {
      source: "brewva.task-state",
      id: "task-1",
      content: "task",
    });

    const planned = arena.plan(sessionId, 10_000);
    const sources = planned.entries.map((entry) => entry.source);
    expect(sources).toEqual([
      "brewva.projection-working",
      "brewva.truth-facts",
      "brewva.task-state",
    ]);
  });

  test("clearSession clears the whole session arena", () => {
    const arena = new ContextArena();
    arena.append(sessionId, {
      source: "brewva.truth-facts",
      id: "truth-facts",
      content: "fact",
    });

    arena.clearSession(sessionId);
    const plan = arena.plan(sessionId, 10_000);
    const snapshot = arena.snapshot(sessionId);
    expect(plan.entries).toHaveLength(0);
    expect(snapshot.totalAppended).toBe(0);
  });

  test("trims superseded history under long-session append pressure", () => {
    const arena = new ContextArena();
    const hotSession = "context-arena-hot-session";

    for (let i = 0; i < 2_500; i += 1) {
      arena.append(hotSession, {
        source: "brewva.truth-facts",
        id: "truth-facts",
        content: `fact-${i}`,
      });
    }

    const snapshot = arena.snapshot(hotSession);
    expect(snapshot.totalAppended).toBeLessThan(1_000);
    expect(snapshot.activeKeys).toBe(1);

    const plan = arena.plan(hotSession, 10_000);
    expect(plan.entries).toHaveLength(1);
    expect(plan.entries[0]?.content).toBe("fact-2499");
  });

  test("enforces hard SLO boundary when session arena is full", () => {
    const arena = new ContextArena({
      maxEntriesPerSession: 1,
    });
    arena.append(sessionId, {
      source: "brewva.truth-facts",
      id: "truth-facts",
      content: "truth",
    });
    const dropped = arena.append(sessionId, {
      source: "brewva.tool-failures",
      id: "tool-failures",
      content: "failure summary",
    });
    expect(dropped.accepted).toBe(false);
    expect(dropped.sloEnforced?.dropped).toBe(true);
  });

  test("allows refreshing an existing key when arena is at capacity", () => {
    const arena = new ContextArena({
      maxEntriesPerSession: 2,
    });
    const fullSessionId = "context-arena-refresh-at-capacity";

    arena.append(fullSessionId, {
      source: "brewva.truth-facts",
      id: "truth-facts",
      content: "truth-v1",
    });
    arena.append(fullSessionId, {
      source: "brewva.task-state",
      id: "task-state",
      content: "task-v1",
    });

    const refreshed = arena.append(fullSessionId, {
      source: "brewva.truth-facts",
      id: "truth-facts",
      content: "truth-v2",
    });
    const planned = arena.plan(fullSessionId, 10_000);

    expect(refreshed.accepted).toBe(true);
    expect(planned.entries).toHaveLength(2);
    expect(planned.entries[0]?.content).toBe("truth-v2");
    expect(planned.entries[1]?.content).toBe("task-v1");
  });

  test("snapshot exposes append-only arena counters", () => {
    const snapshotSessionId = "context-arena-snapshot";
    const arena = new ContextArena({
      maxEntriesPerSession: 64,
    });
    arena.append(snapshotSessionId, {
      source: "brewva.truth-facts",
      id: "truth-facts",
      content: "t".repeat(2_000),
    });
    arena.append(snapshotSessionId, {
      source: "vendor.reference",
      id: "reference-block",
      content: "r".repeat(800),
    });

    arena.plan(snapshotSessionId, 421);
    const snapshot = arena.snapshot(snapshotSessionId);

    expect(snapshot.totalAppended).toBe(2);
    expect(snapshot.activeKeys).toBe(2);
    expect(snapshot.onceKeys).toBe(0);
  });
});
