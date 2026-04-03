import { describe, expect, test } from "bun:test";
import {
  TELEGRAM_CHANNEL_DEFAULT_CAPABILITIES,
  TelegramChannelAdapter,
  type TelegramChannelTransport,
} from "@brewva/brewva-channels-telegram";
import {
  decodeTelegramApprovalCallback,
  encodeTelegramApprovalCallback,
} from "@brewva/brewva-channels-telegram";
import type { TelegramOutboundRequest, TelegramUpdate } from "@brewva/brewva-channels-telegram";
import type { TurnEnvelope } from "@brewva/brewva-runtime/channels";
import { assertRejectsWithMessage } from "../../helpers.js";

function createMessageUpdate(
  options: {
    updateId?: number;
    messageId?: number;
    text?: string;
  } = {},
): TelegramUpdate {
  return {
    update_id: options.updateId ?? 9001,
    message: {
      message_id: options.messageId ?? 77,
      date: 1_700_000_000,
      chat: { id: 12345, type: "private" },
      from: { id: 42, is_bot: false, first_name: "Ada", username: "ada" },
      text: options.text ?? "hello adapter",
    },
  };
}

function createApprovalCallbackUpdate(secret: string): TelegramUpdate {
  return {
    update_id: 9002,
    callback_query: {
      id: "cbq-1",
      from: { id: 42, is_bot: false, first_name: "Ada", username: "ada" },
      message: {
        message_id: 77,
        date: 1_700_000_000,
        chat: { id: 12345, type: "private" },
      },
      data: encodeTelegramApprovalCallback(
        { requestId: "req-1234567890", actionId: "approve" },
        secret,
        { context: "12345" },
      ),
    },
  };
}

function createTransport() {
  let onUpdate: ((update: TelegramUpdate) => Promise<void>) | null = null;
  const sent: TelegramOutboundRequest[] = [];
  const sendResults: Array<{ providerMessageId?: string | number }> = [];
  let startCalls = 0;
  let stopCalls = 0;

  const transport: TelegramChannelTransport = {
    start: async (params) => {
      startCalls += 1;
      onUpdate = params.onUpdate;
    },
    stop: async () => {
      stopCalls += 1;
      onUpdate = null;
    },
    send: async (request) => {
      sent.push(request);
      return sendResults.shift() ?? {};
    },
  };

  return {
    transport,
    sent,
    sendResults,
    getStartCalls: () => startCalls,
    getStopCalls: () => stopCalls,
    async emitUpdate(update: TelegramUpdate): Promise<void> {
      if (!onUpdate) {
        throw new Error("transport not started");
      }
      await onUpdate(update);
    },
  };
}

