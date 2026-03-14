import { describe, expect, test } from "bun:test";
import { renderTurnToTelegramRequests } from "@brewva/brewva-channels-telegram";
import type { TurnEnvelope } from "@brewva/brewva-runtime/channels";

describe("channel telegram rendering", () => {
  test("renders turn to Telegram outbound requests with thread + media fallback", () => {
    const turn: TurnEnvelope = {
      schema: "brewva.turn.v1",
      kind: "assistant",
      sessionId: "channel:session",
      turnId: "t1",
      channel: "telegram",
      conversationId: "12345",
      threadId: "77",
      timestamp: 1_700_000_000_000,
      parts: [
        { type: "text", text: "hello" },
        { type: "image", uri: "https://example.com/a.png" },
        { type: "file", uri: "https://example.com/b.txt", name: "b.txt" },
      ],
    };

    const requests = renderTurnToTelegramRequests(turn);
    expect(requests).toEqual([
      {
        method: "sendMessage",
        params: {
          chat_id: "12345",
          text: "hello",
          message_thread_id: 77,
        },
      },
      {
        method: "sendPhoto",
        params: {
          chat_id: "12345",
          photo: "https://example.com/a.png",
          message_thread_id: 77,
        },
      },
      {
        method: "sendDocument",
        params: {
          chat_id: "12345",
          document: "https://example.com/b.txt",
          message_thread_id: 77,
        },
      },
    ]);
  });

  test("splits inline approval text by max length and keeps buttons on first chunk only", () => {
    const turn: TurnEnvelope = {
      schema: "brewva.turn.v1",
      kind: "approval",
      sessionId: "channel:session",
      turnId: "approval-1",
      channel: "telegram",
      conversationId: "12345",
      timestamp: 1_700_000_000_000,
      parts: [{ type: "text", text: "Please approve this operation.\n".repeat(4).trim() }],
      approval: {
        requestId: "req-1234567890",
        title: "Approve command?",
        actions: [{ id: "approve", label: "Approve" }],
      },
    };

    const requests = renderTurnToTelegramRequests(turn, {
      inlineApproval: true,
      callbackSecret: "callback-secret",
      maxTextLength: 40,
    });
    const messages = requests.filter((entry) => entry.method === "sendMessage");
    expect(messages.length).toBeGreaterThan(1);
    expect(typeof messages[0]?.params.reply_markup).toBe("object");
    expect(messages.slice(1).map((entry) => entry.params.reply_markup)).toEqual(
      Array(Math.max(messages.length - 1, 0)).fill(undefined),
    );
    expect(
      messages.every(
        (entry) => typeof entry.params.text === "string" && entry.params.text.length <= 40,
      ),
    ).toBe(true);
  });

  test("appends textual approval instructions when inline callbacks are unavailable", () => {
    const turn: TurnEnvelope = {
      schema: "brewva.turn.v1",
      kind: "approval",
      sessionId: "channel:session",
      turnId: "approval-2",
      channel: "telegram",
      conversationId: "12345",
      timestamp: 1_700_000_000_000,
      parts: [{ type: "text", text: "Please approve this operation." }],
      approval: {
        requestId: "req-1234567890",
        title: "Approve command?",
        actions: [
          { id: "approve", label: "Approve" },
          { id: "deny", label: "Deny" },
        ],
      },
    };

    const requests = renderTurnToTelegramRequests(turn, {
      inlineApproval: true,
    });
    const messages = requests.filter((entry) => entry.method === "sendMessage");
    expect(messages.length).toBeGreaterThan(0);
    expect(
      messages.some(
        (entry) =>
          typeof entry.params.text === "string" && entry.params.text.includes("Reply with one of:"),
      ),
    ).toBe(true);
  });
});
