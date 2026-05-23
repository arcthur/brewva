import { describe, expect, test } from "bun:test";
import {
  asBrewvaSessionId,
  asBrewvaToolCallId,
  asBrewvaToolName,
} from "@brewva/brewva-runtime/core";
import {
  buildSeedTranscriptMessages,
  buildTranscriptMessageFromMessage,
  upsertToolExecutionIntoTranscriptMessages,
} from "../../../packages/brewva-cli/src/shell/domain/transcript.js";
import { buildSessionWireTranscriptSeedMessages } from "../../../packages/brewva-cli/src/shell/ports/session-adapter.js";

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

  test("scopes seed transcript message ids by surface key so reconcile cannot reuse stale sessions", () => {
    const wire: unknown[] = [
      {
        role: "user",
        content: [{ type: "text", text: "Hello" }],
      },
    ];
    const sessionA = buildSeedTranscriptMessages(wire, "session-a");
    const sessionB = buildSeedTranscriptMessages(wire, "session-b");
    expect(sessionA).toHaveLength(1);
    expect(sessionB).toHaveLength(1);
    expect(sessionA[0]?.id.startsWith("seed:session-a:0")).toBe(true);
    expect(sessionB[0]?.id.startsWith("seed:session-b:0")).toBe(true);
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

  test("builds transcript seed messages from replayed runtime session wire tool outputs", () => {
    const seed = buildSessionWireTranscriptSeedMessages([
      {
        schema: "brewva.session-wire.v2",
        sessionId: asBrewvaSessionId("session-wire-transcript"),
        frameId: "a-frame-committed",
        ts: 1_000,
        source: "replay",
        durability: "durable",
        type: "turn.committed",
        turnId: "turn-0",
        attemptId: "runtime-turn",
        status: "completed",
        assistantText: "Let me search first.Architecture docs live under docs/architecture.",
        assistantSegments: [
          {
            text: "Let me search first.",
            ts: 1_200,
            sequence: 1,
            sourceEventId: "evt-assistant-before-tool",
          },
          {
            text: "Architecture docs live under docs/architecture.",
            ts: 1_200,
            sequence: 3,
            sourceEventId: "evt-assistant-after-tool",
          },
        ],
        toolOutputs: [
          {
            toolCallId: asBrewvaToolCallId("call-grep-1"),
            toolName: asBrewvaToolName("grep"),
            verdict: "pass",
            isError: false,
            text: "docs/architecture/system-architecture.md",
            ts: 1_200,
            sequence: 2,
            sourceEventId: "evt-tool-committed",
          },
        ],
      },
      {
        schema: "brewva.session-wire.v2",
        sessionId: asBrewvaSessionId("session-wire-transcript"),
        frameId: "z-frame-input",
        ts: 1_000,
        source: "replay",
        durability: "durable",
        type: "turn.input",
        turnId: "turn-0",
        trigger: "user",
        promptText: "show architecture docs",
      },
    ]);
    const messages = buildSeedTranscriptMessages(seed, "session-wire-transcript");

    expect(messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);
    expect(messages[0]).toMatchObject({
      role: "user",
      parts: [{ type: "text", text: "show architecture docs" }],
    });
    expect(messages[1]).toMatchObject({
      role: "assistant",
      parts: [
        {
          type: "text",
          text: "Let me search first.",
        },
      ],
    });
    expect(messages[2]).toMatchObject({
      role: "tool",
      parts: [
        {
          type: "tool",
          toolName: "grep",
          toolCallId: "call-grep-1",
          status: "completed",
          result: {
            content: [{ type: "text", text: "docs/architecture/system-architecture.md" }],
          },
        },
      ],
    });
    expect(messages[3]).toMatchObject({
      role: "assistant",
      parts: [
        {
          type: "text",
          text: "Architecture docs live under docs/architecture.",
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
      toolCallId: "tool-custom-commit-1",
      toolName: "custom_commit_tool",
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
          toolName: "custom_commit_tool",
          trust: {
            phase: "inspect",
            label: "Inspect",
          },
          status: "error",
        },
      ],
    });
  });
});
