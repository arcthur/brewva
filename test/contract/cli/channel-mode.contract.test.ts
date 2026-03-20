import { describe, expect, test } from "bun:test";
import {
  DEFAULT_TELEGRAM_SKILL_NAME,
  SUPPORTED_CHANNELS,
  buildChannelDispatchPrompt,
  canonicalizeInboundTurnSession,
  collectPromptTurnOutputs,
  resolveSupportedChannel,
} from "@brewva/brewva-gateway";
import type { TurnEnvelope } from "@brewva/brewva-runtime/channels";
import type { AgentSessionEvent } from "@mariozechner/pi-coding-agent";
import { createRuntimeFixture } from "../../helpers/runtime.js";

type SessionLike = {
  subscribe: (listener: (event: AgentSessionEvent) => void) => () => void;
  sendUserMessage: (content: string, options?: { deliverAs?: "followUp" }) => Promise<void>;
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
  test("normalizes supported channels", () => {
    expect(SUPPORTED_CHANNELS).toEqual(["telegram"]);
    expect(resolveSupportedChannel("telegram")).toBe("telegram");
    expect(resolveSupportedChannel("TG")).toBe("telegram");
    expect(resolveSupportedChannel("discord")).toBeNull();
  });

  test("canonicalizes inbound turn session ids", () => {
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

  test("aggregates assistant and tool outputs from prompt execution", async () => {
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
          content: [{ type: "text", text: "final answer" }],
        },
      } as AgentSessionEvent,
    ]);

    const outputs = await collectPromptTurnOutputs(
      session as unknown as Parameters<typeof collectPromptTurnOutputs>[0],
      "hello",
    );

    expect(outputs.assistantText).toBe("final answer");
    expect(outputs.toolOutputs).toHaveLength(1);
  });

  test("marks explicit fail verdict tool outputs as failed even when the channel succeeds", async () => {
    const session = createSessionMock([
      {
        type: "tool_execution_end",
        toolCallId: "tc-2",
        toolName: "exec",
        result: {
          content: [{ type: "text", text: "FAIL src/foo.test.ts" }],
          details: { verdict: "fail" },
        },
        isError: false,
      } as AgentSessionEvent,
    ]);

    const outputs = await collectPromptTurnOutputs(
      session as unknown as Parameters<typeof collectPromptTurnOutputs>[0],
      "hello",
    );

    expect(outputs.toolOutputs).toHaveLength(1);
    expect(outputs.toolOutputs[0]?.text).toContain("Tool exec (tc-2) failed");
  });

  test("resumes channel prompt collection after compaction when runtime emits session_compact", async () => {
    const listeners = new Set<
      (event: { id: string; sessionId: string; type: string; timestamp: number }) => void
    >();
    const sentMessages: string[] = [];
    let sessionListener: ((event: AgentSessionEvent) => void) | undefined;
    const session: SessionLike = {
      subscribe(next) {
        sessionListener = next;
        return () => {
          sessionListener = undefined;
        };
      },
      async sendUserMessage(content): Promise<void> {
        sentMessages.push(content);
        if (sentMessages.length === 1) {
          for (const listener of listeners) {
            listener({
              id: "evt-1",
              sessionId: "agent-session",
              type: "session_compact",
              timestamp: Date.now(),
            });
          }
          return;
        }

        sessionListener?.({
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "telegram resumed" }],
          },
        } as AgentSessionEvent);
      },
      agent: {
        async waitForIdle(): Promise<void> {
          return;
        },
      },
    };

    const runtime = createRuntimeFixture();
    Object.assign(runtime.events, {
      subscribe(
        listener: (event: {
          id: string;
          sessionId: string;
          type: string;
          timestamp: number;
        }) => void,
      ) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      record: () => undefined,
    });

    const outputs = await collectPromptTurnOutputs(
      session as unknown as Parameters<typeof collectPromptTurnOutputs>[0],
      "hello",
      {
        runtime,
        sessionId: "agent-session",
        turnId: "turn-telegram-1",
      },
    );

    expect(sentMessages).toHaveLength(2);
    expect(sentMessages[1]).toContain("Resume the interrupted turn");
    expect(outputs.assistantText).toBe("telegram resumed");
  });

  test("builds telegram dispatch prompt with the unified skill policy", () => {
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
    expect(prompt).toContain("[Brewva Channel Skill Policy]");
    expect(prompt).toContain(`Primary channel skill: ${DEFAULT_TELEGRAM_SKILL_NAME}`);
    expect(prompt).toContain("[channel:telegram] conversation:12345");
    expect(prompt).toContain("hello from telegram");
  });
});
