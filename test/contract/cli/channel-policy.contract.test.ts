import { describe, expect, test } from "bun:test";
import { buildChannelPolicyBlock, DEFAULT_TELEGRAM_CHANNEL_NAME } from "@brewva/brewva-gateway";
import type { TurnEnvelope } from "@brewva/brewva-runtime/protocol";

function createTurn(channel: string): TurnEnvelope {
  return {
    schema: "brewva.turn.v1",
    kind: "user",
    sessionId: "session-1",
    turnId: "turn-1",
    channel,
    conversationId: "conv-1",
    timestamp: 1_700_000_000_000,
    parts: [{ type: "text", text: "hello" }],
  };
}

describe("channel policy block", () => {
  test("returns empty policy for non-telegram channels", () => {
    const block = buildChannelPolicyBlock(createTurn("cli"));
    expect(block).toBe("");
  });

  test("renders telegram policy without a skill gate", () => {
    const block = buildChannelPolicyBlock(createTurn("telegram"));
    expect(block).toContain("Channel: telegram");
    expect(block).toContain(`Transport: ${DEFAULT_TELEGRAM_CHANNEL_NAME}`);
    expect(block).toContain("do not load a channel skill");
    expect(block).not.toContain("skill_load");
  });
});
