import { describe, expect, test } from "bun:test";
import type { BrewvaRuntimeRoot } from "@brewva/brewva-runtime";
import { MESSAGE_END_EVENT_TYPE, type BrewvaEventRecord } from "@brewva/brewva-runtime/events";
import type { ContextEntryRecord } from "@brewva/brewva-runtime/session";
import { buildInheritedSubagentContextBlock } from "../../../packages/brewva-gateway/src/delegation/fork-context.js";

const SESSION_BRANCH_SUMMARY_RECORDED_EVENT_TYPE = "branch_summary_recorded";

function buildTranscriptMessagePayload(message: Record<string, unknown>): Record<string, unknown> {
  return { message };
}

function event(input: {
  id: string;
  type: string;
  payload: Record<string, unknown>;
}): BrewvaEventRecord {
  return {
    id: input.id,
    sessionId: "session-fork-context" as BrewvaEventRecord["sessionId"],
    type: input.type as BrewvaEventRecord["type"],
    timestamp: 1,
    payload: input.payload as BrewvaEventRecord["payload"],
  };
}

function contextEntry(input: {
  entryId: string;
  sourceEventId: string;
  sourceEventType: string;
  parentEntryId?: string | null;
}): ContextEntryRecord {
  return {
    schema: "brewva.context.entry.recorded.v1",
    eventId: `lineage-${input.entryId}`,
    timestamp: 1,
    entryId: input.entryId,
    lineageNodeId: "lineage:main",
    parentEntryId: input.parentEntryId ?? null,
    sourceEventId: input.sourceEventId,
    sourceEventType: input.sourceEventType,
    entryKind: "message",
    admission: "context_required",
    presentTo: "both",
  };
}

function runtimeWithContext(
  entries: ContextEntryRecord[],
  events: BrewvaEventRecord[],
): Pick<BrewvaRuntimeRoot, "inspect"> {
  return {
    inspect: {
      session: {
        lineage: {
          getContextEntryPath: () => entries,
        },
      },
      events: {
        records: {
          list: () => events,
        },
      },
    },
  } as unknown as Pick<BrewvaRuntimeRoot, "inspect">;
}

describe("subagent fork context", () => {
  test("renders filtered parent mainline context without raw tool frames or thinking", () => {
    const events = [
      event({
        id: "event-user",
        type: MESSAGE_END_EVENT_TYPE,
        payload: buildTranscriptMessagePayload({
          role: "user",
          timestamp: 1,
          content: [{ type: "text", text: "User goal" }],
        }),
      }),
      event({
        id: "event-assistant",
        type: MESSAGE_END_EVENT_TYPE,
        payload: buildTranscriptMessagePayload({
          role: "assistant",
          timestamp: 2,
          content: [
            { type: "text", text: "Visible answer" },
            { type: "thinking", text: "Internal reasoning must not leak" },
            { type: "tool_call", name: "exec", arguments: "{}" },
          ],
          api: "responses",
          provider: "provider",
          model: "model",
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 },
          stopReason: "stop",
        }),
      }),
      event({
        id: "event-tool-result",
        type: MESSAGE_END_EVENT_TYPE,
        payload: buildTranscriptMessagePayload({
          role: "toolResult",
          timestamp: 3,
          toolCallId: "tc-1",
          toolName: "read_spans",
          content: [{ type: "text", text: "raw tool output" }],
          isError: false,
        }),
      }),
      event({
        id: "event-summary",
        type: SESSION_BRANCH_SUMMARY_RECORDED_EVENT_TYPE,
        payload: {
          summary: "Branch summary visible to the child.",
          targetLeafEntryId: null,
          fromId: null,
        },
      }),
      event({
        id: "event-recent-user",
        type: MESSAGE_END_EVENT_TYPE,
        payload: buildTranscriptMessagePayload({
          role: "user",
          timestamp: 4,
          content: [{ type: "text", text: "Recent user turn" }],
        }),
      }),
    ];
    const entries = [
      contextEntry({
        entryId: "entry-user",
        sourceEventId: "event-user",
        sourceEventType: MESSAGE_END_EVENT_TYPE,
      }),
      contextEntry({
        entryId: "entry-assistant",
        sourceEventId: "event-assistant",
        sourceEventType: MESSAGE_END_EVENT_TYPE,
        parentEntryId: "entry-user",
      }),
      contextEntry({
        entryId: "entry-tool-result",
        sourceEventId: "event-tool-result",
        sourceEventType: MESSAGE_END_EVENT_TYPE,
        parentEntryId: "entry-assistant",
      }),
      contextEntry({
        entryId: "entry-summary",
        sourceEventId: "event-summary",
        sourceEventType: SESSION_BRANCH_SUMMARY_RECORDED_EVENT_TYPE,
        parentEntryId: "entry-tool-result",
      }),
      contextEntry({
        entryId: "entry-recent-user",
        sourceEventId: "event-recent-user",
        sourceEventType: MESSAGE_END_EVENT_TYPE,
        parentEntryId: "entry-summary",
      }),
    ];

    const rendered = buildInheritedSubagentContextBlock({
      runtime: runtimeWithContext(entries, events),
      sessionId: "session-fork-context",
      forkTurns: "all",
    })?.content;

    expect(rendered).toContain("Policy: forkTurns=all");
    expect(rendered).toContain("User goal");
    expect(rendered).toContain("Visible answer");
    expect(rendered).toContain("Branch summary visible to the child.");
    expect(rendered).toContain("Recent user turn");
    expect(rendered).not.toContain("raw tool output");
    expect(rendered).not.toContain("Internal reasoning must not leak");
    expect(rendered).not.toContain("tool_call");
  });

  test("selects recent inherited turns and omits context for none", () => {
    const events = [
      event({
        id: "event-first",
        type: MESSAGE_END_EVENT_TYPE,
        payload: buildTranscriptMessagePayload({
          role: "user",
          timestamp: 1,
          content: [{ type: "text", text: "Old context" }],
        }),
      }),
      event({
        id: "event-second",
        type: MESSAGE_END_EVENT_TYPE,
        payload: buildTranscriptMessagePayload({
          role: "user",
          timestamp: 2,
          content: [{ type: "text", text: "Recent context" }],
        }),
      }),
    ];
    const entries = [
      contextEntry({
        entryId: "entry-first",
        sourceEventId: "event-first",
        sourceEventType: MESSAGE_END_EVENT_TYPE,
      }),
      contextEntry({
        entryId: "entry-second",
        sourceEventId: "event-second",
        sourceEventType: MESSAGE_END_EVENT_TYPE,
        parentEntryId: "entry-first",
      }),
    ];
    const runtime = runtimeWithContext(entries, events);

    const recent = buildInheritedSubagentContextBlock({
      runtime,
      sessionId: "session-fork-context",
      forkTurns: 1,
    })?.content;
    expect(recent).toContain("Recent context");
    expect(recent).not.toContain("Old context");

    const none = buildInheritedSubagentContextBlock({
      runtime,
      sessionId: "session-fork-context",
      forkTurns: "none",
    });
    expect({ none }).toEqual({ none: undefined });
  });
});
