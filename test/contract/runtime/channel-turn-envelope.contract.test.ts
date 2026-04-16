import { describe, expect, test } from "bun:test";
import { assertTurnEnvelope, coerceTurnEnvelope } from "@brewva/brewva-runtime/channels";

describe("turn envelope coercion", () => {
  test("coerces a valid envelope payload into an explicit success result", () => {
    const result = coerceTurnEnvelope({
      kind: "user",
      sessionId: "session-1",
      turnId: "turn-1",
      channel: "telegram",
      conversationId: "conversation-1",
      timestamp: 1_700_000_000_000,
      parts: [{ type: "text", text: "hello" }],
    });

    expect(result).toEqual({
      ok: true,
      envelope: {
        schema: "brewva.turn.v1",
        kind: "user",
        sessionId: "session-1",
        turnId: "turn-1",
        channel: "telegram",
        conversationId: "conversation-1",
        timestamp: 1_700_000_000_000,
        parts: [{ type: "text", text: "hello" }],
      },
    });
  });

  test("returns an explicit failure result when required fields are missing", () => {
    const result = coerceTurnEnvelope({
      kind: "user",
      parts: [{ type: "text", text: "hello" }],
    });

    expect(result).toEqual({
      ok: false,
      error:
        "invalid_turn_envelope:missing_sessionId,missing_turnId,missing_channel,missing_conversationId",
    });
  });

  test("assertTurnEnvelope throws the coercion error message", () => {
    expect(() =>
      assertTurnEnvelope({
        kind: "assistant",
        parts: [{ type: "text", text: "hello" }],
      }),
    ).toThrow(
      "invalid_turn_envelope:missing_sessionId,missing_turnId,missing_channel,missing_conversationId",
    );
  });
});
