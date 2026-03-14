import { describe, expect, test } from "bun:test";
import type { TelegramUpdate } from "@brewva/brewva-channels-telegram";
import {
  TelegramIngressProcessor,
  createIngressHmacSignature,
  type TelegramIngressRequest,
} from "@brewva/brewva-ingress";

function createUpdate(updateId = 5001): TelegramUpdate {
  return {
    update_id: updateId,
    message: {
      message_id: 71,
      date: 1_700_000_000,
      chat: { id: 12345, type: "private" },
      from: { id: 42, is_bot: false, first_name: "Ada" },
      text: "hello ingress",
    },
  };
}

function createHmacRequest(input: {
  secret: string;
  nonce: string;
  timestamp: string | number;
  update?: TelegramUpdate;
}): TelegramIngressRequest {
  const body = JSON.stringify(input.update ?? createUpdate());
  return {
    method: "POST",
    headers: {
      "x-brewva-signature": createIngressHmacSignature({
        secret: input.secret,
        timestamp: input.timestamp,
        nonce: input.nonce,
        body,
      }),
      "x-brewva-timestamp": String(input.timestamp),
      "x-brewva-nonce": input.nonce,
    },
    body,
  };
}

describe("telegram ingress processor", () => {
  test("accepts valid hmac update and dispatches once", async () => {
    const accepted: TelegramUpdate[] = [];
    const nowMs = 1_700_000_000_000;
    const processor = new TelegramIngressProcessor({
      auth: {
        mode: "hmac",
        hmac: { secret: "ingress-secret" },
      },
      now: () => nowMs,
      onUpdate: async (update) => {
        accepted.push(update);
      },
    });

    const request = createHmacRequest({
      secret: "ingress-secret",
      nonce: "nonce-1",
      timestamp: Math.floor(nowMs / 1000),
    });
    const result = await processor.handle(request);

    expect(result.status).toBe(202);
    expect(result.body).toEqual({
      ok: true,
      code: "accepted",
      dedupeKey: "telegram:12345:71",
    });
    expect(accepted).toHaveLength(1);
  });

  test("rejects replayed hmac nonce", async () => {
    const nowMs = 1_700_000_100_000;
    const processor = new TelegramIngressProcessor({
      auth: {
        mode: "hmac",
        hmac: { secret: "ingress-secret" },
      },
      now: () => nowMs,
      onUpdate: async () => undefined,
    });

    const request = createHmacRequest({
      secret: "ingress-secret",
      nonce: "replay-1",
      timestamp: Math.floor(nowMs / 1000),
    });
    const first = await processor.handle(request);
    const second = await processor.handle(request);

    expect(first.status).toBe(202);
    expect(second.status).toBe(401);
    expect(second.body).toEqual({
      ok: false,
      code: "unauthorized",
      message: "replayed nonce",
    });
  });

  test("returns duplicate when update dedupe key already exists", async () => {
    let nowMs = 1_700_000_200_000;
    const processor = new TelegramIngressProcessor({
      auth: {
        mode: "hmac",
        hmac: { secret: "ingress-secret" },
      },
      now: () => nowMs,
      onUpdate: async () => undefined,
    });
    const update = createUpdate(7777);

    const first = await processor.handle(
      createHmacRequest({
        secret: "ingress-secret",
        nonce: "nonce-a",
        timestamp: Math.floor(nowMs / 1000),
        update,
      }),
    );
    nowMs += 500;
    const second = await processor.handle(
      createHmacRequest({
        secret: "ingress-secret",
        nonce: "nonce-b",
        timestamp: Math.floor(nowMs / 1000),
        update,
      }),
    );

    expect(first.status).toBe(202);
    expect(second.status).toBe(409);
    expect(second.body).toEqual({
      ok: false,
      code: "duplicate",
      dedupeKey: "telegram:12345:71",
    });
  });

  test("rolls back dedupe reservation when dispatch fails", async () => {
    let nowMs = 1_700_000_300_000;
    let attempts = 0;
    const processor = new TelegramIngressProcessor({
      auth: {
        mode: "hmac",
        hmac: { secret: "ingress-secret" },
      },
      now: () => nowMs,
      onUpdate: async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error("temporary dispatch failure");
        }
      },
    });
    const update = createUpdate(8888);

    const first = await processor.handle(
      createHmacRequest({
        secret: "ingress-secret",
        nonce: "rollback-a",
        timestamp: Math.floor(nowMs / 1000),
        update,
      }),
    );
    nowMs += 500;
    const second = await processor.handle(
      createHmacRequest({
        secret: "ingress-secret",
        nonce: "rollback-b",
        timestamp: Math.floor(nowMs / 1000),
        update,
      }),
    );

    expect(first.status).toBe(500);
    expect(first.body).toEqual({
      ok: false,
      code: "internal_error",
      message: "failed to dispatch update",
    });
    expect(second.status).toBe(202);
    expect(attempts).toBe(2);
  });

  test("supports bearer auth mode", async () => {
    const processor = new TelegramIngressProcessor({
      auth: {
        mode: "bearer",
        bearer: { token: "shared-token" },
      },
      onUpdate: async () => undefined,
    });
    const body = JSON.stringify(createUpdate());
    const accepted = await processor.handle({
      method: "POST",
      headers: {
        authorization: "Bearer shared-token",
      },
      body,
    });
    const rejected = await processor.handle({
      method: "POST",
      headers: {
        authorization: "Bearer bad-token",
      },
      body,
    });

    expect(accepted.status).toBe(202);
    expect(rejected.status).toBe(401);
  });
});
