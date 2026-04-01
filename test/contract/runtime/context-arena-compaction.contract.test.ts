import { describe, expect, test } from "bun:test";
import { ContextInjectionCollector } from "@brewva/brewva-runtime";

function makeRegistration(content: string) {
  return {
    category: "narrative" as const,
    budgetClass: "core" as const,
    source: "brewva.identity",
    id: "identity-default",
    content,
    oncePerSession: true,
  };
}

describe("ContextInjectionCollector compaction lifecycle", () => {
  test("compaction resets epoch and once-per-session guard", () => {
    const collector = new ContextInjectionCollector();
    const sessionId = "ctx-arena-compaction";

    collector.register(sessionId, makeRegistration("identity-v1"));
    const first = collector.plan(sessionId, 10_000);
    expect(first.entries).toHaveLength(1);
    collector.commit(sessionId, first.consumedKeys);

    collector.register(sessionId, makeRegistration("identity-v2"));
    const blocked = collector.plan(sessionId, 10_000);
    expect(blocked.entries).toHaveLength(0);

    collector.onCompaction(sessionId);

    collector.register(sessionId, makeRegistration("identity-v3"));
    const afterCompaction = collector.plan(sessionId, 10_000);
    expect(afterCompaction.entries).toHaveLength(1);
    expect(afterCompaction.entries[0]?.content).toBe("identity-v3");
  });
});
