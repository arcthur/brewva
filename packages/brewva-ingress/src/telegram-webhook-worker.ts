const TELEGRAM_SECRET_HEADER = "x-telegram-bot-api-secret-token";
const CONTENT_TYPE_JSON = "application/json; charset=utf-8";
const FORWARDED_BY_HEADER = "x-brewva-forwarded-by";
const FORWARDED_BY_VALUE = "brewva-cf-worker";
const DEDUPE_KEY_PREFIX = "telegram:update:";
const DEFAULT_DEDUPE_TTL_SECONDS = 10 * 60;
const DEFAULT_MAX_BODY_BYTES = 1_048_576;
const DEFAULT_RATE_LIMIT_WINDOW_SECONDS = 60;
const RATE_SCOPE_VALUES = ["chat", "user", "global"] as const;

type RateLimitScope = (typeof RATE_SCOPE_VALUES)[number];

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

interface JsonRecord {
  [key: string]: JsonValue;
}

export interface TelegramWebhookWorkerKvNamespace {
  get(key: string): Promise<string | null>;
  put(
    key: string,
    value: string,
    options?: {
      expirationTtl?: number;
    },
  ): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface TelegramWebhookWorkerEnv {
  BREWVA_INGRESS_URL?: string;
  BREWVA_INGRESS_HMAC_SECRET?: string;
  BREWVA_INGRESS_BEARER_TOKEN?: string;
  BREWVA_TELEGRAM_SECRET_TOKEN?: string;
  BREWVA_TELEGRAM_EXPECTED_PATH?: string;
  BREWVA_TELEGRAM_ALLOWED_CHAT_IDS?: string;
  BREWVA_TELEGRAM_ALLOWED_USER_IDS?: string;
  BREWVA_TELEGRAM_DEDUPE_TTL_SECONDS?: string;
  BREWVA_TELEGRAM_MAX_BODY_BYTES?: string;
  BREWVA_TELEGRAM_RATE_LIMIT_MAX?: string;
  BREWVA_TELEGRAM_RATE_LIMIT_WINDOW_SECONDS?: string;
  BREWVA_TELEGRAM_RATE_LIMIT_SCOPE?: string;
  BREWVA_TELEGRAM_DEDUPE_KV?: TelegramWebhookWorkerKvNamespace;
}

export interface TelegramWebhookWorkerExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

export interface TelegramWebhookWorkerFetchHandler {
  (
    request: Request,
    env: TelegramWebhookWorkerEnv,
    ctx: TelegramWebhookWorkerExecutionContext,
  ): Promise<Response>;
}

export interface TelegramWebhookWorker {
  fetch: TelegramWebhookWorkerFetchHandler;
}

export interface TelegramWebhookReplayStore {
  putIfAbsent(key: string, ttlMs: number, nowMs: number): Promise<boolean>;
  delete(key: string): Promise<void>;
}

export interface TelegramWebhookRateLimiter {
  consume(key: string, max: number, windowMs: number, nowMs: number): boolean;
}

export interface CreateTelegramWebhookWorkerOptions {
  fetchImpl?: TelegramWebhookFetchLike;
  now?: () => number;
  nonceFactory?: () => string;
  replayStore?: TelegramWebhookReplayStore;
  rateLimiter?: TelegramWebhookRateLimiter;
}

export interface TelegramWebhookFetchLike {
  (input: URL | RequestInfo, init?: RequestInit): Promise<Response>;
}

interface ParsedTelegramUpdate {
  updateId: number;
  chatId: string | null;
  userId: string | null;
}

interface WorkerConfig {
  ingressUrl: string;
  ingressHmacSecret: string;
  ingressBearerToken?: string;
  telegramSecretToken?: string;
  expectedPath?: string;
  allowedChatIds: ReadonlySet<string>;
  allowedUserIds: ReadonlySet<string>;
  dedupeTtlMs: number;
  maxBodyBytes: number;
  rateLimitMax: number;
  rateLimitWindowMs: number;
  rateLimitScope: RateLimitScope;
}

class InMemoryReplayStore implements TelegramWebhookReplayStore {
  private readonly entries = new Map<string, number>();

