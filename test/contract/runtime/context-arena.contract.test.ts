import { describe, expect, test } from "bun:test";
import { ContextArena } from "@brewva/brewva-runtime";

function budgetClassForSource(source: string): "core" | "working" | "recall" {
  switch (source) {
    case "brewva.projection-working":
    case "source-b":
      return "working";
    case "vendor.reference":
      return "recall";
    default:
      return "core";
  }
}

function makeEntry(
  source: string,
  id: string,
  content: string,
  options: {
    oncePerSession?: boolean;
  } = {},
) {
  return {
    category: "narrative" as const,
    budgetClass: budgetClassForSource(source),
    source,
    id,
    content,
    oncePerSession: options.oncePerSession,
  };
}

describe("ContextArena", () => {
  const sessionId = "context-arena-session";

  test("append keeps historical entries (append-only)", () => {
    const arena = new ContextArena();
    arena.append(sessionId, makeEntry("brewva.runtime-status", "runtime-status", "status v1"));
    arena.append(sessionId, makeEntry("brewva.runtime-status", "runtime-status", "status v2"));

    const snapshot = arena.snapshot(sessionId);
    expect(snapshot.totalAppended).toBe(2);
    expect(snapshot.activeKeys).toBe(1);
  });

  test("plan uses latest value per key (last-write-wins)", () => {
    const arena = new ContextArena();
    arena.append(sessionId, makeEntry("brewva.runtime-status", "runtime-status", "old status"));
    arena.append(sessionId, makeEntry("brewva.runtime-status", "runtime-status", "new status"));

    const plan = arena.plan(sessionId, 10_000);
    expect(plan.entries).toHaveLength(1);
    expect(plan.entries[0]?.content).toBe("new status");
  });

  test("re-registering existing key keeps deterministic key order while updating content", () => {
    const arena = new ContextArena();
    arena.append(sessionId, makeEntry("source-a", "same", "a-old"));
    arena.append(sessionId, makeEntry("source-b", "b", "b"));
    arena.append(sessionId, makeEntry("source-a", "same", "a-new"));

    const plan = arena.plan(sessionId, 10_000);
    expect(plan.entries).toHaveLength(2);
    expect(plan.entries[0]?.source).toBe("source-a");
    expect(plan.entries[0]?.content).toBe("a-new");
    expect(plan.entries[1]?.source).toBe("source-b");
  });

  test("markPresented keeps stored entries and suppresses next plan", () => {
    const arena = new ContextArena();
    arena.append(sessionId, makeEntry("brewva.runtime-status", "runtime-status", "fact"));

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
    arena.append(
      sessionId,
      makeEntry("brewva.identity", "identity-1", "identity", { oncePerSession: true }),
    );
    const first = arena.plan(sessionId, 10_000);
    arena.markPresented(sessionId, first.consumedKeys);

    arena.append(
      sessionId,
      makeEntry("brewva.identity", "identity-1", "identity-v2", { oncePerSession: true }),
    );
    const second = arena.plan(sessionId, 10_000);
    expect(second.entries).toHaveLength(0);
  });

  test("plan preserves deterministic append order", () => {
    const arena = new ContextArena();
    arena.append(
      sessionId,
      makeEntry("brewva.projection-working", "projection-working", "projection"),
    );
    arena.append(sessionId, makeEntry("brewva.runtime-status", "runtime-status", "status"));
    arena.append(sessionId, makeEntry("brewva.task-state", "task-1", "task"));

    const planned = arena.plan(sessionId, 10_000);
    const sources = planned.entries.map((entry) => entry.source);
    expect(sources).toEqual([
      "brewva.projection-working",
      "brewva.runtime-status",
      "brewva.task-state",
    ]);
  });

  test("clearSession clears the whole session arena", () => {
    const arena = new ContextArena();
    arena.append(sessionId, makeEntry("brewva.runtime-status", "runtime-status", "fact"));

    arena.clearSession(sessionId);
    const plan = arena.plan(sessionId, 10_000);
    const snapshot = arena.snapshot(sessionId);
    expect(plan.entries).toHaveLength(0);
    expect(snapshot.totalAppended).toBe(0);
  });

  test("enforces hard SLO boundary when session arena is full", () => {
    const arena = new ContextArena({
      maxEntriesPerSession: 1,
    });
    arena.append(sessionId, makeEntry("brewva.runtime-status", "runtime-status", "status"));
    const dropped = arena.append(
      sessionId,
      makeEntry("brewva.task-state", "task-state", "task summary"),
    );
    expect(dropped.accepted).toBe(false);
    expect(dropped.sloEnforced?.dropped).toBe(true);
  });

  test("allows refreshing an existing key when arena is at capacity", () => {
    const arena = new ContextArena({
      maxEntriesPerSession: 2,
    });
    const fullSessionId = "context-arena-refresh-at-capacity";

    arena.append(fullSessionId, makeEntry("brewva.runtime-status", "runtime-status", "status-v1"));
    arena.append(fullSessionId, makeEntry("brewva.task-state", "task-state", "task-v1"));

    const refreshed = arena.append(
      fullSessionId,
      makeEntry("brewva.runtime-status", "runtime-status", "status-v2"),
    );
    const planned = arena.plan(fullSessionId, 10_000);

    expect(refreshed.accepted).toBe(true);
    expect(planned.entries).toHaveLength(2);
    expect(planned.entries[0]?.content).toBe("status-v2");
    expect(planned.entries[1]?.content).toBe("task-v1");
  });

  test("snapshot exposes append-only arena counters", () => {
    const snapshotSessionId = "context-arena-snapshot";
    const arena = new ContextArena({
      maxEntriesPerSession: 64,
    });
    arena.append(
      snapshotSessionId,
      makeEntry("brewva.runtime-status", "runtime-status", "t".repeat(2_000)),
    );
    arena.append(
      snapshotSessionId,
      makeEntry("vendor.reference", "reference-block", "r".repeat(800)),
    );

    arena.plan(snapshotSessionId, 421);
    const snapshot = arena.snapshot(snapshotSessionId);

    expect(snapshot.totalAppended).toBe(2);
    expect(snapshot.activeKeys).toBe(2);
    expect(snapshot.onceKeys).toBe(0);
  });

  test("retains core entries before recall entries under budget pressure", () => {
    const arena = new ContextArena();
    const budgetSessionId = "context-arena-budget-classes";

    arena.append(
      budgetSessionId,
      makeEntry("brewva.runtime-status", "runtime-status", "core status block remains visible"),
    );
    arena.append(
      budgetSessionId,
      makeEntry(
        "vendor.reference",
        "reference",
        "recall recall recall recall recall recall recall",
      ),
    );

    const planned = arena.plan(budgetSessionId, 8);
    expect(planned.entries.map((entry) => entry.source)).toContain("brewva.runtime-status");
    expect(planned.entries.map((entry) => entry.source)).not.toContain("vendor.reference");
  });

  test("preserves later core floors even when recall entries were appended first", () => {
    const arena = new ContextArena();
    const budgetSessionId = "context-arena-late-core-floor";

    arena.append(
      budgetSessionId,
      makeEntry(
        "vendor.reference",
        "reference-early",
        "reference reference reference reference reference reference reference reference",
      ),
    );
    arena.append(
      budgetSessionId,
      makeEntry("brewva.task-state", "task-state", "task state remains visible"),
    );

    const planned = arena.plan(budgetSessionId, 10);
    expect(planned.entries.map((entry) => entry.source)).toContain("brewva.task-state");
  });
});
