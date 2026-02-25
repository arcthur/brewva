#!/usr/bin/env bun

import type { AddressInfo } from "node:net";
import type { TelegramUpdate } from "@brewva/brewva-channels-telegram";
import {
  createTelegramIngressServer,
  createTelegramWebhookWorker,
  type TelegramWebhookWorkerEnv,
} from "@brewva/brewva-ingress";

function listenServer(server: ReturnType<typeof createTelegramIngressServer>): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onError = (error: unknown) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, "127.0.0.1");
  });
}

function closeServer(server: ReturnType<typeof createTelegramIngressServer>): Promise<void> {
  if (!server.listening) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function createUpdate(updateId: number): TelegramUpdate {
  return {
    update_id: updateId,
    message: {
      message_id: 71,
      date: Math.floor(Date.now() / 1000),
      chat: { id: 12345, type: "private" },
      from: { id: 42, is_bot: false, first_name: "Ada" },
      text: "edge-smoke",
    },
  };
}

function asAddressInfo(server: ReturnType<typeof createTelegramIngressServer>): AddressInfo {
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("ingress server address is unavailable");
  }
  return address;
}

async function readResponseJson(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

async function main(): Promise<void> {
  const ingressSecret = "smoke-hmac-secret";
  const telegramSecretToken = "smoke-telegram-secret";
  const ingressEvents: Array<{ updateId: number; dedupeKey: string | null }> = [];

  const ingressServer = createTelegramIngressServer({
    auth: {
      mode: "hmac",
      hmac: {
        secret: ingressSecret,
      },
    },
    path: "/ingest/telegram",
    onUpdate: async (update, input) => {
      ingressEvents.push({
        updateId: update.update_id,
        dedupeKey: input.dedupeKey,
      });
    },
  });

  try {
    await listenServer(ingressServer);
    const address = asAddressInfo(ingressServer);
    const ingressUrl = `http://127.0.0.1:${address.port}/ingest/telegram`;

    const worker = createTelegramWebhookWorker({
      nonceFactory: () => crypto.randomUUID(),
    });
    const workerEnv: TelegramWebhookWorkerEnv = {
      BREWVA_INGRESS_URL: ingressUrl,
      BREWVA_INGRESS_HMAC_SECRET: ingressSecret,
      BREWVA_TELEGRAM_SECRET_TOKEN: telegramSecretToken,
      BREWVA_TELEGRAM_EXPECTED_PATH: "/telegram/webhook",
    };

    const update = createUpdate(9001);
    const body = JSON.stringify(update);
    const makeRequest = () =>
      new Request("https://worker.example/telegram/webhook", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-telegram-bot-api-secret-token": telegramSecretToken,
        },
        body,
      });

    const first = await worker.fetch(makeRequest(), workerEnv, {
      waitUntil() {
        // no-op for smoke run
      },
    });
    const firstPayload = await readResponseJson(first);
    if (first.status !== 200 || firstPayload.code !== "accepted") {
      throw new Error(
        `unexpected first response: status=${first.status} body=${JSON.stringify(firstPayload)}`,
      );
    }

    const second = await worker.fetch(makeRequest(), workerEnv, {
      waitUntil() {
        // no-op for smoke run
      },
    });
    const secondPayload = await readResponseJson(second);
    if (second.status !== 200 || secondPayload.code !== "duplicate") {
      throw new Error(
        `unexpected second response: status=${second.status} body=${JSON.stringify(secondPayload)}`,
      );
    }

    if (ingressEvents.length !== 1) {
      throw new Error(`expected ingress dispatch count=1, got ${ingressEvents.length}`);
    }

    console.log("telegram webhook edge smoke passed");
    console.log(`  ingressUrl: ${ingressUrl}`);
    console.log(`  first: ${JSON.stringify(firstPayload)}`);
    console.log(`  second: ${JSON.stringify(secondPayload)}`);
    console.log(`  ingressEvents: ${JSON.stringify(ingressEvents)}`);
  } finally {
    await closeServer(ingressServer);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`telegram webhook edge smoke failed: ${message}`);
  process.exit(1);
});