  async putIfAbsent(key: string, ttlMs: number, nowMs: number): Promise<boolean> {
    this.compact(nowMs);
    const current = this.entries.get(key);
    if (current !== undefined && current > nowMs) {
      return false;
    }
    this.entries.set(key, nowMs + Math.max(1, Math.floor(ttlMs)));
    return true;
  }

  async delete(key: string): Promise<void> {
    this.entries.delete(key);
  }

  private compact(nowMs: number): void {
    for (const [key, expiresAt] of this.entries) {
      if (expiresAt <= nowMs) {
        this.entries.delete(key);
      }
    }
  }
}

class KvReplayStore implements TelegramWebhookReplayStore {
  constructor(private readonly kv: TelegramWebhookWorkerKvNamespace) {}

  // KV does not support compare-and-swap, so this has an inherent TOCTOU race:
  // two Worker instances can both observe key=absent, both write, and both
  // forward the same update_id. This is intentionally best-effort edge dedupe.
  // For truly atomic cross-instance deduplication, replace this with a Durable
  // Object that serialises access through a single SQLite write transaction.
  async putIfAbsent(key: string, ttlMs: number): Promise<boolean> {
    const existing = await this.kv.get(key);
    if (existing !== null) {
      return false;
    }
    await this.kv.put(key, "1", { expirationTtl: Math.max(1, Math.ceil(ttlMs / 1000)) });
    return true;
  }

  async delete(key: string): Promise<void> {
    await this.kv.delete(key);
  }
}

class InMemoryRateLimiter implements TelegramWebhookRateLimiter {
  private readonly windows = new Map<string, { windowStartMs: number; count: number }>();

  consume(key: string, max: number, windowMs: number, nowMs: number): boolean {
    this.compact(nowMs, windowMs);

    const current = this.windows.get(key);
    if (!current || nowMs >= current.windowStartMs + windowMs) {
      this.windows.set(key, { windowStartMs: nowMs, count: 1 });
      return true;
    }

    current.count += 1;
    return current.count <= max;
  }

  private compact(nowMs: number, windowMs: number): void {
    if (this.windows.size <= 2_048) return;
    for (const [key, value] of this.windows) {
      if (nowMs >= value.windowStartMs + windowMs * 2) {
        this.windows.delete(key);
      }
    }
  }
}

function normalizeOptionalText(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function normalizePath(value: string | undefined): string | undefined {
  const normalized = normalizeOptionalText(value);
  if (!normalized) return undefined;
  return normalized.startsWith("/") ? normalized : `/${normalized}`;
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

function parseAllowList(raw: string | undefined): ReadonlySet<string> {
  const normalized = normalizeOptionalText(raw);
  if (!normalized) return new Set<string>();
  const values = normalized
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  return new Set(values);
}

function resolveRateLimitScope(raw: string | undefined): RateLimitScope {
  const normalized = normalizeOptionalText(raw)?.toLowerCase();
  if (!normalized) return "chat";
  if ((RATE_SCOPE_VALUES as readonly string[]).includes(normalized)) {
    return normalized as RateLimitScope;
  }
  throw new Error(
    `BREWVA_TELEGRAM_RATE_LIMIT_SCOPE must be one of ${RATE_SCOPE_VALUES.join(", ")}`,
  );
}

function resolveWorkerConfig(env: TelegramWebhookWorkerEnv): WorkerConfig {
  const ingressUrl = normalizeOptionalText(env.BREWVA_INGRESS_URL);
  if (!ingressUrl) {
    throw new Error("BREWVA_INGRESS_URL is required");
  }
  const ingressHmacSecret = normalizeOptionalText(env.BREWVA_INGRESS_HMAC_SECRET);
  if (!ingressHmacSecret) {
    throw new Error("BREWVA_INGRESS_HMAC_SECRET is required");
  }

  const ingressBearerToken = normalizeOptionalText(env.BREWVA_INGRESS_BEARER_TOKEN);
  const telegramSecretToken = normalizeOptionalText(env.BREWVA_TELEGRAM_SECRET_TOKEN);
  const expectedPath = normalizePath(env.BREWVA_TELEGRAM_EXPECTED_PATH);
  const dedupeTtlSeconds =
    parseOptionalPositiveInteger(
      env.BREWVA_TELEGRAM_DEDUPE_TTL_SECONDS,
      "BREWVA_TELEGRAM_DEDUPE_TTL_SECONDS",
    ) ?? DEFAULT_DEDUPE_TTL_SECONDS;
  const maxBodyBytes =
    parseOptionalPositiveInteger(
      env.BREWVA_TELEGRAM_MAX_BODY_BYTES,
      "BREWVA_TELEGRAM_MAX_BODY_BYTES",
    ) ?? DEFAULT_MAX_BODY_BYTES;
  const rateLimitMax =
    parseOptionalPositiveInteger(
      env.BREWVA_TELEGRAM_RATE_LIMIT_MAX,
      "BREWVA_TELEGRAM_RATE_LIMIT_MAX",
    ) ?? 0;
  const rateLimitWindowSeconds =
    parseOptionalPositiveInteger(
      env.BREWVA_TELEGRAM_RATE_LIMIT_WINDOW_SECONDS,
      "BREWVA_TELEGRAM_RATE_LIMIT_WINDOW_SECONDS",
    ) ?? DEFAULT_RATE_LIMIT_WINDOW_SECONDS;

  return {
    ingressUrl,
    ingressHmacSecret,
    ...(ingressBearerToken ? { ingressBearerToken } : {}),
    ...(telegramSecretToken ? { telegramSecretToken } : {}),
    ...(expectedPath ? { expectedPath } : {}),
    allowedChatIds: parseAllowList(env.BREWVA_TELEGRAM_ALLOWED_CHAT_IDS),
    allowedUserIds: parseAllowList(env.BREWVA_TELEGRAM_ALLOWED_USER_IDS),
    dedupeTtlMs: dedupeTtlSeconds * 1000,
    maxBodyBytes,
    rateLimitMax,
    rateLimitWindowMs: rateLimitWindowSeconds * 1000,
    rateLimitScope: resolveRateLimitScope(env.BREWVA_TELEGRAM_RATE_LIMIT_SCOPE),
  };
}

function jsonResponse(status: number, body: JsonRecord): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": CONTENT_TYPE_JSON,
    },
  });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function normalizeId(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value) && Number.isInteger(value)) {
    return String(value);
  }
  if (typeof value === "string") {
    const normalized = value.trim();
    return normalized.length > 0 ? normalized : null;
  }
  return null;
}

