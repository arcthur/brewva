import { describe, expect, test } from "bun:test";
import {
  assertAutoCompactionCompletionContinuity,
  MAX_POST_AUTO_COMPACTION_GAP_MS,
  type CompactionContinuityEvent,
} from "../../helpers/compaction-continuity.js";

describe("compaction continuity assertion helper", () => {
  test("accepts bounded continuation after auto compaction completion", () => {
    const events: CompactionContinuityEvent[] = [
      { type: "context.compaction.auto.completed", timestamp: 1_000 },
      { type: "message_end", timestamp: 1_800 },
      { type: "agent_end", timestamp: 2_200 },
    ];

    assertAutoCompactionCompletionContinuity(events);
  });

  test("rejects missing continuation before the next turn", () => {
    const events: CompactionContinuityEvent[] = [
      { type: "context.compaction.auto.completed", timestamp: 1_000 },
      { type: "turn_start", timestamp: 2_000 },
    ];

    let error: unknown;
    try {
      assertAutoCompactionCompletionContinuity(events);
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain("toBeGreaterThanOrEqual");
    expect(String(error)).toContain("Received: -1");
  });

  test("rejects excessive silence after auto compaction completion", () => {
    const events: CompactionContinuityEvent[] = [
      { type: "context.compaction.auto.completed", timestamp: 1_000 },
      { type: "message_end", timestamp: 1_000 + MAX_POST_AUTO_COMPACTION_GAP_MS + 1 },
    ];

    let error: unknown;
    try {
      assertAutoCompactionCompletionContinuity(events);
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain("toBeLessThanOrEqual");
    expect(String(error)).toContain("Received: 90001");
  });
});
