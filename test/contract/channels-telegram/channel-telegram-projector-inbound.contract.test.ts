import { describe, expect, test } from "bun:test";
import {
  buildTelegramInboundDedupeKey,
  decodeTelegramApprovalCallback,
  projectTelegramUpdateToTurn,
  renderTurnToTelegramRequests,
  type TelegramUpdate,
} from "@brewva/brewva-channels-telegram";
import { buildChannelSessionId, type TurnEnvelope } from "@brewva/brewva-runtime/channels";

describe("channel telegram projector inbound", () => {
  test("projects Telegram message update to user turn", () => {
    const update: TelegramUpdate = {
      update_id: 42,
      message: {
        message_id: 7,
        date: 1_700_000_001,
        chat: { id: 12345, type: "private" },
        from: {
          id: 99,
          is_bot: false,
          first_name: "Ada",
          username: "ada",
        },
        text: "hello world",
        message_thread_id: 11,
      },
    };

    const turn = projectTelegramUpdateToTurn(update, {
      now: () => 1_700_000_999_000,
    });

    expect(turn).toEqual({
      schema: "brewva.turn.v1",
      kind: "user",
      sessionId: buildChannelSessionId("telegram", "12345"),
      turnId: "tg:message:12345:7",
      channel: "telegram",
      conversationId: "12345",
      messageId: "7",
      threadId: "11",
      timestamp: 1_700_000_001_000,
      parts: [{ type: "text", text: "hello world" }],
      meta: {
        ingressSequence: 42,
        chatType: "private",
        senderId: "99",
        senderName: "Ada",
        senderUsername: "ada",
        edited: false,
      },
    });
  });

  test("projects callback query to approval turn when signature is valid", () => {
    const secret = "callback-secret";
    const approvalTurn: TurnEnvelope = {
      schema: "brewva.turn.v1",
      kind: "approval",
      sessionId: "channel:session",
      turnId: "turn-1",
      channel: "telegram",
      conversationId: "12345",
      timestamp: 1_700_000_000_000,
      parts: [],
      approval: {
        requestId: "req-1234567890",
        title: "Approve command?",
        actions: [
          { id: "approve", label: "Approve" },
          { id: "deny", label: "Deny" },
        ],
      },
    };

    const requests = renderTurnToTelegramRequests(approvalTurn, {
      inlineApproval: true,
      callbackSecret: secret,
    });
    expect(requests).toHaveLength(1);

    const callbackData = (
      (
        requests[0]?.params.reply_markup as {
          inline_keyboard?: Array<Array<{ callback_data?: string }>>;
        }
      )?.inline_keyboard?.[0]?.[0]?.callback_data ?? ""
    ).toString();
    const decoded = decodeTelegramApprovalCallback(callbackData, secret, { context: "12345" });
    expect(decoded).toEqual({
      requestId: "req-1234567890",
      actionId: "approve",
    });

    const update: TelegramUpdate = {
      update_id: 43,
      callback_query: {
        id: "cbq-1",
        from: { id: 99, is_bot: false, first_name: "Ada", username: "ada" },
        message: {
          message_id: 100,
          date: 1_700_000_002,
          chat: { id: 12345, type: "private" },
        },
        data: callbackData,
      },
    };

    const turn = projectTelegramUpdateToTurn(update, {
      callbackSecret: secret,
    });
    expect(turn?.kind).toBe("approval");
    expect(turn?.approval?.requestId).toBe("req-1234567890");
    expect(turn?.meta?.decisionActionId).toBe("approve");
  });

  test("builds deterministic dedupe keys", () => {
    const messageUpdate: TelegramUpdate = {
      update_id: 99,
      message: {
        message_id: 7,
        date: 1_700_000_001,
        chat: { id: 12345, type: "private" },
      },
    };
    const editUpdate: TelegramUpdate = {
      update_id: 100,
      edited_message: {
        message_id: 7,
        date: 1_700_000_002,
        chat: { id: 12345, type: "private" },
      },
    };
    const callbackUpdate: TelegramUpdate = {
      update_id: 101,
      callback_query: {
        id: "cb-7",
        from: { id: 1 },
      },
    };

    expect(buildTelegramInboundDedupeKey(messageUpdate)).toBe("telegram:12345:7");
    expect(buildTelegramInboundDedupeKey(editUpdate)).toBe("telegram:12345:edit:7:100");
    expect(buildTelegramInboundDedupeKey(callbackUpdate)).toBe("telegram:callback:cb-7");
  });
});