function resolveNestedId(parent: Record<string, unknown>, ...path: string[]): string | null {
  let cursor: unknown = parent;
  for (const segment of path) {
    if (!cursor || typeof cursor !== "object" || Array.isArray(cursor)) {
      return null;
    }
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return normalizeId(cursor);
}

function parseTelegramUpdate(rawBody: string): ParsedTelegramUpdate | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return null;
  }

  const root = asRecord(parsed);
  if (!root) return null;
  if (typeof root.update_id !== "number" || !Number.isInteger(root.update_id)) {
    return null;
  }

  let chatId: string | null = null;
  let userId: string | null = null;
  const messageKeys = [
    "message",
    "edited_message",
    "channel_post",
    "edited_channel_post",
    "my_chat_member",
    "chat_member",
    "chat_join_request",
  ];

  for (const key of messageKeys) {
    const frame = asRecord(root[key]);
    if (!frame) continue;
    chatId ??= resolveNestedId(frame, "chat", "id");
    userId ??= resolveNestedId(frame, "from", "id");
    if (chatId && userId) break;
  }

  const callbackQuery = asRecord(root.callback_query);
  if (callbackQuery) {
    chatId ??= resolveNestedId(callbackQuery, "message", "chat", "id");
    userId ??= resolveNestedId(callbackQuery, "from", "id");
  }

  const fromCarrierKeys = [
    "inline_query",
    "chosen_inline_result",
    "shipping_query",
    "pre_checkout_query",
  ];
  for (const key of fromCarrierKeys) {
    const frame = asRecord(root[key]);
    if (!frame) continue;
    userId ??= resolveNestedId(frame, "from", "id");
    if (userId) break;
  }

  return {
    updateId: root.update_id,
    chatId,
    userId,
  };
}

