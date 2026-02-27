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
      priority: "critical",
    });
    arena.append(sessionId, {
      source: "brewva.truth-facts",
      id: "truth-facts",
      content: "fact v2",
      priority: "critical",
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
      priority: "critical",
    });
    arena.append(sessionId, {
      source: "brewva.truth-facts",
      id: "truth-facts",
      content: "new fact",
      priority: "critical",
    });

    const plan = arena.plan(sessionId, 10_000);
    expect(plan.entries).toHaveLength(1);
    expect(plan.entries[0]?.content).toBe("new fact");
  });

  test("markPresented keeps stored entries and suppresses next plan", () => {
    const arena = new ContextArena();
    arena.append(sessionId, {
      source: "brewva.truth-facts",
      id: "truth-facts",
      content: "fact",
      priority: "critical",
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
      priority: "critical",
      oncePerSession: true,
    });
    const first = arena.plan(sessionId, 10_000);
    arena.markPresented(sessionId, first.consumedKeys);

    arena.append(sessionId, {
      source: "brewva.identity",
      id: "identity-1",
      content: "identity-v2",
      priority: "critical",
      oncePerSession: true,
    });
    const second = arena.plan(sessionId, 10_000);
    expect(second.entries).toHaveLength(0);
  });

  test("zoneLayout orders entries by zone before priority", () => {
    const arena = new ContextArena({ zoneLayout: true });
    arena.append(sessionId, {
      source: "brewva.memory-working",
      id: "memory-working",
      content: "memory",
      priority: "critical",
    });
    arena.append(sessionId, {
      source: "brewva.truth-facts",
      id: "truth-facts",
      content: "truth",
      priority: "normal",
    });
    arena.append(sessionId, {
      source: "brewva.identity",
      id: "identity-1",
      content: "identity",
      priority: "low",
    });
    arena.append(sessionId, {
      source: "brewva.task-state",
      id: "task-1",
      content: "task",
      priority: "high",
    });

    const planned = arena.plan(sessionId, 10_000);
    const sources = planned.entries.map((entry) => entry.source);
    expect(sources).toEqual([
      "brewva.identity",
      "brewva.truth-facts",
      "brewva.task-state",
      "brewva.memory-working",
    ]);
  });

  test("resetEpoch clears the whole session arena", () => {
    const arena = new ContextArena();
    arena.append(sessionId, {
      source: "brewva.truth-facts",
      id: "truth-facts",
      content: "fact",
      priority: "critical",
    });

    arena.resetEpoch(sessionId);
    const plan = arena.plan(sessionId, 10_000);
    const snapshot = arena.snapshot(sessionId);
    expect(plan.entries).toHaveLength(0);
    expect(snapshot.totalAppended).toBe(0);
  });

  test("plan returns floor_unmet when zone floors exceed total budget", () => {
    const arena = new ContextArena({
      zoneLayout: true,
      zoneBudgets: {
        identity: { min: 0, max: 320 },
        truth: { min: 500, max: 1000 },
        task_state: { min: 500, max: 1000 },
        tool_failures: { min: 0, max: 240 },
        memory_working: { min: 0, max: 300 },
        memory_recall: { min: 0, max: 600 },
      },
    });
    arena.append(sessionId, {
      source: "brewva.truth-facts",
      id: "truth-facts",
      content: "t".repeat(2_500),
      priority: "critical",
    });
    arena.append(sessionId, {
      source: "brewva.task-state",
      id: "task-1",
      content: "s".repeat(2_500),
      priority: "critical",
    });

    const planned = arena.plan(sessionId, 100);
    expect(planned.entries).toHaveLength(0);
    expect(planned.text).toBe("");
    expect(planned.planReason).toBe("floor_unmet");
  });

  test("trims superseded history under long-session append pressure", () => {
    const arena = new ContextArena();
    const hotSession = "context-arena-hot-session";

    for (let i = 0; i < 2_500; i += 1) {
      arena.append(hotSession, {
        source: "brewva.truth-facts",
        id: "truth-facts",
        content: `fact-${i}`,
        priority: "critical",
      });
    }

    const snapshot = arena.snapshot(hotSession);
    expect(snapshot.totalAppended).toBeLessThan(1_000);
    expect(snapshot.activeKeys).toBe(1);

    const plan = arena.plan(hotSession, 10_000);
    expect(plan.entries).toHaveLength(1);
    expect(plan.entries[0]?.content).toBe("fact-2499");
  });
});
