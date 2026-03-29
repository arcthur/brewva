import { describe, expect, test } from "bun:test";
import {
  decodeTelegramApprovalCallback,
  projectTelegramUpdateToTurn,
  renderTurnToTelegramRequests,
  type TelegramUpdate,
} from "@brewva/brewva-channels-telegram";
import type { TurnEnvelope } from "@brewva/brewva-runtime/channels";
import { requireArray, requireDefined, requireNonEmptyString } from "../../helpers/assertions.js";

describe("channel telegram telegram-ui rendering", () => {
  test("renders telegram-ui blocks from assistant text as inline callbacks", () => {
    const turn: TurnEnvelope = {
      schema: "brewva.turn.v1",
      kind: "assistant",
      sessionId: "channel:session",
      turnId: "assistant-ui-1",
      channel: "telegram",
      conversationId: "12345",
      timestamp: 1_700_000_000_000,
      parts: [
        {
          type: "text",
          text: `Please choose deployment action.
\`\`\`telegram-ui
{
  "version": "telegram-ui/v1",
  "screen_id": "deploy-confirm",
  "text": "Choose deploy action",
  "components": [
    {
      "type": "buttons",
      "rows": [
        [
          { "action_id": "confirm", "label": "Confirm", "style": "primary" },
          { "action_id": "cancel", "label": "Cancel", "style": "danger" }
        ]
      ]
    }
  ],
  "fallback_text": "Reply with: confirm or cancel"
}
\`\`\``,
        },
      ],
    };

    const requests = renderTurnToTelegramRequests(turn, {
      inlineApproval: true,
      callbackSecret: "callback-secret",
    });
    const first = requireDefined(requests[0], "Expected first Telegram request.");
    const firstText = typeof first.params.text === "string" ? first.params.text : "";
    expect(first.method).toBe("sendMessage");
    const replyMarkup = requireDefined(
      first.params.reply_markup as {
        inline_keyboard?: Array<Array<{ callback_data?: string }>>;
      },
      "Expected inline keyboard reply markup.",
    );
    expect(firstText).toContain("Please choose deployment action.");
    expect(firstText).not.toContain("telegram-ui");
    const inlineKeyboard = requireArray<Array<{ callback_data?: string }>>(
      replyMarkup.inline_keyboard,
      "Expected inline keyboard reply markup.",
    );
    expect(inlineKeyboard).toHaveLength(1);
    expect(inlineKeyboard[0]).toHaveLength(2);

    const callbackData = (inlineKeyboard[0]?.[0]?.callback_data ?? "").toString();
    const decoded = requireDefined(
      decodeTelegramApprovalCallback(callbackData, "callback-secret", {
        context: "12345",
      }),
      "Expected decoded confirm callback payload.",
    );
    expect(decoded.actionId).toBe("confirm");
    const requestId = requireNonEmptyString(decoded.requestId, "Expected decoded requestId.");

    const cancelCallbackData = (inlineKeyboard?.[0]?.[1]?.callback_data ?? "").toString();
    const cancelDecoded = requireDefined(
      decodeTelegramApprovalCallback(cancelCallbackData, "callback-secret", {
        context: "12345",
      }),
      "Expected decoded cancel callback payload.",
    );
    expect(cancelDecoded.actionId).toBe("cancel");
    expect(cancelDecoded.requestId).toBe(requestId);
  });

  test("keeps distinct callbacks when long action ids share a prefix", () => {
    const turn: TurnEnvelope = {
      schema: "brewva.turn.v1",
      kind: "assistant",
      sessionId: "channel:session",
      turnId: "assistant-ui-long-actions-1",
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
  "text": "Choose deploy action",
  "components": [
    {
      "type": "buttons",
      "rows": [[
        { "action_id": "very-long-shared-prefix-alpha", "label": "Alpha" },
        { "action_id": "very-long-shared-prefix-beta", "label": "Beta" }
      ]]
    }
  ]
}
\`\`\``,
        },
      ],
    };

    const requests = renderTurnToTelegramRequests(turn, {
      inlineApproval: true,
      callbackSecret: "callback-secret",
    });

    const first = requireDefined(
      requests[0],
      "Expected first Telegram request for long action ids.",
    );
    const replyMarkup = requireDefined(
      first.params.reply_markup as {
        inline_keyboard?: Array<Array<{ callback_data?: string }>>;
      },
      "Expected inline keyboard for long action ids.",
    );
    const inlineKeyboard = requireArray<Array<{ callback_data?: string }>>(
      replyMarkup.inline_keyboard,
      "Expected inline keyboard for long action ids.",
    );
    expect(inlineKeyboard).toHaveLength(1);
    expect(inlineKeyboard[0]).toHaveLength(2);

    const firstDecoded = requireDefined(
      decodeTelegramApprovalCallback(
        (inlineKeyboard[0]?.[0]?.callback_data ?? "").toString(),
        "callback-secret",
        {
          context: "12345",
        },
      ),
      "Expected first decoded long-action callback.",
    );
    const secondDecoded = requireDefined(
      decodeTelegramApprovalCallback(
        (inlineKeyboard[0]?.[1]?.callback_data ?? "").toString(),
        "callback-secret",
        {
          context: "12345",
        },
      ),
      "Expected second decoded long-action callback.",
    );

    const firstActionId = requireNonEmptyString(firstDecoded.actionId, "Expected first actionId.");
    const secondActionId = requireNonEmptyString(
      secondDecoded.actionId,
      "Expected second actionId.",
    );
    expect(firstActionId).not.toBe(secondActionId);
  });

  test("keeps explicit long request ids distinct for inline callback routing", () => {
    const decodedRequestIds: string[] = [];
    const turn: TurnEnvelope = {
      schema: "brewva.turn.v1",
      kind: "assistant",
      sessionId: "channel:session",
      turnId: "assistant-ui-long-request-id-1",
      channel: "telegram",
      conversationId: "12345",
      timestamp: 1_700_000_000_000,
      parts: [
        {
          type: "text",
          text: `\`\`\`telegram-ui
{
  "version": "telegram-ui/v1",
  "request_id": "request-long-shared-prefix-alpha",
  "screen_id": "first-screen",
  "text": "First action",
  "components": [
    {
      "type": "buttons",
      "rows": [[{ "action_id": "confirm", "label": "Confirm" }]]
    }
  ]
}
\`\`\`
\`\`\`telegram-ui
{
  "version": "telegram-ui/v1",
  "request_id": "request-long-shared-prefix-beta",
  "screen_id": "second-screen",
  "text": "Second action",
  "components": [
    {
      "type": "buttons",
      "rows": [[{ "action_id": "confirm", "label": "Confirm" }]]
    }
  ]
}
\`\`\``,
        },
      ],
    };

    const requests = renderTurnToTelegramRequests(turn, {
      inlineApproval: true,
      callbackSecret: "callback-secret",
    });
    for (const request of requests) {
      if (request.method !== "sendMessage") {
        continue;
      }
      const keyboard = (
        request.params.reply_markup as {
          inline_keyboard?: Array<Array<{ callback_data?: string }>>;
        }
      )?.inline_keyboard;
      const callbackData = (keyboard?.[0]?.[0]?.callback_data ?? "").toString();
      const decoded = decodeTelegramApprovalCallback(callbackData, "callback-secret", {
        context: "12345",
      });
      if (decoded?.requestId) {
        decodedRequestIds.push(decoded.requestId);
      }
    }

    expect(decodedRequestIds).toHaveLength(2);
    expect(new Set(decodedRequestIds).size).toBe(2);
    expect(Math.max(...decodedRequestIds.map((requestId) => requestId.length))).toBeLessThanOrEqual(
      20,
    );
  });

  test("callback turns remain valid without cached approval state", () => {
    const secret = "callback-secret";
    const turn: TurnEnvelope = {
      schema: "brewva.turn.v1",
      kind: "assistant",
      sessionId: "channel:session",
      turnId: "assistant-ui-state-1",
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
  "state_key": "deploy-confirm-st",
  "text": "Choose deploy action",
  "components": [
    {
      "type": "buttons",
      "rows": [[{ "action_id": "confirm", "label": "Confirm" }]]
    }
  ],
  "state": { "flow": "deploy", "step": "confirm" }
}
\`\`\``,
        },
      ],
    };

    const requests = renderTurnToTelegramRequests(turn, {
      inlineApproval: true,
      callbackSecret: secret,
    });

    const callbackData = (
      (
        requests[0]?.params.reply_markup as {
          inline_keyboard?: Array<Array<{ callback_data?: string }>>;
        }
      )?.inline_keyboard?.[0]?.[0]?.callback_data ?? ""
    ).toString();
    expect(callbackData.length).toBeGreaterThan(0);

    const callbackUpdate: TelegramUpdate = {
      update_id: 101,
      callback_query: {
        id: "cbq-state-1",
        from: { id: 99, is_bot: false, first_name: "Ada", username: "ada" },
        message: {
          message_id: 200,
          date: 1_700_000_003,
          chat: { id: 12345, type: "private" },
        },
        data: callbackData,
      },
    };
    const callbackTurn = requireDefined(
      projectTelegramUpdateToTurn(callbackUpdate, {
        callbackSecret: secret,
      }),
      "Expected callback turn to be projected.",
    );

    expect(callbackTurn.kind).toBe("approval");
    requireNonEmptyString(
      callbackTurn.approval?.requestId,
      "Expected approval requestId on callback turn.",
    );

    const firstPart = callbackTurn.parts[0];
    expect(firstPart?.type).toBe("text");
    if (firstPart && firstPart.type === "text") {
      expect(firstPart.text).not.toContain("state_path:");
    }

    expect(callbackTurn.meta?.approvalScreenId).toBeUndefined();
    expect(callbackTurn.meta?.approvalStateKey).toBeUndefined();
    expect(callbackTurn.meta?.approvalState).toBeUndefined();
  });

  test("renders multiple telegram-ui blocks from one assistant message", () => {
    const turn: TurnEnvelope = {
      schema: "brewva.turn.v1",
      kind: "assistant",
      sessionId: "channel:session",
      turnId: "assistant-ui-multi-1",
      channel: "telegram",
      conversationId: "12345",
      timestamp: 1_700_000_000_000,
      parts: [
        {
          type: "text",
          text: `intro
\`\`\`telegram-ui
{
  "version": "telegram-ui/v1",
  "screen_id": "first-screen",
  "text": "First action",
  "components": [
    {
      "type": "buttons",
      "rows": [[{ "action_id": "first", "label": "First" }]]
    }
  ]
}
\`\`\`
next
\`\`\`telegram-ui
{
  "version": "telegram-ui/v1",
  "screen_id": "second-screen",
  "text": "Second action",
  "components": [
    {
      "type": "buttons",
      "rows": [[{ "action_id": "second", "label": "Second" }]]
    }
  ]
}
\`\`\``,
        },
      ],
    };

    const requests = renderTurnToTelegramRequests(turn, {
      inlineApproval: true,
      callbackSecret: "callback-secret",
    });
    const callbackMessages = requests.filter(
      (entry) => entry.method === "sendMessage" && entry.params.reply_markup !== undefined,
    );
    expect(callbackMessages).toHaveLength(2);
    expect(callbackMessages[0]?.params.text).toEqual(expect.stringContaining("intro"));
    expect(callbackMessages[0]?.params.text).toEqual(expect.not.stringContaining("telegram-ui"));
    expect(callbackMessages[1]?.params.text).toBe("Second action");

    const firstDecoded = decodeTelegramApprovalCallback(
      (
        (
          callbackMessages[0]?.params.reply_markup as {
            inline_keyboard?: Array<Array<{ callback_data?: string }>>;
          }
        )?.inline_keyboard?.[0]?.[0]?.callback_data ?? ""
      ).toString(),
      "callback-secret",
      {
        context: "12345",
      },
    );
    const secondDecoded = decodeTelegramApprovalCallback(
      (
        (
          callbackMessages[1]?.params.reply_markup as {
            inline_keyboard?: Array<Array<{ callback_data?: string }>>;
          }
        )?.inline_keyboard?.[0]?.[0]?.callback_data ?? ""
      ).toString(),
      "callback-secret",
      {
        context: "12345",
      },
    );
    expect(firstDecoded?.actionId).toBe("first");
    expect(secondDecoded?.actionId).toBe("second");
  });

  test("does not parse telegram-ui block from tool turns", () => {
    const turn: TurnEnvelope = {
      schema: "brewva.turn.v1",
      kind: "tool",
      sessionId: "channel:session",
      turnId: "tool-ui-1",
      channel: "telegram",
      conversationId: "12345",
      timestamp: 1_700_000_000_000,
      parts: [
        {
          type: "text",
          text: `tool output
\`\`\`telegram-ui
{
  "version": "telegram-ui/v1",
  "screen_id": "should-not-render",
  "text": "Choose deploy action",
  "components": [
    {
      "type": "buttons",
      "rows": [[{ "action_id": "confirm", "label": "Confirm" }]]
    }
  ]
}
\`\`\``,
        },
      ],
    };

    const requests = renderTurnToTelegramRequests(turn, {
      inlineApproval: true,
      callbackSecret: "callback-secret",
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.params.reply_markup).toBeUndefined();
    expect(requests[0]?.params.text).toEqual(expect.stringContaining("telegram-ui"));
  });

  test("falls back to textual telegram-ui instructions when callback secret is missing", () => {
    const turn: TurnEnvelope = {
      schema: "brewva.turn.v1",
      kind: "assistant",
      sessionId: "channel:session",
      turnId: "assistant-ui-2",
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
  "text": "Choose deploy action",
  "components": [
    {
      "type": "buttons",
      "rows": [
        [
          { "action_id": "confirm", "label": "Confirm" },
          { "action_id": "cancel", "label": "Cancel" }
        ]
      ]
    }
  ],
  "fallback_text": "Reply with: confirm or cancel"
}
\`\`\``,
        },
      ],
    };

    const requests = renderTurnToTelegramRequests(turn, {
      inlineApproval: true,
    });
    const messages = requests.filter((entry) => entry.method === "sendMessage");
    expect(messages.length).toBeGreaterThan(0);
    expect(messages.filter((entry) => entry.params.reply_markup !== undefined)).toHaveLength(0);
    expect(
      messages
        .map((entry) => (typeof entry.params.text === "string" ? entry.params.text : ""))
        .join("\n"),
    ).toContain("Reply with: confirm or cancel");
  });

  test("inline callbacks encode request ids without durable routing state", () => {
    const turn: TurnEnvelope = {
      schema: "brewva.turn.v1",
      kind: "assistant",
      sessionId: "agent-session",
      turnId: "t1",
      channel: "telegram",
      conversationId: "12345",
      timestamp: 1_700_000_000_000,
      parts: [
        {
          type: "text",
          text: [
            "Please choose:",
            "```telegram-ui",
            JSON.stringify(
              {
                version: "telegram-ui/v1",
                screen_id: "deploy_confirm_v1",
                text: "Choose next step.",
                components: [
                  {
                    type: "buttons",
                    rows: [[{ action_id: "confirm", label: "Confirm" }]],
                  },
                ],
                state: {
                  flow: "deploy",
                },
                fallback_text: "Reply with: confirm",
              },
              null,
              2,
            ),
            "```",
          ].join("\n"),
        },
      ],
      meta: {
        agentId: "jack",
        agentSessionId: "agent-session",
      },
    };

    const requests = renderTurnToTelegramRequests(turn, {
      inlineApproval: true,
      callbackSecret: "callback-secret",
    });

    expect(requests.length).toBeGreaterThan(0);
    const callbackData = (
      (
        requests[0]?.params.reply_markup as {
          inline_keyboard?: Array<Array<{ callback_data?: string }>>;
        }
      )?.inline_keyboard?.[0]?.[0]?.callback_data ?? ""
    ).toString();
    const decoded = decodeTelegramApprovalCallback(callbackData, "callback-secret", {
      context: "12345",
    });
    expect(decoded?.requestId).toMatch(/^[a-z0-9_-]+_[0-9a-f]{8}$/iu);
  });
});
