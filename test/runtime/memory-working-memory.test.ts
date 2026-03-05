import { describe, expect, test } from "bun:test";
import { buildWorkingMemorySnapshot, type MemoryUnit } from "@brewva/brewva-runtime";

function unit(input: {
  id: string;
  type: MemoryUnit["type"];
  statement: string;
  confidence?: number;
}): MemoryUnit {
  const now = Date.now();
  return {
    id: input.id,
    sessionId: "session-1",
    type: input.type,
    status: "active",
    topic: input.type,
    statement: input.statement,
    confidence: input.confidence ?? 0.8,
    fingerprint: `fp-${input.id}`,
    sourceRefs: [
      {
        eventId: `evt-${input.id}`,
        eventType: "task_event",
        sessionId: "session-1",
        timestamp: now,
      },
    ],
    createdAt: now,
    updatedAt: now,
    lastSeenAt: now,
  };
}

describe("working memory snapshot", () => {
  test("builds sectioned content from units", () => {
    const snapshot = buildWorkingMemorySnapshot({
      sessionId: "session-1",
      units: [
        unit({ id: "u1", type: "fact", statement: "Current deployment is blocked by CI" }),
        unit({ id: "u2", type: "decision", statement: "Use Bun for all test workflows" }),
        unit({ id: "u3", type: "constraint", statement: "No backward compatibility layer" }),
      ],
      maxChars: 2_000,
    });

    expect(snapshot.content.includes("[WorkingMemory]")).toBe(true);
    expect(snapshot.content.includes("Decisions")).toBe(true);
    expect(snapshot.content.includes("Constraints")).toBe(true);
    expect(snapshot.sourceUnitIds).toEqual(["u1", "u2", "u3"]);
  });

  test("respects maxChars cap", () => {
    const snapshot = buildWorkingMemorySnapshot({
      sessionId: "session-1",
      units: [unit({ id: "u1", type: "fact", statement: "a".repeat(2_000) })],
      maxChars: 220,
    });

    expect(snapshot.content.length).toBeLessThanOrEqual(220);
  });
});
