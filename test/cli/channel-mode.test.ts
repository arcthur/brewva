import { describe, expect, test } from "bun:test";
import {
  DEFAULT_TELEGRAM_CHANNEL_BEHAVIOR_SKILL_NAME,
  DEFAULT_TELEGRAM_INTERACTIVE_SKILL_NAME,
  SUPPORTED_CHANNELS,
  buildChannelDispatchPrompt,
  canonicalizeInboundTurnSession,
  collectPromptTurnOutputs,
  resolveSupportedChannel,
} from "@brewva/brewva-cli";
import type { TurnEnvelope } from "@brewva/brewva-runtime/channels";
import type { AgentSessionEvent } from "@mariozechner/pi-coding-agent";

type SessionLike = {
  subscribe: (listener: (event: AgentSessionEvent) => void) => () => void;
  sendUserMessage: (content: string) => Promise<void>;
  agent: {
    waitForIdle: () => Promise<void>;
  };
};

function createSessionMock(eventsToEmit: AgentSessionEvent[]): SessionLike {
  let listener: ((event: AgentSessionEvent) => void) | undefined;
  return {
    subscribe(next) {
      listener = next;
      return () => {
        listener = undefined;
      };
    },
    async sendUserMessage(_content: string): Promise<void> {
      for (const event of eventsToEmit) {
        listener?.(event);
      }
    },
    agent: {
      async waitForIdle(): Promise<void> {
        return;
      },
    },
  };
}