describe("channel telegram adapter", () => {
  test("projects inbound update to turn and dedupes by default", async () => {
    const transport = createTransport();
    const adapter = new TelegramChannelAdapter({
      transport: transport.transport,
    });
    const inbound: TurnEnvelope[] = [];

    await adapter.start({
      onTurn: async (turn) => {
        inbound.push(turn);
      },
    });

    const update = createMessageUpdate();
    await transport.emitUpdate(update);
    await transport.emitUpdate(update);
    await adapter.stop();

    expect(inbound).toHaveLength(1);
    expect(inbound[0]?.kind).toBe("user");
    expect(inbound[0]?.conversationId).toBe("12345");
    expect(inbound[0]?.turnId).toBe("tg:message:12345:77");
  });

  test("uses custom inbound interaction policy when provided", async () => {
    const transport = createTransport();
    const projectedTurn: TurnEnvelope = {
      schema: "brewva.turn.v1",
      kind: "user",
      sessionId: "channel:custom-session",
      turnId: "custom-turn",
      channel: "telegram",
      conversationId: "99999",
      timestamp: 1_700_000_123_000,
      parts: [{ type: "text", text: "custom inbound" }],
      meta: { source: "custom-policy" },
    };
    let projectionCalls = 0;
    const adapter = new TelegramChannelAdapter({
      transport: transport.transport,
      interactionPolicy: {
        projectInboundTurn: (update) => {
          projectionCalls += 1;
          expect(update.update_id).toBe(9001);
          return projectedTurn;
        },
      },
    });
    const inbound: TurnEnvelope[] = [];

    await adapter.start({
      onTurn: async (turn) => {
        inbound.push(turn);
      },
    });
    await transport.emitUpdate(createMessageUpdate());
    await adapter.stop();

    expect(projectionCalls).toBe(1);
    expect(inbound).toEqual([projectedTurn]);
  });

  test("retries same update when inbound callback fails once", async () => {
    const transport = createTransport();
    const adapter = new TelegramChannelAdapter({
      transport: transport.transport,
    });
    let attempts = 0;

    await adapter.start({
      onTurn: async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error("temporary failure");
        }
      },
    });

    const update = createMessageUpdate();
    await assertRejectsWithMessage(() => transport.emitUpdate(update), "temporary failure");
    await transport.emitUpdate(update);
    await adapter.stop();

    expect(attempts).toBe(2);
  });

  test("acknowledges callback query after approval turn is ingested", async () => {
    const transport = createTransport();
    const secret = "callback-secret";
    const adapter = new TelegramChannelAdapter({
      transport: transport.transport,
      inbound: { callbackSecret: secret },
    });
    const inbound: TurnEnvelope[] = [];

    await adapter.start({
      onTurn: async (turn) => {
        inbound.push(turn);
      },
    });

    await transport.emitUpdate(createApprovalCallbackUpdate(secret));
    await adapter.stop();

    expect(inbound).toHaveLength(1);
    expect(inbound[0]?.kind).toBe("approval");
    expect(transport.sent).toContainEqual({
      method: "answerCallbackQuery",
      params: { callback_query_id: "cbq-1" },
    });
  });

  test("restores cached telegram-ui state in callback approval turn", async () => {
    const transport = createTransport();
    const secret = "callback-secret";
    const adapter = new TelegramChannelAdapter({
      transport: transport.transport,
      inbound: { callbackSecret: secret },
      outbound: { callbackSecret: secret, inlineApproval: true },
    });
    const inbound: TurnEnvelope[] = [];
    const outboundTurn: TurnEnvelope = {
      schema: "brewva.turn.v1",
      kind: "assistant",
      sessionId: "channel:session",
      turnId: "outbound-ui-state-1",
      channel: "telegram",
      conversationId: "12345",
      timestamp: 1_700_000_000_000,
      parts: [
        {
          type: "text",
          text: `\`\`\`telegram-ui
{
  "version": "telegram-ui/v1",
  "screen_id": "deploy-confirm",
  "state_key": "deploy-flow",
  "text": "Choose deploy action",
  "components": [
    {
      "type": "buttons",
      "rows": [[{ "action_id": "confirm", "label": "Confirm" }]]
    }
  ],
  "state": { "flow": "deploy", "step": "confirm", "target": "service-a" }
}
\`\`\``,
        },
      ],
    };

    await adapter.start({
      onTurn: async (turn) => {
        inbound.push(turn);
      },
    });
    await adapter.sendTurn(outboundTurn);

    const callbackData = (
      (
        transport.sent[0]?.params.reply_markup as {
          inline_keyboard?: Array<Array<{ callback_data?: string }>>;
        }
      )?.inline_keyboard?.[0]?.[0]?.callback_data ?? ""
    ).toString();
    const decoded = decodeTelegramApprovalCallback(callbackData, secret, {
      context: "12345",
    });
    expect(decoded).not.toBeNull();

    await transport.emitUpdate({
      update_id: 9003,
      callback_query: {
        id: "cbq-ui-state",
        from: { id: 42, is_bot: false, first_name: "Ada", username: "ada" },
        message: {
          message_id: 120,
          date: 1_700_000_004,
          chat: { id: 12345, type: "private" },
        },
        data: callbackData,
      },
    });
    await adapter.stop();

    expect(inbound).toHaveLength(1);
    expect(inbound[0]?.kind).toBe("approval");
    expect(inbound[0]?.approval?.requestId).toBe(decoded?.requestId);
    expect(inbound[0]?.approval?.detail).toContain("screen: deploy-confirm");
    expect(inbound[0]?.approval?.detail).toContain("state_key: deploy-flow");
    expect(inbound[0]?.meta?.approvalScreenId).toBe("deploy-confirm");
    expect(inbound[0]?.meta?.approvalStateKey).toBe("deploy-flow");
    expect(inbound[0]?.meta?.approvalState).toEqual({
      flow: "deploy",
      step: "confirm",
      target: "service-a",
    });
  });

  test("approval state cache evicts least recently used callbacks", async () => {
    const transport = createTransport();
    const secret = "callback-secret";
    const adapter = new TelegramChannelAdapter({
      transport: transport.transport,
      inbound: { callbackSecret: secret },
      outbound: { callbackSecret: secret, inlineApproval: true },
      approvalState: { maxEntries: 32 },
    });
    const inbound: TurnEnvelope[] = [];
    const buildApprovalTurn = (
      requestId: string,
      conversationId: string,
      screenId: string,
      stateKey: string,
      state: Record<string, unknown>,
    ): TurnEnvelope => ({
      schema: "brewva.turn.v1",
      kind: "approval",
      sessionId: `channel:${requestId}`,
      turnId: `turn:${requestId}`,
      channel: "telegram",
      conversationId,
      timestamp: 1_700_000_000_000,
      parts: [{ type: "text", text: `Approve ${requestId}` }],
      approval: {
        requestId,
        title: `Approve ${requestId}`,
        actions: [{ id: "confirm", label: "Confirm" }],
      },
      meta: {
        approvalScreenId: screenId,
        approvalStateKey: stateKey,
        approvalState: state,
      },
    });

    await adapter.start({
      onTurn: async (turn) => {
        inbound.push(turn);
      },
    });

    let callbackDataA = "";
    let callbackDataB = "";
    for (let index = 1; index <= 32; index += 1) {
      const requestId = `req-${index}`;
      await adapter.sendTurn(
        buildApprovalTurn(requestId, "12345", `screen-${index}`, `flow-${index}`, {
          flow: requestId,
          step: index,
        }),
      );
      const callbackData = (
        (
          transport.sent.at(-1)?.params.reply_markup as {
            inline_keyboard?: Array<Array<{ callback_data?: string }>>;
          }
        )?.inline_keyboard?.[0]?.[0]?.callback_data ?? ""
      ).toString();
      if (index === 1) callbackDataA = callbackData;
      if (index === 2) callbackDataB = callbackData;
    }

    await transport.emitUpdate({
      update_id: 9010,
      callback_query: {
        id: "cbq-keep-a",
        from: { id: 42, is_bot: false, first_name: "Ada", username: "ada" },
        message: {
          message_id: 121,
          date: 1_700_000_010,
          chat: { id: 12345, type: "private" },
        },
        data: callbackDataA,
      },
    });

    await adapter.sendTurn(
      buildApprovalTurn("req-33", "12345", "screen-33", "flow-33", { flow: "req-33", step: 33 }),
    );

    await transport.emitUpdate({
      update_id: 9011,
      callback_query: {
        id: "cbq-evict-b",
        from: { id: 42, is_bot: false, first_name: "Ada", username: "ada" },
        message: {
          message_id: 122,
          date: 1_700_000_011,
          chat: { id: 12345, type: "private" },
        },
        data: callbackDataB,
      },
    });

    await transport.emitUpdate({
      update_id: 9012,
      callback_query: {
        id: "cbq-still-a",
        from: { id: 42, is_bot: false, first_name: "Ada", username: "ada" },
        message: {
          message_id: 123,
          date: 1_700_000_012,
          chat: { id: 12345, type: "private" },
        },
        data: callbackDataA,
      },
    });

    await adapter.stop();

    expect(inbound).toHaveLength(3);
    expect(inbound[0]?.meta?.approvalScreenId).toBe("screen-1");
    expect(inbound[0]?.meta?.approvalStateKey).toBe("flow-1");
    expect(inbound[0]?.meta?.approvalState).toEqual({ flow: "req-1", step: 1 });
    expect(inbound[1]?.meta?.approvalScreenId).toBeUndefined();
    expect(inbound[1]?.meta?.approvalStateKey).toBeUndefined();
    expect(inbound[1]?.meta?.approvalState).toBeUndefined();
    expect(inbound[2]?.meta?.approvalScreenId).toBe("screen-1");
    expect(inbound[2]?.meta?.approvalStateKey).toBe("flow-1");
    expect(inbound[2]?.meta?.approvalState).toEqual({ flow: "req-1", step: 1 });
  });

  test("can disable inbound dedupe", async () => {
    const transport = createTransport();
    const adapter = new TelegramChannelAdapter({
      transport: transport.transport,
      dedupe: { enabled: false },
    });
    let count = 0;

    await adapter.start({
      onTurn: async () => {
        count += 1;
      },
    });

    const update = createMessageUpdate();
    await transport.emitUpdate(update);
    await transport.emitUpdate(update);
    await adapter.stop();

    expect(count).toBe(2);
  });

  test("dedupe cache evicts old updates once the bounded window is exceeded", async () => {
    const transport = createTransport();
    const adapter = new TelegramChannelAdapter({
      transport: transport.transport,
      dedupe: { maxEntries: 32 },
    });
    let count = 0;

    await adapter.start({
      onTurn: async () => {
        count += 1;
      },
    });

    for (let index = 0; index < 32; index += 1) {
      await transport.emitUpdate(
        createMessageUpdate({
          updateId: 9_100 + index,
          messageId: 100 + index,
          text: `hello ${index}`,
        }),
      );
    }

    await transport.emitUpdate(
      createMessageUpdate({
        updateId: 9_100,
        messageId: 100,
        text: "hello 0",
      }),
    );
    expect(count).toBe(32);

    await transport.emitUpdate(
      createMessageUpdate({
        updateId: 9_132,
        messageId: 132,
        text: "hello 32",
      }),
    );
    await transport.emitUpdate(
      createMessageUpdate({
        updateId: 9_100,
        messageId: 100,
        text: "hello 0",
      }),
    );
    await adapter.stop();

    expect(count).toBe(34);
  });

  test("renders outbound requests and returns last provider message id", async () => {
    const transport = createTransport();
    transport.sendResults.push({ providerMessageId: 100 }, { providerMessageId: "101" });
    const adapter = new TelegramChannelAdapter({
      transport: transport.transport,
    });
    const outboundTurn: TurnEnvelope = {
      schema: "brewva.turn.v1",
      kind: "assistant",
      sessionId: "channel:session",
      turnId: "outbound-1",
      channel: "telegram",
      conversationId: "12345",
      threadId: "11",
      timestamp: 1_700_000_000_000,
      parts: [
        { type: "text", text: "hello outbound" },
        { type: "image", uri: "https://example.com/a.jpg" },
      ],
    };

    const result = await adapter.sendTurn(outboundTurn);

    expect(transport.sent).toEqual([
      {
        method: "sendMessage",
        params: {
          chat_id: "12345",
          text: "hello outbound",
          message_thread_id: 11,
        },
      },
      {
        method: "sendPhoto",
        params: {
          chat_id: "12345",
          photo: "https://example.com/a.jpg",
          message_thread_id: 11,
        },
      },
    ]);
    expect(result).toEqual({ providerMessageId: "101", providerMessageIds: ["100", "101"] });
  });

  test("uses custom outbound interaction policy when provided", async () => {
    const transport = createTransport();
    transport.sendResults.push({ providerMessageId: "m-1" }, { providerMessageId: "m-2" });
    let renderCalls = 0;
    const adapter = new TelegramChannelAdapter({
      transport: transport.transport,
      interactionPolicy: {
        renderOutboundRequests: (turn) => {
          renderCalls += 1;
          expect(turn.turnId).toBe("outbound-custom");
          return [
            {
              method: "sendMessage",
              params: {
                chat_id: "12345",
                text: "custom one",
              },
            },
            {
              method: "sendMessage",
              params: {
                chat_id: "12345",
                text: "custom two",
              },
            },
          ];
        },
      },
    });
    const outboundTurn: TurnEnvelope = {
      schema: "brewva.turn.v1",
      kind: "assistant",
      sessionId: "channel:session",
      turnId: "outbound-custom",
      channel: "telegram",
      conversationId: "12345",
      timestamp: 1_700_000_000_000,
      parts: [{ type: "text", text: "ignored by custom policy" }],
    };

    const result = await adapter.sendTurn(outboundTurn);

    expect(renderCalls).toBe(1);
    expect(transport.sent).toEqual([
      {
        method: "sendMessage",
        params: {
          chat_id: "12345",
          text: "custom one",
        },
      },
      {
        method: "sendMessage",
        params: {
          chat_id: "12345",
          text: "custom two",
        },
      },
    ]);
    expect(result).toEqual({ providerMessageId: "m-2", providerMessageIds: ["m-1", "m-2"] });
  });

  test("supports dynamic capability resolver", () => {
    const transport = createTransport();
    const adapter = new TelegramChannelAdapter({
      transport: transport.transport,
      capabilities: ({ conversationId }) =>
        conversationId === "stream-room" ? { streaming: true } : { inlineActions: false },
    });

    expect(adapter.capabilities({ conversationId: "stream-room" })).toEqual({
      ...TELEGRAM_CHANNEL_DEFAULT_CAPABILITIES,
      streaming: true,
    });
    expect(adapter.capabilities({ conversationId: "other-room" })).toEqual({
      ...TELEGRAM_CHANNEL_DEFAULT_CAPABILITIES,
      inlineActions: false,
    });
  });

  test("start and stop are idempotent", async () => {
    const transport = createTransport();
    const adapter = new TelegramChannelAdapter({
      transport: transport.transport,
    });

    await adapter.start({ onTurn: async () => undefined });
    await adapter.start({ onTurn: async () => undefined });
    await adapter.stop();
    await adapter.stop();

    expect(transport.getStartCalls()).toBe(1);
    expect(transport.getStopCalls()).toBe(1);
  });
});
