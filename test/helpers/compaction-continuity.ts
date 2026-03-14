import { expect } from "bun:test";

export type CompactionContinuityEvent = {
  type?: unknown;
  timestamp?: unknown;
};

const POST_AUTO_COMPACTION_CONTINUATION_TYPES = new Set([
  "message_start",
  "message_update",
  "message_end",
  "tool_call",
  "tool_execution_start",
  "tool_execution_update",
  "tool_execution_end",
  "tool_result",
]);

const POST_AUTO_COMPACTION_CLOSURE_TYPES = new Set(["turn_end", "agent_end"]);
const MAX_POST_AUTO_COMPACTION_EVENT_WINDOW = 24;
const MAX_POST_AUTO_COMPACTION_GAP_MS = 90_000;

function eventIndexes(events: CompactionContinuityEvent[], eventType: string): number[] {
  const indexes: number[] = [];
  for (let index = 0; index < events.length; index += 1) {
    if (events[index]?.type === eventType) {
      indexes.push(index);
    }
  }
  return indexes;
}

function eventTypeOf(event: CompactionContinuityEvent | undefined): string {
  return typeof event?.type === "string" ? event.type : "";
}

function eventTimestampOf(event: CompactionContinuityEvent | undefined): number | null {
  return typeof event?.timestamp === "number" ? event.timestamp : null;
}

export function assertAutoCompactionCompletionContinuity(
  events: CompactionContinuityEvent[],
): void {
  const completionIndexes = eventIndexes(events, "context_compaction_auto_completed");
  if (completionIndexes.length === 0) return;

  for (const completionIndex of completionIndexes) {
    const nextTurnStart =
      eventIndexes(events, "turn_start").find((index) => index > completionIndex) ?? events.length;
    const searchEnd = Math.min(
      nextTurnStart,
      completionIndex + 1 + MAX_POST_AUTO_COMPACTION_EVENT_WINDOW,
    );
    const recoveryIndex = events.slice(completionIndex + 1, searchEnd).findIndex((event) => {
      const type = eventTypeOf(event);
      return (
        POST_AUTO_COMPACTION_CONTINUATION_TYPES.has(type) ||
        POST_AUTO_COMPACTION_CLOSURE_TYPES.has(type)
      );
    });

    expect(recoveryIndex).toBeGreaterThanOrEqual(0);
    if (recoveryIndex < 0) continue;

    const absoluteRecoveryIndex = completionIndex + 1 + recoveryIndex;
    const completionTimestamp = eventTimestampOf(events[completionIndex]);
    const recoveryTimestamp = eventTimestampOf(events[absoluteRecoveryIndex]);

    if (completionTimestamp !== null && recoveryTimestamp !== null) {
      expect(recoveryTimestamp - completionTimestamp).toBeLessThanOrEqual(
        MAX_POST_AUTO_COMPACTION_GAP_MS,
      );
    }
  }
}

export { MAX_POST_AUTO_COMPACTION_GAP_MS };