function isAllowed(update: ParsedTelegramUpdate, config: WorkerConfig): boolean {
  if (config.allowedChatIds.size > 0) {
    if (!update.chatId || !config.allowedChatIds.has(update.chatId)) {
      return false;
    }
  }
  if (config.allowedUserIds.size > 0) {
    if (!update.userId || !config.allowedUserIds.has(update.userId)) {
      return false;
    }
  }
  return true;
}

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) {
    return false;
  }
  let mismatch = 0;
  for (let i = 0; i < left.length; i += 1) {
    mismatch |= left.charCodeAt(i) ^ right.charCodeAt(i);
  }
  return mismatch === 0;
}

function resolveRateLimitKey(update: ParsedTelegramUpdate, scope: RateLimitScope): string {
  if (scope === "global") return "global";
  if (scope === "user") {
    return update.userId ? `user:${update.userId}` : "user:unknown";
  }
  return update.chatId ? `chat:${update.chatId}` : "chat:unknown";
}

const HMAC_KEY_CACHE_MAX = 8;
const hmacKeyCache = new Map<string, Promise<CryptoKey>>();

async function resolveHmacKey(secret: string): Promise<CryptoKey> {
  const existing = hmacKeyCache.get(secret);
  if (existing) return await existing;

  // Evict the oldest entry when the cache is full so that secret rotation
  // does not leave stale CryptoKey objects alive for the isolate's lifetime.
  if (hmacKeyCache.size >= HMAC_KEY_CACHE_MAX) {
    const firstKey = hmacKeyCache.keys().next().value;
    if (firstKey !== undefined) {
      hmacKeyCache.delete(firstKey);
    }
  }

  const pending = crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  hmacKeyCache.set(secret, pending);
  return await pending;
}

function toHex(input: ArrayBuffer): string {
  const bytes = new Uint8Array(input);
  let out = "";
  for (const byte of bytes) {
    out += byte.toString(16).padStart(2, "0");
  }
  return out;
}

export async function createWorkerIngressHmacSignature(input: {
  secret: string;
  timestamp: string | number;
  nonce: string;
  body: string;
}): Promise<string> {
  const timestamp = String(input.timestamp);
  const payload = `${timestamp}.${input.nonce}.${input.body}`;
  const key = await resolveHmacKey(input.secret);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return `v1=${toHex(signature)}`;
}

function isForwardSuccess(status: number): boolean {
  return (status >= 200 && status < 300) || status === 409;
}

