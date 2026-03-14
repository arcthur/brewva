import { describe, expect, test } from "bun:test";
import {
  assertAutoCompactionCompletionContinuity,
  MAX_POST_AUTO_COMPACTION_GAP_MS,
  type CompactionContinuityEvent,
} from "../../helpers/compaction-continuity.js";

describe("compaction continuity assertion helper", () => {
  test("accepts bounded continuation after auto compaction completion", () => {
    const events: CompactionContinuityEvent[] = [
      { type: "context_compaction_auto_completed", timestamp: 1_000 },
      { type: "message_update", timestamp: 1_800 },
      { type: "agent_end", timestamp: 2_200 },
    ];

    expect(() => assertAutoCompactionCompletionContinuity(events)).not.toThrow();
  });

  test("rejects missing continuation before the next turn", () => {
    const events: CompactionContinuityEvent[] = [
      { type: "context_compaction_auto_completed", timestamp: 1_000 },
      { type: "turn_start", timestamp: 2_000 },
    ];

    expect(() => assertAutoCompactionCompletionContinuity(events)).toThrow();
  });

  test("rejects excessive silence after auto compaction completion", () => {
    const events: CompactionContinuityEvent[] = [
      { type: "context_compaction_auto_completed", timestamp: 1_000 },
      { type: "message_update", timestamp: 1_000 + MAX_POST_AUTO_COMPACTION_GAP_MS + 1 },
    ];

    expect(() => assertAutoCompactionCompletionContinuity(events)).toThrow();
  });
});
