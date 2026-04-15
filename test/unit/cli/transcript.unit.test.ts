import { describe, expect, test } from "bun:test";
import {
  buildSeedTranscriptMessages,
  buildTranscriptMessageFromMessage,
  upsertToolExecutionIntoTranscriptMessages,
} from "../../../packages/brewva-cli/src/shell/transcript.js";

describe("cli transcript model", () => {
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
          status: "completed",
          result: {
            details: { firstLine: 1 },
          },
        },
      ],
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
          status: "running",
          partialResult: {
            details: { phase: "partial" },
          },
        },
      ],
    });
  });
});