export function createTelegramWebhookWorker(
  options: CreateTelegramWebhookWorkerOptions = {},
): TelegramWebhookWorker {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => Date.now());
  const nonceFactory = options.nonceFactory ?? (() => crypto.randomUUID());
  const localReplayStore = options.replayStore ?? new InMemoryReplayStore();
  const localRateLimiter = options.rateLimiter ?? new InMemoryRateLimiter();

  const resolveReplayStore = (env: TelegramWebhookWorkerEnv): TelegramWebhookReplayStore => {
    if (options.replayStore) {
      return options.replayStore;
    }
    if (env.BREWVA_TELEGRAM_DEDUPE_KV) {
      return new KvReplayStore(env.BREWVA_TELEGRAM_DEDUPE_KV);
    }
    return localReplayStore;
  };

  // ctx (waitUntil) is intentionally unused. The forward to the Fly ingress is
  // done synchronously so that a failed forward can roll back the edge dedupe
  // reservation and return a 502, causing Telegram to retry. Moving the forward
  // into waitUntil would make rollback impossible.
  const handleFetch: TelegramWebhookWorkerFetchHandler = async (request, env) => {
    let config: WorkerConfig;
    try {
      config = resolveWorkerConfig(env);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return jsonResponse(500, {
        ok: false,
        code: "config_error",
        message,
      });
    }

    if (request.method.toUpperCase() !== "POST") {
      return jsonResponse(405, {
        ok: false,
        code: "method_not_allowed",
        message: "POST is required",
      });
    }

    if (config.expectedPath) {
      const requestPath = new URL(request.url).pathname;
      if (requestPath !== config.expectedPath) {
        return jsonResponse(404, {
          ok: false,
          code: "not_found",
          message: "route not found",
        });
      }
    }

    if (config.telegramSecretToken) {
      const provided = request.headers.get(TELEGRAM_SECRET_HEADER)?.trim() ?? "";
      if (!provided) {
        return jsonResponse(401, {
          ok: false,
          code: "unauthorized",
          message: `missing ${TELEGRAM_SECRET_HEADER}`,
        });
      }
      if (!constantTimeEqual(provided, config.telegramSecretToken)) {
        return jsonResponse(401, {
          ok: false,
          code: "unauthorized",
          message: "invalid telegram secret token",
        });
      }
    }

    const rawBody = await request.text();
    const bodyBytes = new TextEncoder().encode(rawBody).length;
    if (bodyBytes > config.maxBodyBytes) {
      return jsonResponse(413, {
        ok: false,
        code: "payload_too_large",
        message: `request body exceeds ${config.maxBodyBytes} bytes`,
      });
    }

    const update = parseTelegramUpdate(rawBody);
    if (!update) {
      return jsonResponse(400, {
        ok: false,
        code: "bad_request",
        message: "invalid telegram update payload",
      });
    }

    if (!isAllowed(update, config)) {
      return jsonResponse(200, {
        ok: true,
        code: "dropped_acl",
        updateId: update.updateId,
      });
    }

    if (config.rateLimitMax > 0) {
      // Note: InMemoryRateLimiter state is local to this Worker instance.
      // In a multi-instance deployment each instance enforces its own window,
      // so the effective global limit is rateLimitMax * instanceCount.
      // For true cross-instance rate limiting use Cloudflare Durable Objects
      // or the Cloudflare Rate Limiting API.
      const rateKey = resolveRateLimitKey(update, config.rateLimitScope);
      const allowed = localRateLimiter.consume(
        rateKey,
        config.rateLimitMax,
        config.rateLimitWindowMs,
        now(),
      );
      if (!allowed) {
        return jsonResponse(429, {
          ok: false,
          code: "rate_limited",
          message: "rate limit exceeded",
          scope: config.rateLimitScope,
        });
      }
    }

    const replayStore = resolveReplayStore(env);
    const dedupeKey = `${DEDUPE_KEY_PREFIX}${update.updateId}`;
    const reserved = await replayStore.putIfAbsent(dedupeKey, config.dedupeTtlMs, now());
    if (!reserved) {
      return jsonResponse(200, {
        ok: true,
        code: "duplicate",
        dedupeKey,
      });
    }

    const timestamp = String(Math.floor(now() / 1000));
    const nonce = nonceFactory();
    const signature = await createWorkerIngressHmacSignature({
      secret: config.ingressHmacSecret,
      timestamp,
      nonce,
      body: rawBody,
    });

    const headers = new Headers();
    headers.set("content-type", CONTENT_TYPE_JSON);
    headers.set("x-brewva-signature", signature);
    headers.set("x-brewva-timestamp", timestamp);
    headers.set("x-brewva-nonce", nonce);
    headers.set(FORWARDED_BY_HEADER, FORWARDED_BY_VALUE);
    headers.set("x-brewva-telegram-update-id", String(update.updateId));
    if (update.chatId) {
      headers.set("x-brewva-telegram-chat-id", update.chatId);
    }
    if (update.userId) {
      headers.set("x-brewva-telegram-user-id", update.userId);
    }
    if (config.ingressBearerToken) {
      headers.set("authorization", `Bearer ${config.ingressBearerToken}`);
    }

    let forwardResponse: Response;
    try {
      forwardResponse = await fetchImpl(config.ingressUrl, {
        method: "POST",
        headers,
        body: rawBody,
      });
    } catch {
      await replayStore.delete(dedupeKey);
      return jsonResponse(502, {
        ok: false,
        code: "forward_failed",
        message: "failed to reach ingress",
      });
    }

    if (!isForwardSuccess(forwardResponse.status)) {
      await replayStore.delete(dedupeKey);
      return jsonResponse(502, {
        ok: false,
        code: "forward_rejected",
        message: `ingress responded with ${forwardResponse.status}`,
        dedupeKey,
      });
    }

    return jsonResponse(200, {
      ok: true,
      code: "accepted",
      dedupeKey,
      ingressStatus: forwardResponse.status,
    });
  };

  return {
    fetch: handleFetch,
  };
}

const defaultTelegramWebhookWorker = createTelegramWebhookWorker();

export default defaultTelegramWebhookWorker;
