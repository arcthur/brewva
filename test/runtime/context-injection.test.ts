import { describe, expect, test } from "bun:test";
import { ContextInjectionCollector } from "@brewva/brewva-runtime";

describe("Context injection collector", () => {
  const estimateTokens = (text: string): number => Math.max(0, Math.ceil(text.length / 3.5));

  test("does not let oversized provided estimates drop later entries", () => {
    const collector = new ContextInjectionCollector();
    const sessionId = "collector-oversized-estimate";

    collector.register(sessionId, {
      source: "source-a",
      id: "a",
      content: "first",
      estimatedTokens: 1000,
    });
    collector.register(sessionId, {
      source: "source-b",
      id: "b",
      content: "second",
      estimatedTokens: 2,
    });

    const merged = collector.consume(sessionId, 16);

    expect(merged.entries).toHaveLength(2);
    expect(merged.text.includes("first")).toBe(true);
    expect(merged.text.includes("second")).toBe(true);
  });

  test("does not consume once-per-session entry before commit", () => {
    const collector = new ContextInjectionCollector();
    const sessionId = "collector-once-before-commit";

    collector.register(sessionId, {
      source: "source-once",
      id: "once-id",
      content: "first pass",
      oncePerSession: true,
    });

    const planned = collector.plan(sessionId, 128);
    expect(planned.entries).toHaveLength(1);
    collector.clearPending(sessionId);

    collector.register(sessionId, {
      source: "source-once",
      id: "once-id",
      content: "second pass",
      oncePerSession: true,
    });
    const consumed = collector.consume(sessionId, 128);

    expect(consumed.entries).toHaveLength(1);
    expect(consumed.text.includes("second pass")).toBe(true);
  });

  test("blocks once-per-session entry after commit", () => {
    const collector = new ContextInjectionCollector();
    const sessionId = "collector-once-after-commit";

    collector.register(sessionId, {
      source: "source-once",
      id: "once-id",
      content: "only once",
      oncePerSession: true,
    });
    const first = collector.consume(sessionId, 128);
    expect(first.entries).toHaveLength(1);

    collector.register(sessionId, {
      source: "source-once",
      id: "once-id",
      content: "should be skipped",
      oncePerSession: true,
    });
    const second = collector.consume(sessionId, 128);
    expect(second.entries).toHaveLength(0);
  });

  test("uses conservative token estimate for dense text", () => {
    const collector = new ContextInjectionCollector();
    const sessionId = "collector-conservative-estimate";
    const dense = "x".repeat(15);

    collector.register(sessionId, {
      source: "source-dense",
      id: "dense",
      content: dense,
    });

    const consumed = collector.consume(sessionId, 128);
    expect(consumed.entries).toHaveLength(1);
    expect(consumed.entries[0]?.estimatedTokens).toBe(5);
  });

  test("oversized entries are truncated under deterministic single-path policy", () => {
    const collector = new ContextInjectionCollector();
    const sessionId = "collector-deterministic-truncate";
    const structured = JSON.stringify({
      skills: ["debugging", "patching", "review"],
      objective: "Fix flaky test and preserve context format",
      notes: "x".repeat(200),
    });

    collector.register(sessionId, {
      source: "source-structured",
      id: "structured",
      content: structured,
    });

    const consumed = collector.consume(sessionId, 10);
    expect(consumed.entries).toHaveLength(1);
    expect(consumed.entries[0]?.truncated).toBe(true);
    expect(consumed.entries[0]?.estimatedTokens).toBeLessThanOrEqual(10);
  });

  test("planning stops after the first truncated oversized entry", () => {
    const collector = new ContextInjectionCollector();
    const sessionId = "collector-deterministic-tail-stop";

    collector.register(sessionId, {
      source: "source-large",
      id: "large",
      content: "x".repeat(200),
    });
    collector.register(sessionId, {
      source: "source-small",
      id: "small",
      content: "small-context",
    });

    const plan = collector.plan(sessionId, 8);
    expect(plan.entries).toHaveLength(1);
    expect(plan.entries[0]?.id).toBe("large");
    expect(plan.entries[0]?.truncated).toBe(true);
    expect(plan.entries.some((entry) => entry.id === "small")).toBe(false);
  });

  test("accounts for entry separators when planning token budget", () => {
    const collector = new ContextInjectionCollector();
    const sessionId = "collector-separator-budget";
    const block = "x".repeat(35);

    collector.register(sessionId, {
      source: "source-a",
      id: "a",
      content: block,
    });
    collector.register(sessionId, {
      source: "source-b",
      id: "b",
      content: block,
    });

    const planned = collector.plan(sessionId, 20);
    expect(planned.entries.length).toBeGreaterThan(0);
    expect(estimateTokens(planned.text)).toBeLessThanOrEqual(20);
  });
});
