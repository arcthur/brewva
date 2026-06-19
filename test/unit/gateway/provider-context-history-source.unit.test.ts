import { describe, expect, test } from "bun:test";
import { toProviderContext } from "../../../packages/brewva-gateway/src/hosted/internal/turn-adapter/runtime-provider-context.js";
import { HOSTED_RUNTIME_TURN_CONTEXT } from "../../../packages/brewva-gateway/src/hosted/internal/turn-adapter/runtime-turn-prelude.js";

type ToProviderContextSession = Parameters<typeof toProviderContext>[0];
type ToProviderContextInput = Parameters<typeof toProviderContext>[1];

function assistantMessage(text: string, timestamp: number) {
  return {
    role: "assistant" as const,
    content: [{ type: "text" as const, text }],
    api: "unit",
    provider: "unit-provider",
    model: "unit-model",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "endTurn" as const,
    timestamp,
  };
}

function rawInputWithHistory(
  messages: unknown[],
  options: {
    readonly admittedBlocks?: readonly {
      readonly id: string;
      readonly kind: string;
      readonly text?: string;
      readonly required?: boolean;
    }[];
    readonly messageSourceEventIds?: readonly string[];
  } = {},
): ToProviderContextInput {
  return {
    turn: { sessionId: "s1", prompt: "q1" },
    prompt: {
      status: "ready" as const,
      sessionId: "s1",
      messages,
      admittedBlocks: (options.admittedBlocks ?? []).map((block) => ({
        id: block.id,
        kind: block.kind,
        text: block.text ?? "",
        required: block.required ?? true,
      })),
      messageSourceEventIds: options.messageSourceEventIds ?? [],
      droppedAdvisoryBlocks: [],
      tokenEstimate: 0,
      cache: { stablePrefix: false },
    },
  } as unknown as ToProviderContextInput;
}

function sessionWithHostedContext(
  messages: readonly unknown[],
  runtimeEventCursor: string | null,
): ToProviderContextSession {
  return {
    createRuntimeToolContext: () => ({ getSystemPrompt: () => "" }),
    getRegisteredTools: () => [],
    [HOSTED_RUNTIME_TURN_CONTEXT]: () => ({ messages, runtimeEventCursor }),
  } as unknown as ToProviderContextSession;
}

describe("toProviderContext history source is mutually exclusive", () => {
  test("managed path uses hosted turn context and does not duplicate runtime tape history", () => {
    // Source B: the prepared hosted turn context (managed path) holds the full
    // conversation history with real assistant metadata.
    const hostedHistory = [
      { role: "user", content: [{ type: "text", text: "q1" }], timestamp: 1 },
      assistantMessage("a1", 2),
    ];
    const session = sessionWithHostedContext(hostedHistory, "evt-before-turn");
    // Source A: the runtime tape projection carries the SAME history. Before the
    // fix both sources were appended, sending the conversation twice.
    const input = rawInputWithHistory(
      [
        { role: "user", content: [{ type: "text", text: "q1" }] },
        { role: "assistant", content: [{ type: "text", text: "a1" }] },
      ],
      {
        admittedBlocks: [
          { id: "evt-user", kind: "turn.started" },
          { id: "evt-assistant", kind: "msg.committed" },
          { id: "evt-before-turn", kind: "custom" },
        ],
        messageSourceEventIds: ["evt-user", "evt-assistant"],
      },
    );

    const context = toProviderContext(session, input);

    // History must appear exactly once (from Source B), not twice.
    expect(context.messages).toHaveLength(2);
    expect(context.messages.filter((message) => message.role === "user")).toHaveLength(1);
    expect(context.messages.filter((message) => message.role === "assistant")).toHaveLength(1);
  });

  test("managed path appends current-turn runtime tool continuation after the hosted baseline", () => {
    const hostedHistory = [
      { role: "user", content: [{ type: "text", text: "q1" }], timestamp: 1 },
      {
        role: "custom",
        customType: "plugin-context",
        content: "plugin-only context",
        timestamp: 2,
      },
    ];
    const session = sessionWithHostedContext(hostedHistory, "evt-before-turn");
    const input = rawInputWithHistory(
      [
        { role: "user", content: [{ type: "text", text: "q1" }] },
        {
          role: "assistant",
          content: "",
          toolCalls: [{ toolCallId: "call-1", toolName: "read_file", args: {} }],
        },
        {
          role: "tool",
          content: "README contents",
          toolCallId: "call-1",
          toolName: "read_file",
          isError: false,
        },
      ],
      {
        admittedBlocks: [
          { id: "evt-before-turn", kind: "custom" },
          { id: "evt-turn", kind: "turn.started" },
          { id: "evt-tool", kind: "tool.committed" },
        ],
        messageSourceEventIds: ["evt-turn", "evt-tool", "evt-tool"],
      },
    );

    const context = toProviderContext(session, input);

    expect(context.messages).toHaveLength(4);
    expect(context.messages[0]).toMatchObject({ role: "user" });
    expect(context.messages[1]).toMatchObject({
      role: "user",
      content: [{ type: "text", text: "plugin-only context" }],
    });
    expect(context.messages[2]).toMatchObject({ role: "assistant" });
    expect(context.messages[3]).toMatchObject({
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "read_file",
    });
  });

  test("managed path preserves an explicitly empty hosted context", () => {
    const session = sessionWithHostedContext([], "evt-before-turn");
    const input = rawInputWithHistory(
      [{ role: "user", content: [{ type: "text", text: "must stay excluded" }] }],
      {
        admittedBlocks: [
          { id: "evt-before-turn", kind: "custom" },
          { id: "evt-turn", kind: "turn.started" },
        ],
        messageSourceEventIds: ["evt-turn"],
      },
    );

    const context = toProviderContext(session, input);

    expect(context.messages).toEqual([]);
  });

  test("managed path rejects misaligned runtime message provenance", () => {
    const session = sessionWithHostedContext(
      [{ role: "user", content: [{ type: "text", text: "q1" }], timestamp: 1 }],
      "evt-before-turn",
    );
    const input = rawInputWithHistory([{ role: "user", content: [{ type: "text", text: "q1" }] }], {
      admittedBlocks: [
        { id: "evt-before-turn", kind: "custom" },
        { id: "evt-turn", kind: "turn.started" },
      ],
      messageSourceEventIds: [],
    });

    expect(() => toProviderContext(session, input)).toThrow(
      "runtime_prompt_message_provenance_mismatch",
    );
  });

  test("managed path rejects a missing runtime cursor without a checkpoint reset", () => {
    const session = sessionWithHostedContext(
      [{ role: "user", content: [{ type: "text", text: "q1" }], timestamp: 1 }],
      "evt-missing",
    );
    const input = rawInputWithHistory([{ role: "user", content: [{ type: "text", text: "q1" }] }], {
      admittedBlocks: [{ id: "evt-turn", kind: "turn.started" }],
      messageSourceEventIds: ["evt-turn"],
    });

    expect(() => toProviderContext(session, input)).toThrow("hosted_runtime_event_cursor_missing");
  });

  test("raw runtime path (no hosted turn context) uses the runtime tape history", () => {
    const session = {
      createRuntimeToolContext: () => ({ getSystemPrompt: () => "" }),
      getRegisteredTools: () => [],
    } as unknown as ToProviderContextSession;
    const input = rawInputWithHistory([{ role: "user", content: [{ type: "text", text: "q1" }] }]);

    const context = toProviderContext(session, input);

    expect(context.messages).toHaveLength(1);
    expect(context.messages[0]?.role).toBe("user");
  });
});
