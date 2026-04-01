import { describe, expect, test } from "bun:test";
import { ContextInjectionCollector } from "@brewva/brewva-runtime";

function makeRegistration(
  source: string,
  id: string,
  content: string,
  options: {
    estimatedTokens?: number;
    oncePerSession?: boolean;
    budgetClass?: "core" | "working" | "recall";
  } = {},
) {
  return {
    category: "narrative" as const,
    budgetClass:
      options.budgetClass ?? (source === "brewva.projection-working" ? "working" : "core"),
    source,
    id,
    content,
    estimatedTokens: options.estimatedTokens,
    oncePerSession: options.oncePerSession,
  };
}

describe("Context injection collector", () => {
  const estimateTokens = (text: string): number => Math.max(0, Math.ceil(text.length / 3.5));

  test("does not let oversized provided estimates drop later entries", () => {
    const collector = new ContextInjectionCollector();
    const sessionId = "collector-oversized-estimate";

    collector.register(
      sessionId,
      makeRegistration("source-a", "a", "first", { estimatedTokens: 1000 }),
    );
    collector.register(
      sessionId,
      makeRegistration("source-b", "b", "second", { estimatedTokens: 2 }),
    );

    const merged = collector.consume(sessionId, 16);

    expect(merged.entries).toHaveLength(2);
    expect(merged.text).toContain("first");
    expect(merged.text).toContain("second");
  });

  test("does not consume once-per-session entry before commit", () => {
    const collector = new ContextInjectionCollector();
    const sessionId = "collector-once-before-commit";

    collector.register(
      sessionId,
      makeRegistration("source-once", "once-id", "first pass", { oncePerSession: true }),
    );

    const planned = collector.plan(sessionId, 128);
    expect(planned.entries).toHaveLength(1);
    collector.clearPending(sessionId);

    collector.register(
      sessionId,
      makeRegistration("source-once", "once-id", "second pass", { oncePerSession: true }),
    );
    const consumed = collector.consume(sessionId, 128);

    expect(consumed.entries).toHaveLength(1);
    expect(consumed.text).toContain("second pass");
  });

  test("blocks once-per-session entry after commit", () => {
    const collector = new ContextInjectionCollector();
    const sessionId = "collector-once-after-commit";

    collector.register(
      sessionId,
      makeRegistration("source-once", "once-id", "only once", { oncePerSession: true }),
    );
    const first = collector.consume(sessionId, 128);
    expect(first.entries).toHaveLength(1);

    collector.register(
      sessionId,
      makeRegistration("source-once", "once-id", "should be skipped", { oncePerSession: true }),
    );
    const second = collector.consume(sessionId, 128);
    expect(second.entries).toHaveLength(0);
  });

  test("uses conservative token estimate for dense text", () => {
    const collector = new ContextInjectionCollector();
    const sessionId = "collector-conservative-estimate";
    const dense = "x".repeat(15);

    collector.register(sessionId, makeRegistration("source-dense", "dense", dense));

    const consumed = collector.consume(sessionId, 128);
    expect(consumed.entries).toHaveLength(1);
    expect(consumed.entries[0]?.estimatedTokens).toBe(5);
  });

  test("oversized entries are truncated under deterministic single-path policy", () => {
    const collector = new ContextInjectionCollector();
    const sessionId = "collector-deterministic-truncate";
    const structured = JSON.stringify({
      skills: ["debugging", "implementation", "review"],
      objective: "Fix flaky test and preserve context format",
      notes: "x".repeat(200),
    });

    collector.register(sessionId, makeRegistration("source-structured", "structured", structured));

    const consumed = collector.consume(sessionId, 10);
    expect(consumed.entries).toHaveLength(1);
    expect(consumed.entries[0]?.truncated).toBe(true);
    expect(consumed.entries[0]?.estimatedTokens).toBeLessThanOrEqual(10);
  });

  test("collector stops after the first truncated oversized entry", () => {
    const collector = new ContextInjectionCollector();
    const sessionId = "collector-deterministic-tail-stop";

    collector.register(sessionId, makeRegistration("source-large", "large", "x".repeat(200)));
    collector.register(sessionId, makeRegistration("source-small", "small", "small-context"));

    const plan = collector.plan(sessionId, 8);
    expect(plan.entries).toHaveLength(1);
    expect(plan.entries[0]?.id).toBe("large");
    expect(plan.entries[0]?.truncated).toBe(true);
    expect(plan.entries.map((entry) => entry.id)).not.toContain("small");
  });

  test("accounts for entry separators when planning token budget", () => {
    const collector = new ContextInjectionCollector();
    const sessionId = "collector-separator-budget";
    const block = "x".repeat(35);

    collector.register(sessionId, makeRegistration("source-a", "a", block));
    collector.register(sessionId, makeRegistration("source-b", "b", block));

    const planned = collector.plan(sessionId, 20);
    expect(planned.entries.length).toBeGreaterThan(0);
    expect(estimateTokens(planned.text)).toBeLessThanOrEqual(20);
  });

  test("plans entries in deterministic append order", () => {
    const collector = new ContextInjectionCollector();
    const sessionId = "ctx-char-priority";

    collector.register(
      sessionId,
      makeRegistration("brewva.projection-working", "projection-working", "projection content"),
    );
    collector.register(
      sessionId,
      makeRegistration("brewva.runtime-status", "runtime-status", "runtime status content"),
    );

    const planned = collector.plan(sessionId, 10_000);
    expect(planned.entries).toHaveLength(2);
    expect(planned.entries[0]?.source).toBe("brewva.projection-working");
    expect(planned.entries[1]?.source).toBe("brewva.runtime-status");
  });

  test("commit removes consumed entries from next plan", () => {
    const collector = new ContextInjectionCollector();
    const sessionId = "ctx-char-commit";

    collector.register(
      sessionId,
      makeRegistration("brewva.runtime-status", "runtime-status", "fact A"),
    );
    const planned = collector.plan(sessionId, 10_000);
    collector.commit(sessionId, planned.consumedKeys);

    const second = collector.plan(sessionId, 10_000);
    expect(second.entries).toHaveLength(0);
    expect(second.text).toBe("");
  });

  test("sourceTokenLimits truncates individual source entries deterministically", () => {
    const collector = new ContextInjectionCollector({
      sourceTokenLimits: {
        "brewva.projection-working": 5,
      },
    });
    const sessionId = "ctx-char-source-limit";

    collector.register(
      sessionId,
      makeRegistration("brewva.projection-working", "projection-working", "x".repeat(5_000)),
    );
    const plan = collector.plan(sessionId, 10_000);
    expect(plan.entries).toHaveLength(1);
    expect(plan.entries[0]?.truncated).toBe(true);
    expect(plan.entries[0]?.estimatedTokens).toBeLessThanOrEqual(5);
  });
});
