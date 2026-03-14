import { describe, expect, test } from "bun:test";
import {
  TelegramWebhookTransport,
  type TelegramFetchLike,
  type TelegramOutboundRequest,
  type TelegramUpdate,
} from "@brewva/brewva-channels-telegram";
import { assertRejectsWithMessage, resolveRequestUrl } from "../helpers.js";

interface FetchCall {
  url: string;
  method: string;
  bodyJson: Record<string, unknown>;
}

function createJsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: {
      "content-type": "application/json",
    },
  });
}

function createFetchStub(
  responders: Array<(url: string, init: RequestInit) => Promise<Response>>,
): {
  fetchImpl: TelegramFetchLike;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  const fetchImpl: TelegramFetchLike = async (input, init) => {
    const url = resolveRequestUrl(input);
    const resolvedInit = init ?? {};
    const method = resolvedInit.method ?? "GET";
    const bodyRaw = typeof resolvedInit.body === "string" ? resolvedInit.body : "{}";
    const bodyJson = JSON.parse(bodyRaw) as Record<string, unknown>;
    calls.push({ url, method, bodyJson });

    const responder = responders.shift();
    if (!responder) {
      throw new Error(`unexpected fetch call: ${url}`);
    }
    return responder(url, resolvedInit);
  };
  return { fetchImpl, calls };
}

function createMessageUpdate(): TelegramUpdate {
  return {
    update_id: 1001,
    message: {
      message_id: 88,
      date: 1_700_000_000,
      chat: { id: 12345, type: "private" },
      from: { id: 42, is_bot: false, first_name: "Ada" },
      text: "hello webhook",
    },
  };
}

describe("channel telegram webhook transport", () => {
  test("ingests update only when transport is running", async () => {
    const seen: TelegramUpdate[] = [];
    const transport = new TelegramWebhookTransport({
      token: "bot-token",
    });

    const beforeStart = await transport.ingest(createMessageUpdate());
    expect(beforeStart).toEqual({
      accepted: false,
      reason: "transport_not_running",
    });

    await transport.start({
      onUpdate: async (update) => {
        seen.push(update);
      },
    });

    const startedResult = await transport.ingest(createMessageUpdate());
    expect(startedResult).toEqual({ accepted: true });
    expect(seen).toHaveLength(1);

    await transport.stop();
    const afterStop = await transport.ingest(createMessageUpdate());
    expect(afterStop).toEqual({
      accepted: false,
      reason: "transport_not_running",
    });
  });

  test("delegates outbound send via telegram api", async () => {
    const request: TelegramOutboundRequest = {
      method: "sendMessage",
      params: {
        chat_id: "12345",
        text: "hello",
      },
    };
    const { fetchImpl, calls } = createFetchStub([
      async () =>
        createJsonResponse({
          ok: true,
          result: { message_id: 333 },
        }),
    ]);

    const transport = new TelegramWebhookTransport({
      token: "bot-token",
      fetchImpl,
    });
    const result = await transport.send(request);

    expect(result).toEqual({ providerMessageId: 333 });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.telegram.org/botbot-token/sendMessage");
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.bodyJson).toEqual({
      chat_id: "12345",
      text: "hello",
    });
  });

  test("reports ingress handler errors through onError hook", async () => {
    const errors: string[] = [];
    const transport = new TelegramWebhookTransport({
      token: "bot-token",
      onError: async (error) => {
        errors.push(error instanceof Error ? error.message : String(error));
      },
    });

    await transport.start({
      onUpdate: async () => {
        throw new Error("ingest failed");
      },
    });

    await assertRejectsWithMessage(() => transport.ingest(createMessageUpdate()), "ingest failed");
    expect(errors).toEqual(["ingest failed"]);
  });
});
