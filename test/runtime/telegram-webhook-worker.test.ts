import { describe, expect, test } from "bun:test";
import type { TelegramUpdate } from "@brewva/brewva-channels-telegram";
import {
  createIngressHmacSignature,
  createTelegramWebhookWorker,
  createWorkerIngressHmacSignature,
  type TelegramWebhookWorkerEnv,
} from "@brewva/brewva-ingress";

const NOOP_EXECUTION_CONTEXT = {
  waitUntil() {
    // no-op in unit tests
  },
};

function createTelegramUpdate(updateId: number): TelegramUpdate {
  return {
    update_id: updateId,
    message: {
      message_id: 99,
      date: 1_700_000_000,
      chat: { id: 12345, type: "private" },
      from: { id: 42, is_bot: false, first_name: "Ada" },
      text: "hello worker",
    },
  };
}

function createWebhookRequest(input: {
  update: TelegramUpdate;
  url?: string;
  telegramSecretToken?: string;
}): Request {
  const headers = new Headers();
  headers.set("content-type", "application/json");
  if (input.telegramSecretToken) {
    headers.set("x-telegram-bot-api-secret-token", input.telegramSecretToken);
  }
  return new Request(input.url ?? "https://edge.example/telegram/webhook", {
    method: "POST",
    headers,
    body: JSON.stringify(input.update),
  });
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

describe("telegram webhook worker", () => {
  test("worker hmac signature format matches ingress processor expectation", async () => {
    const input = {
      secret: "worker-shared-secret",
      timestamp: "1700000000",
      nonce: "nonce-1",
      body: JSON.stringify(createTelegramUpdate(7001)),
    };

    const workerSignature = await createWorkerIngressHmacSignature(input);
    const ingressSignature = createIngressHmacSignature(input);

    expect(workerSignature).toBe(ingressSignature);
  });

  test("forwards accepted update with ingress auth headers", async () => {
    const nowMs = 1_700_000_000_000;
    const update = createTelegramUpdate(7002);
    const body = JSON.stringify(update);
    const forwardCalls: Request[] = [];

    const worker = createTelegramWebhookWorker({
      now: () => nowMs,
      nonceFactory: () => "nonce-accepted",
      fetchImpl: async (input, init) => {
        const request = input instanceof Request ? input : new Request(String(input), init);
        forwardCalls.push(request);
        return new Response(JSON.stringify({ ok: true }), { status: 202 });
      },
    });

    const env: TelegramWebhookWorkerEnv = {
      BREWVA_INGRESS_URL: "https://fly.example/ingest/telegram",
      BREWVA_INGRESS_HMAC_SECRET: "shared-hmac-secret",
      BREWVA_INGRESS_BEARER_TOKEN: "edge-bearer-token",
      BREWVA_TELEGRAM_SECRET_TOKEN: "telegram-secret",
      BREWVA_TELEGRAM_EXPECTED_PATH: "/telegram/webhook",
    };

    const response = await worker.fetch(
      createWebhookRequest({
        update,
        telegramSecretToken: "telegram-secret",
      }),
      env,
      NOOP_EXECUTION_CONTEXT,
    );
    const payload = await readJson(response);

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      ok: true,
      code: "accepted",
      dedupeKey: "telegram:update:7002",
      ingressStatus: 202,
    });
    expect(forwardCalls).toHaveLength(1);
    expect(forwardCalls[0]?.url).toBe("https://fly.example/ingest/telegram");
    expect(forwardCalls[0]?.headers.get("authorization")).toBe("Bearer edge-bearer-token");
    expect(forwardCalls[0]?.headers.get("x-brewva-timestamp")).toBe("1700000000");
    expect(forwardCalls[0]?.headers.get("x-brewva-nonce")).toBe("nonce-accepted");
    expect(forwardCalls[0]?.headers.get("x-brewva-signature")).toBe(
      createIngressHmacSignature({
        secret: "shared-hmac-secret",
        timestamp: "1700000000",
        nonce: "nonce-accepted",
        body,
      }),
    );
  });

  test("short-circuits duplicate update id at edge", async () => {
    const update = createTelegramUpdate(7003);
    let forwardCount = 0;

    const worker = createTelegramWebhookWorker({
      fetchImpl: async () => {
        forwardCount += 1;
        return new Response("{}", { status: 202 });
      },
    });

    const env: TelegramWebhookWorkerEnv = {
      BREWVA_INGRESS_URL: "https://fly.example/ingest/telegram",
      BREWVA_INGRESS_HMAC_SECRET: "shared-hmac-secret",
    };

    const first = await worker.fetch(
      createWebhookRequest({
        update,
      }),
      env,
      NOOP_EXECUTION_CONTEXT,
    );
    const second = await worker.fetch(
      createWebhookRequest({
        update,
      }),
      env,
      NOOP_EXECUTION_CONTEXT,
    );

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await readJson(second)).toMatchObject({
      ok: true,
      code: "duplicate",
      dedupeKey: "telegram:update:7003",
    });
    expect(forwardCount).toBe(1);
  });

  test("rolls back edge dedupe reservation when ingress returns failure", async () => {
    const update = createTelegramUpdate(7004);
    let attempts = 0;

    const worker = createTelegramWebhookWorker({
      fetchImpl: async () => {
        attempts += 1;
        if (attempts === 1) {
          return new Response("{}", { status: 500 });
        }
        return new Response("{}", { status: 202 });
      },
    });

    const env: TelegramWebhookWorkerEnv = {
      BREWVA_INGRESS_URL: "https://fly.example/ingest/telegram",
      BREWVA_INGRESS_HMAC_SECRET: "shared-hmac-secret",
    };

    const first = await worker.fetch(
      createWebhookRequest({
        update,
      }),
      env,
      NOOP_EXECUTION_CONTEXT,
    );
    const second = await worker.fetch(
      createWebhookRequest({
        update,
      }),
      env,
      NOOP_EXECUTION_CONTEXT,
    );

    expect(first.status).toBe(502);
    expect(await readJson(first)).toMatchObject({
      ok: false,
      code: "forward_rejected",
    });
    expect(second.status).toBe(200);
    expect(await readJson(second)).toMatchObject({
      ok: true,
      code: "accepted",
    });
    expect(attempts).toBe(2);
  });

  test("drops update when ACL allowlist does not match", async () => {
    let forwarded = false;
    const worker = createTelegramWebhookWorker({
      fetchImpl: async () => {
        forwarded = true;
        return new Response("{}", { status: 202 });
      },
    });

    const env: TelegramWebhookWorkerEnv = {
      BREWVA_INGRESS_URL: "https://fly.example/ingest/telegram",
      BREWVA_INGRESS_HMAC_SECRET: "shared-hmac-secret",
      BREWVA_TELEGRAM_ALLOWED_CHAT_IDS: "88888",
    };

    const response = await worker.fetch(
      createWebhookRequest({
        update: createTelegramUpdate(7005),
      }),
      env,
      NOOP_EXECUTION_CONTEXT,
    );

    expect(response.status).toBe(200);
    expect(await readJson(response)).toMatchObject({
      ok: true,
      code: "dropped_acl",
      updateId: 7005,
    });
    expect(forwarded).toBeFalse();
  });
});
