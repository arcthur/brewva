import { describe, expect, test } from "bun:test";
import { ContextInjectionCollector } from "@brewva/brewva-runtime";

describe("ContextInjectionCollector characterization", () => {
  test("plans entries in deterministic append order", () => {
    const collector = new ContextInjectionCollector();
    const sessionId = "ctx-char-priority";

    collector.register(sessionId, {
      source: "brewva.projection-working",
      id: "projection-working",
      content: "projection content",
    });
    collector.register(sessionId, {
      source: "brewva.truth-facts",
      id: "truth-facts",
      content: "truth content",
    });

    const planned = collector.plan(sessionId, 10_000);
    expect(planned.entries).toHaveLength(2);
    expect(planned.entries[0]?.source).toBe("brewva.projection-working");
    expect(planned.entries[1]?.source).toBe("brewva.truth-facts");
  });

  test("commit removes consumed entries from next plan", () => {
    const collector = new ContextInjectionCollector();
    const sessionId = "ctx-char-commit";

    collector.register(sessionId, {
      source: "brewva.truth-facts",
      id: "truth-facts",
      content: "fact A",
    });
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

    collector.register(sessionId, {
      source: "brewva.projection-working",
      id: "projection-working",
      content: "x".repeat(5_000),
    });
    const plan = collector.plan(sessionId, 10_000);
    expect(plan.entries).toHaveLength(1);
    expect(plan.entries[0]?.truncated).toBe(true);
    expect((plan.entries[0]?.estimatedTokens ?? 0) <= 5).toBe(true);
  });
});
