import { describe, expect, test } from "bun:test";
import type { BrewvaEventRecord } from "@brewva/brewva-runtime/events";
import type { WorkbenchEntry } from "@brewva/brewva-runtime/workbench";
import type { BrewvaSessionMessageEntry } from "@brewva/brewva-substrate/session";
import type { BrewvaTurnLoopMessage } from "@brewva/brewva-substrate/turn";
import {
  applyWorkbenchEvictionsToMessages,
  shouldExcludeSessionEntryForWorkbench,
} from "../../../packages/brewva-gateway/src/hosted/internal/session/projection/workbench-visibility.js";

function eviction(sourceRefs: string[]): WorkbenchEntry {
  return {
    id: "wb_1_deadbeef0000",
    kind: "eviction",
    content: "Read output was already distilled.",
    sourceRefs,
    reason: "Raw output should not stay in default rendering.",
    createdTurn: 1,
    digest: "deadbeef",
    reversible: true,
    baselineCommitted: false,
  };
}

describe("workbench visibility", () => {
  test("marks matching tool-result messages excluded from context", () => {
    const messages: BrewvaTurnLoopMessage[] = [
      {
        role: "toolResult",
        toolCallId: "call-read-1",
        toolName: "read",
        content: [{ type: "text", text: "large output" }],
        isError: false,
        timestamp: 1,
      },
      {
        role: "user",
        content: [{ type: "text", text: "continue" }],
        timestamp: 2,
      },
    ];

    const result = applyWorkbenchEvictionsToMessages({
      messages,
      workbenchEntries: [eviction(["tool:read:call-read-1"])],
    });

    expect(result.excludedCount).toBe(1);
    expect(result.appliedSpanRefs).toEqual(["tool:read:call-read-1"]);
    expect(result.messages[0]).toEqual(
      expect.objectContaining({
        excludeFromContext: true,
        details: expect.objectContaining({
          workbenchEviction: expect.objectContaining({
            spanRefs: ["tool:read:call-read-1"],
          }),
        }),
      }),
    );
    expect(result.messages[1]?.excludeFromContext).toBeUndefined();
  });

  test("excludes session entries by event and turn refs before compaction rendering", () => {
    const entry = {
      type: "message",
      id: "entry-1",
      parentId: null,
      timestamp: new Date(0).toISOString(),
      message: {
        role: "user",
        content: [{ type: "text", text: "old instruction" }],
        timestamp: 1,
      } as BrewvaSessionMessageEntry["message"],
    } satisfies BrewvaSessionMessageEntry;
    const sourceEvent = {
      id: "event-1",
      sessionId: "session-1",
      type: "message_end",
      timestamp: 1,
      turn: 7,
      payload: {},
    } as BrewvaEventRecord;

    expect(
      shouldExcludeSessionEntryForWorkbench({
        entry,
        sourceEvent,
        index: 0,
        workbenchEntries: [eviction(["event:event-1"])],
      }),
    ).toBe(true);
    expect(
      shouldExcludeSessionEntryForWorkbench({
        entry,
        sourceEvent,
        index: 0,
        workbenchEntries: [eviction(["turn:6..8"])],
      }),
    ).toBe(true);
  });
});