describe("channel mode prompt output collector", () => {
  test("given channel aliases and unknown id, when resolving supported channel, then alias is normalized and unsupported id is rejected", () => {
    expect(SUPPORTED_CHANNELS).toEqual(["telegram"]);
    expect(resolveSupportedChannel("telegram")).toBe("telegram");
    expect(resolveSupportedChannel("TG")).toBe("telegram");
    expect(resolveSupportedChannel("discord")).toBeNull();
  });

  test("given inbound turn session already canonical, when canonicalizing, then original turn object is returned", () => {
    const turn: TurnEnvelope = {
      schema: "brewva.turn.v1",
      kind: "user",
      sessionId: "agent-session",
      turnId: "turn-1",
      channel: "telegram",
      conversationId: "12345",
      timestamp: 1_700_000_000_000,
      parts: [{ type: "text", text: "hello" }],
    };
    const canonical = canonicalizeInboundTurnSession(turn, "agent-session");
    expect(canonical).toBe(turn);
  });

  test("given inbound turn session differs from canonical session, when canonicalizing, then sessionId is remapped and original id is stored in metadata", () => {
    const turn: TurnEnvelope = {
      schema: "brewva.turn.v1",
      kind: "user",
      sessionId: "channel-session",
      turnId: "turn-1",
      channel: "telegram",
      conversationId: "12345",
      timestamp: 1_700_000_000_000,
      parts: [{ type: "text", text: "hello" }],
      meta: { source: "telegram" },
    };
    const canonical = canonicalizeInboundTurnSession(turn, "agent-session");
    expect(canonical.sessionId).toBe("agent-session");
    expect(canonical.meta).toEqual({
      source: "telegram",
      channelSessionId: "channel-session",
    });
  });

  test("given mixed tool and assistant events, when collecting prompt outputs, then latest assistant text and tool outputs are aggregated", async () => {
    const session = createSessionMock([
      {
        type: "tool_execution_end",
        toolCallId: "tc-1",
        toolName: "exec",
        result: {
          content: [{ type: "text", text: "done" }],
        },
        isError: false,
      } as AgentSessionEvent,
      {
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "intermediate" }],
        },
      } as AgentSessionEvent,
      {
        type: "tool_execution_end",
        toolCallId: "tc-2",
        toolName: "read",
        result: "missing file",
        isError: true,
      } as AgentSessionEvent,
      {
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "final answer" }],
        },
      } as AgentSessionEvent,
    ]);

    const outputs = await collectPromptTurnOutputs(
      session as unknown as Parameters<typeof collectPromptTurnOutputs>[0],
      "hello",
    );

    expect(outputs.assistantText).toBe("final answer");
    expect(outputs.toolOutputs).toHaveLength(2);
    expect(outputs.toolOutputs[0]?.text).toContain("Tool exec (tc-1) completed");
    expect(outputs.toolOutputs[0]?.text).toContain("done");
    expect(outputs.toolOutputs[1]?.text).toContain("Tool read (tc-2) failed");
    expect(outputs.toolOutputs[1]?.text).toContain("missing file");
  });

  test("given high-volume exec output, when collecting prompt outputs, then tool output uses distilled summary", async () => {
    const noisyOutput = Array.from({ length: 220 }, (_value, index) =>
      index % 29 === 0
        ? `error at step ${index}: timeout while waiting for response`
        : `line ${index}: working`,
    ).join("\n");
    const session = createSessionMock([
      {
        type: "tool_execution_end",
        toolCallId: "tc-exec-noisy",
        toolName: "exec",
        result: noisyOutput,
        isError: true,
      } as AgentSessionEvent,
    ]);

    const outputs = await collectPromptTurnOutputs(
      session as unknown as Parameters<typeof collectPromptTurnOutputs>[0],
      "hello",
    );

    expect(outputs.toolOutputs).toHaveLength(1);
    const text = outputs.toolOutputs[0]?.text ?? "";
    expect(text).toContain("Tool exec (tc-exec-noisy) failed");
    expect(text).toContain("[ExecDistilled]");
    expect(text).toContain("status: failed");
    expect(text.length).toBeLessThan(noisyOutput.length);
  });

  test("given repeated tool_execution_end with same toolCallId, when collecting outputs, then duplicate tool output is removed", async () => {
    const repeatedEvent = {
      type: "tool_execution_end",
      toolCallId: "tc-1",
      toolName: "exec",
      result: "done",
      isError: false,
    } as AgentSessionEvent;
    const session = createSessionMock([repeatedEvent, repeatedEvent]);

    const outputs = await collectPromptTurnOutputs(
      session as unknown as Parameters<typeof collectPromptTurnOutputs>[0],
      "hello",
    );

    expect(outputs.toolOutputs).toHaveLength(1);
    expect(outputs.toolOutputs[0]?.toolCallId).toBe("tc-1");
  });

  test("given non-assistant message_end events, when collecting outputs, then assistant text remains empty", async () => {
    const session = createSessionMock([
      {
        type: "message_end",
        message: {
          role: "user",
          content: [{ type: "text", text: "user message" }],
        },
      } as AgentSessionEvent,
    ]);

    const outputs = await collectPromptTurnOutputs(
      session as unknown as Parameters<typeof collectPromptTurnOutputs>[0],
      "hello",
    );

    expect(outputs.assistantText).toBe("");
    expect(outputs.toolOutputs).toEqual([]);
  });

  test("given telegram inbound turn, when building channel dispatch prompt, then prompt includes built-in policy block and inbound payload", () => {
    const turn: TurnEnvelope = {
      schema: "brewva.turn.v1",
      kind: "user",
      sessionId: "channel-session",
      turnId: "turn-99",
      channel: "telegram",
      conversationId: "12345",
      timestamp: 1_700_000_000_000,
      parts: [{ type: "text", text: "hello from telegram" }],
    };

    const { canonicalTurn, prompt } = buildChannelDispatchPrompt({
      turn,
      agentSessionId: "agent-session",
    });

    expect(canonicalTurn.sessionId).toBe("agent-session");
    expect(canonicalTurn.meta).toEqual({
      channelSessionId: "channel-session",
    });
    expect(prompt).toContain("[Brewva Channel Skill Policy]");
    expect(prompt).toContain(
      `Primary behavior skill: ${DEFAULT_TELEGRAM_CHANNEL_BEHAVIOR_SKILL_NAME}`,
    );
    expect(prompt).toContain(`Interactive skill: ${DEFAULT_TELEGRAM_INTERACTIVE_SKILL_NAME}`);
    expect(prompt).toContain("[channel:telegram] conversation:12345");
    expect(prompt).toContain("turn_kind:user");
    expect(prompt).toContain("hello from telegram");
  });
});
