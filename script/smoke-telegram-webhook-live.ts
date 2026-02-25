#!/usr/bin/env bun

interface LiveSmokeConfig {
  url: string;
  telegramSecretToken?: string;
  chatId: number;
  userId: number;
  timeoutMs: number;
  assertDedupe: boolean;
}

interface WorkerResponseShape {
  ok?: unknown;
  code?: unknown;
  ingressStatus?: unknown;
  [key: string]: unknown;
}

function normalizeOptionalText(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function parseOptionalPositiveInteger(
  value: string | undefined,
  fieldName: string,
): number | undefined {
  const normalized = normalizeOptionalText(value);
  if (!normalized) return undefined;
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${fieldName} must be a positive integer`);
  }
  return parsed;
}

function parseBooleanFlag(value: string | undefined): boolean {
  const normalized = normalizeOptionalText(value)?.toLowerCase();
  if (!normalized) return false;
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function resolveConfig(env: NodeJS.ProcessEnv): LiveSmokeConfig {
  const url = normalizeOptionalText(env.BREWVA_WEBHOOK_LIVE_URL);
  if (!url) {
    throw new Error("BREWVA_WEBHOOK_LIVE_URL is required");
  }

  const chatId =
    parseOptionalPositiveInteger(env.BREWVA_WEBHOOK_LIVE_CHAT_ID, "BREWVA_WEBHOOK_LIVE_CHAT_ID") ??
    12345;
  const userId =
    parseOptionalPositiveInteger(env.BREWVA_WEBHOOK_LIVE_USER_ID, "BREWVA_WEBHOOK_LIVE_USER_ID") ??
    42;
  const timeoutMs =
    parseOptionalPositiveInteger(
      env.BREWVA_WEBHOOK_LIVE_TIMEOUT_MS,
      "BREWVA_WEBHOOK_LIVE_TIMEOUT_MS",
    ) ?? 15_000;

  return {
    url,
    telegramSecretToken: normalizeOptionalText(env.BREWVA_WEBHOOK_LIVE_TELEGRAM_SECRET),
    chatId,
    userId,
    timeoutMs,
    assertDedupe: parseBooleanFlag(env.BREWVA_WEBHOOK_LIVE_ASSERT_DEDUPE),
  };
}

function createUpdate(input: {
  updateId: number;
  chatId: number;
  userId: number;
  messageId: number;
}): Record<string, unknown> {
  return {
    update_id: input.updateId,
    message: {
      message_id: input.messageId,
      date: Math.floor(Date.now() / 1000),
      chat: {
        id: input.chatId,
        type: "private",
      },
      from: {
        id: input.userId,
        is_bot: false,
        first_name: "LiveSmoke",
      },
      text: "live-webhook-smoke",
    },
  };
}

async function readWorkerJson(response: Response): Promise<WorkerResponseShape> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    const raw = await response.text();
    throw new Error(
      `expected json response, got content-type=${contentType}, body=${raw.slice(0, 500)}`,
    );
  }
  const parsed = (await response.json()) as WorkerResponseShape;
  return parsed;
}

function assertFirstResponse(response: Response, payload: WorkerResponseShape): void {
  if (response.status !== 200) {
    throw new Error(
      `live smoke failed: expected HTTP 200, got ${response.status}, body=${JSON.stringify(payload)}`,
    );
  }
  if (payload.code !== "accepted") {
    throw new Error(
      `live smoke failed: expected first response code=accepted, got ${String(payload.code)}, body=${JSON.stringify(payload)}`,
    );
  }
}

function assertSecondResponse(payload: WorkerResponseShape): void {
  if (payload.code === "duplicate") {
    return;
  }
  if (payload.code === "accepted" && payload.ingressStatus === 409) {
    return;
  }
  throw new Error(
    [
      "live smoke dedupe check failed: expected duplicate edge hit",
      "or ingress idempotency hit (accepted + ingressStatus=409).",
      `actual body=${JSON.stringify(payload)}`,
    ].join(" "),
  );
}

async function postUpdate(input: {
  url: string;
  telegramSecretToken?: string;
  body: string;
  timeoutMs: number;
}): Promise<{ response: Response; payload: WorkerResponseShape }> {
  const headers = new Headers();
  headers.set("content-type", "application/json");
  if (input.telegramSecretToken) {
    headers.set("x-telegram-bot-api-secret-token", input.telegramSecretToken);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs);
  try {
    const response = await fetch(input.url, {
      method: "POST",
      headers,
      body: input.body,
      signal: controller.signal,
    });
    const payload = await readWorkerJson(response);
    return { response, payload };
  } finally {
    clearTimeout(timer);
  }
}

async function main(): Promise<void> {
  const config = resolveConfig(process.env);
  const uniqueBase = Date.now() * 1000 + Math.floor(Math.random() * 1000);
  const update = createUpdate({
    updateId: uniqueBase,
    chatId: config.chatId,
    userId: config.userId,
    messageId: uniqueBase,
  });
  const body = JSON.stringify(update);

  const first = await postUpdate({
    url: config.url,
    telegramSecretToken: config.telegramSecretToken,
    body,
    timeoutMs: config.timeoutMs,
  });
  assertFirstResponse(first.response, first.payload);

  let secondPayload: WorkerResponseShape | undefined;
  if (config.assertDedupe) {
    const second = await postUpdate({
      url: config.url,
      telegramSecretToken: config.telegramSecretToken,
      body,
      timeoutMs: config.timeoutMs,
    });
    if (second.response.status !== 200) {
      throw new Error(
        `live smoke dedupe check failed: expected HTTP 200, got ${second.response.status}, body=${JSON.stringify(second.payload)}`,
      );
    }
    assertSecondResponse(second.payload);
    secondPayload = second.payload;
  }

  console.log("telegram webhook live smoke passed");
  console.log(`  url: ${config.url}`);
  console.log(`  first: ${JSON.stringify(first.payload)}`);
  if (secondPayload) {
    console.log(`  second: ${JSON.stringify(secondPayload)}`);
  } else {
    console.log("  second: skipped (set BREWVA_WEBHOOK_LIVE_ASSERT_DEDUPE=1 to enable)");
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`telegram webhook live smoke failed: ${message}`);
  process.exit(1);
});
