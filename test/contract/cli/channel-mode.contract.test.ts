import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_TELEGRAM_CHANNEL_NAME,
  SUPPORTED_CHANNELS,
  buildChannelDispatchPrompt,
  canonicalizeInboundTurnSession,
  collectPromptTurnOutputs,
  resolveSupportedChannel,
} from "@brewva/brewva-gateway/channels";
import { createBrewvaRuntime } from "@brewva/brewva-runtime";
import type { TurnEnvelope } from "@brewva/brewva-vocabulary/wire";

describe("channel mode prompt output collector", () => {
  test("normalizes supported channels", () => {
    expect(SUPPORTED_CHANNELS).toEqual(["telegram"]);
    expect(resolveSupportedChannel("telegram")).toBe("telegram");
    expect(resolveSupportedChannel("TG")).toBeNull();
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

  test("fails fast when the channel session is not runtime-turn-compatible", async () => {
    const runtime = createBrewvaRuntime({
      cwd: mkdtempSync(join(tmpdir(), "brewva-channel-incompatible-")),
      physics: { mode: "noop" },
    });
    const session = {
      sessionManager: {
        getSessionId: () => "agent-session",
      },
    };

    try {
      await collectPromptTurnOutputs(
        session as unknown as Parameters<typeof collectPromptTurnOutputs>[0],
        "hello",
        {
          runtime: runtime as never,
          sessionId: "agent-session",
          turnId: "turn-telegram-1",
        },
      );
      throw new Error("expected_channel_thread_loop_failure");
    } catch (error) {
      expect(String(error)).toContain("channel_thread_loop_failed");
    }
  });

  test("builds telegram dispatch prompt with channel policy", () => {
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
    expect(prompt).toContain("[Brewva Channel Policy]");
    expect(prompt).toContain(`Transport: ${DEFAULT_TELEGRAM_CHANNEL_NAME}`);
    expect(prompt).toContain("[channel:telegram] conversation:12345");
    expect(prompt).toContain("hello from telegram");
  });
});
