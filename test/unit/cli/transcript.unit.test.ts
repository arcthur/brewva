import { describe, expect, test } from "bun:test";
import {
  buildSeedTranscriptMessages,
  buildTranscriptMessageFromMessage,
  upsertToolExecutionIntoTranscriptMessages,
} from "../../../packages/brewva-cli/src/shell/transcript.js";

describe("cli transcript model", () => {
  test("skips hidden assistant draft messages", () => {
    const hiddenAssistantDraft = {
      role: "assistant",
      display: false,
      stopReason: "stop",
      content: [{ type: "text", text: "Draft answer that must not be shown." }],
    };

    expect(
      buildTranscriptMessageFromMessage(hiddenAssistantDraft, {
        id: "assistant:hidden",
      }),
    ).toBeNull();

    expect(buildSeedTranscriptMessages([hiddenAssistantDraft])).toEqual([]);
  });

  test("skips hidden custom messages while preserving visible notes", () => {
    const hiddenContextInjection = {
      role: "custom",
      customType: "brewva-context-injection",
      content: "[TaskLedger]\nstatus.phase=investigate",
      display: false,
    };

    expect(
      buildTranscriptMessageFromMessage(hiddenContextInjection, {
        id: "custom:hidden",
      }),
    ).toBeNull();

    expect(buildSeedTranscriptMessages([hiddenContextInjection])).toEqual([]);

    const visibleNote = buildTranscriptMessageFromMessage(
      {
        role: "custom",
        customType: "note",
        content: "Operator note",
        display: true,
      },
      {
        id: "custom:visible",
      },
    );

    expect(visibleNote).toMatchObject({
      role: "custom",
      parts: [{ type: "text", text: "Operator note" }],
    });
  });

  test("builds assistant transcript messages with reasoning, markdown text, and grouped tool parts", () => {
    const messages = buildSeedTranscriptMessages([
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Check the file first." },
          { type: "text", text: "# Plan\n\n- inspect\n- patch" },
          {
            type: "toolCall",
            id: "tool-read-1",
            name: "read",
            arguments: { path: "src/app.ts", offset: 1, limit: 20 },
          },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "tool-read-1",
        toolName: "read",
        content: [{ type: "text", text: "const value = 1;" }],
        details: { firstLine: 1 },
        isError: false,
      },
    ]);

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      role: "assistant",
      parts: [
        { type: "reasoning", text: "Check the file first." },
        { type: "text", text: "# Plan\n\n- inspect\n- patch" },
        {
          type: "tool",
          toolCallId: "tool-read-1",
          toolName: "read",
          trust: {
            phase: "inspect",
            label: "Inspect",
          },
          status: "completed",
          result: {
            details: { firstLine: 1 },
          },
        },
      ],
    });
  });

  test("preserves tool result display metadata", () => {
    const messages = buildSeedTranscriptMessages([
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "tool-json-1",
            name: "structured_process",
            arguments: { payload: { nested: true } },
          },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "tool-json-1",
        toolName: "structured_process",
        content: [{ type: "text", text: '{"verbose":true}' }],
        details: { status: "completed" },
        display: {
          summaryText: "Process completed",
          detailsText: "Verbose process output",
          rawText: '{"verbose":true}',
        },
        isError: false,
      },
    ]);

    expect(messages[0]?.parts[0]).toMatchObject({
      type: "tool",
      trust: {
        phase: "inspect",
        label: "Inspect",
      },
      result: {
        display: {
          summaryText: "Process completed",
          detailsText: "Verbose process output",
          rawText: '{"verbose":true}',
        },
      },
    });
  });

  test("preserves streamed tool execution state when the assistant partial message is rebuilt", () => {
    const partial = buildTranscriptMessageFromMessage(
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "tool-edit-1",
            name: "edit",
            arguments: { path: "src/app.ts" },
          },
        ],
      },
      {
        id: "assistant:stream",
        renderMode: "streaming",
      },
    );

    const withToolUpdate = upsertToolExecutionIntoTranscriptMessages(partial ? [partial] : [], {
      toolCallId: "tool-edit-1",
      toolName: "edit",
      partialResult: {
        content: [{ type: "text", text: "Applying diff..." }],
        details: { phase: "partial" },
      },
      status: "running",
      renderMode: "streaming",
    });

    const rebuilt = buildTranscriptMessageFromMessage(
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "tool-edit-1",
            name: "edit",
            arguments: { path: "src/app.ts" },
          },
        ],
      },
      {
        id: "assistant:stream",
        renderMode: "streaming",
        previousMessage: withToolUpdate[0],
      },
    );

    expect(rebuilt).toMatchObject({
      parts: [
        {
          type: "tool",
          toolCallId: "tool-edit-1",
          toolName: "edit",
          trust: {
            phase: "inspect",
            label: "Inspect",
          },
          status: "running",
          partialResult: {
            details: { phase: "partial" },
          },
        },
      ],
    });
  });

  test("renders failed tool verdicts as error status even when execution returned normally", () => {
    const messages = upsertToolExecutionIntoTranscriptMessages([], {
      toolCallId: "tool-skill-complete-1",
      toolName: "skill_complete",
      result: {
        content: [{ type: "text", text: "Skill completion rejected." }],
        details: {
          ok: false,
          verdict: "fail",
        },
      },
      renderMode: "stable",
    });

    expect(messages[0]).toMatchObject({
      role: "tool",
      parts: [
        {
          type: "tool",
          toolName: "skill_complete",
          trust: {
            phase: "commit",
            label: "Commit",
          },
          status: "error",
        },
      ],
    });
  });
});
