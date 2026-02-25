import { createHmac, timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import {
  buildTelegramInboundDedupeKey,
  type TelegramUpdate,
} from "@brewva/brewva-channels-telegram";

const DEFAULT_INGRESS_PATH = "/ingest/telegram";
const DEFAULT_MAX_BODY_BYTES = 1_048_576;
const DEFAULT_DEDUPE_TTL_MS = 10 * 60_000;
const DEFAULT_HMAC_MAX_SKEW_MS = 5 * 60_000;
const DEFAULT_HMAC_SIGNATURE_HEADER = "x-brewva-signature";
const DEFAULT_HMAC_TIMESTAMP_HEADER = "x-brewva-timestamp";
const DEFAULT_HMAC_NONCE_HEADER = "x-brewva-nonce";
const DEFAULT_BEARER_HEADER = "authorization";

interface IngressOkBody {
  ok: true;
  code: "accepted";
  dedupeKey: string | null;
}

interface IngressDuplicateBody {
  ok: false;
  code: "duplicate";
  dedupeKey: string;
}

interface IngressErrorBody {
  ok: false;
  code:
    | "method_not_allowed"
    | "bad_request"
    | "unauthorized"
    | "payload_too_large"
    | "not_found"
    | "internal_error";
  message: string;
}

export type TelegramIngressResponseBody = IngressOkBody | IngressDuplicateBody | IngressErrorBody;

export interface TelegramIngressResult {
  status: number;
  body: TelegramIngressResponseBody;
}

export interface BearerAuthConfig {
  token: string;
  header?: string;
}

export interface HmacAuthConfig {
  secret: string;
  signatureHeader?: string;
  timestampHeader?: string;
  nonceHeader?: string;
  maxSkewMs?: number;
  nonceTtlMs?: number;
}

export type TelegramIngressAuth =
  | {
      mode: "bearer";
      bearer: BearerAuthConfig;
    }
  | {
      mode: "hmac";
      hmac: HmacAuthConfig;
    }
  | {
      mode: "both";
      bearer: BearerAuthConfig;
      hmac: HmacAuthConfig;
    };

export interface ReplayStore {
  putIfAbsent(key: string, ttlMs: number, nowMs: number): boolean;
  delete(key: string): void;
}

export class InMemoryReplayStore implements ReplayStore {
  private readonly entries = new Map<string, number>();

  putIfAbsent(key: string, ttlMs: number, nowMs: number): boolean {
    this.compact(nowMs);
    const current = this.entries.get(key);
    if (current !== undefined && current > nowMs) {
      return false;
    }
    this.entries.set(key, nowMs + Math.max(1, Math.floor(ttlMs)));
    return true;
  }

  delete(key: string): void {
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

export interface TelegramIngressProcessorOptions {
  auth: TelegramIngressAuth;
  onUpdate: (update: TelegramUpdate, input: { dedupeKey: string | null }) => Promise<void>;
  now?: () => number;
  dedupeTtlMs?: number;
  dedupeStore?: ReplayStore;
  nonceStore?: ReplayStore;
}

export interface TelegramIngressRequest {
  method: string;
  headers: Record<string, string | undefined>;
  body: string;
}

export interface CreateIngressHmacSignatureInput {
  secret: string;
  timestamp: string | number;
  nonce: string;
  body: string;
}

export function createIngressHmacSignature(input: CreateIngressHmacSignatureInput): string {
  const timestamp = String(input.timestamp);
  const payload = `${timestamp}.${input.nonce}.${input.body}`;
  const digest = createHmac("sha256", input.secret).update(payload).digest("hex");
  return `v1=${digest}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function toHeaderValue(
  headers: Record<string, string | undefined>,
  headerName: string,
): string | undefined {
  return headers[headerName.trim().toLowerCase()];
}

function toHeaderMap(headers: IncomingHttpHeaders): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === "string") {
      out[key.toLowerCase()] = value;
      continue;
    }
    if (Array.isArray(value)) {
      out[key.toLowerCase()] = value.join(",");
    }
  }
  return out;
}

function safeEqualText(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return timingSafeEqual(leftBuffer, rightBuffer);
}

function parseUnixTimestampMs(raw: string): number | null {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return null;
  if (parsed <= 0) return null;
  if (parsed > 1_000_000_000_000) {
    return Math.floor(parsed);
  }
  return Math.floor(parsed * 1000);
}

function normalizeHexDigest(raw: string): string | null {
  const trimmed = raw.trim().toLowerCase();
  const withoutPrefix = trimmed
    .replace(/^v1=/u, "")
    .replace(/^sha256=/u, "")
    .trim();
  if (!/^[a-f0-9]{64}$/u.test(withoutPrefix)) {
    return null;
  }
  return withoutPrefix;
}

function resolveIngressDedupeKey(update: TelegramUpdate): string | null {
  const projectionKey = buildTelegramInboundDedupeKey(update);
  if (projectionKey) {
    return projectionKey;
  }
  if (Number.isInteger(update.update_id)) {
    return `telegram:update:${update.update_id}`;
  }
  return null;
}

function parseTelegramUpdate(rawBody: string): TelegramUpdate | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return null;
  }
  const row = asRecord(parsed);
  if (!row) return null;
  if (typeof row.update_id !== "number" || !Number.isInteger(row.update_id)) {
    return null;
  }
  return row as unknown as TelegramUpdate;
}

export class TelegramIngressProcessor {
  private readonly now: () => number;
  private readonly dedupeTtlMs: number;
  private readonly dedupeStore: ReplayStore;
  private readonly nonceStore: ReplayStore;

  constructor(private readonly options: TelegramIngressProcessorOptions) {
    this.now = options.now ?? (() => Date.now());
    this.dedupeTtlMs = Math.max(1_000, Math.floor(options.dedupeTtlMs ?? DEFAULT_DEDUPE_TTL_MS));
    this.dedupeStore = options.dedupeStore ?? new InMemoryReplayStore();
    this.nonceStore = options.nonceStore ?? new InMemoryReplayStore();
  }

  async handle(input: TelegramIngressRequest): Promise<TelegramIngressResult> {
    if (input.method.trim().toUpperCase() !== "POST") {
      return {
        status: 405,
        body: {
          ok: false,
          code: "method_not_allowed",
          message: "POST is required",
        },
      };
    }

    const authStatus = this.verifyAuth(input.headers, input.body);
    if (authStatus !== null) {
      return {
        status: 401,
        body: {
          ok: false,
          code: "unauthorized",
          message: authStatus,
        },
      };
    }

    const update = parseTelegramUpdate(input.body);
    if (!update) {
      return {
        status: 400,
        body: {
          ok: false,
          code: "bad_request",
          message: "invalid telegram update payload",
        },
      };
    }

    const dedupeKey = resolveIngressDedupeKey(update);
    if (dedupeKey && !this.dedupeStore.putIfAbsent(dedupeKey, this.dedupeTtlMs, this.now())) {
      return {
        status: 409,
        body: {
          ok: false,
          code: "duplicate",
          dedupeKey,
        },
      };
    }

    try {
      await this.options.onUpdate(update, { dedupeKey });
      return {
        status: 202,
        body: {
          ok: true,
          code: "accepted",
          dedupeKey,
        },
      };
    } catch {
      if (dedupeKey) {
        this.dedupeStore.delete(dedupeKey);
      }
      return {
        status: 500,
        body: {
          ok: false,
          code: "internal_error",
          message: "failed to dispatch update",
        },
      };
    }
  }

  private verifyAuth(headers: Record<string, string | undefined>, body: string): string | null {
    if (this.options.auth.mode === "bearer") {
      return this.verifyBearer(headers, this.options.auth.bearer);
    }
    if (this.options.auth.mode === "hmac") {
      return this.verifyHmac(headers, body, this.options.auth.hmac);
    }

    const bearerError = this.verifyBearer(headers, this.options.auth.bearer);
    if (bearerError) {
      return bearerError;
    }
    return this.verifyHmac(headers, body, this.options.auth.hmac);
  }

  private verifyBearer(
    headers: Record<string, string | undefined>,
    config: BearerAuthConfig,
  ): string | null {
    const expectedToken = config.token.trim();
    if (!expectedToken) {
      return "empty bearer token config";
    }
    const headerName = (config.header ?? DEFAULT_BEARER_HEADER).trim().toLowerCase();
    const rawValue = toHeaderValue(headers, headerName)?.trim() ?? "";
    if (!rawValue) {
      return `missing ${headerName} header`;
    }

    let providedToken = rawValue;
    if (headerName === "authorization") {
      if (!/^bearer\s+/iu.test(rawValue)) {
        return "authorization header must use Bearer token";
      }
      providedToken = rawValue.replace(/^bearer\s+/iu, "").trim();
    }

    if (!safeEqualText(providedToken, expectedToken)) {
      return "invalid bearer token";
    }
    return null;
  }

  private verifyHmac(
    headers: Record<string, string | undefined>,
    body: string,
    config: HmacAuthConfig,
  ): string | null {
    const secret = config.secret.trim();
    if (!secret) {
      return "empty hmac secret config";
    }
    const signatureHeaderName = (config.signatureHeader ?? DEFAULT_HMAC_SIGNATURE_HEADER)
      .trim()
      .toLowerCase();
    const timestampHeaderName = (config.timestampHeader ?? DEFAULT_HMAC_TIMESTAMP_HEADER)
      .trim()
      .toLowerCase();
    const nonceHeaderName = (config.nonceHeader ?? DEFAULT_HMAC_NONCE_HEADER).trim().toLowerCase();

    const signatureRaw = toHeaderValue(headers, signatureHeaderName);
    const timestampRaw = toHeaderValue(headers, timestampHeaderName);
    const nonceRaw = toHeaderValue(headers, nonceHeaderName);
    if (!signatureRaw || !timestampRaw || !nonceRaw) {
      return "missing hmac headers";
    }

    const signature = normalizeHexDigest(signatureRaw);
    if (!signature) {
      return "invalid signature format";
    }
    const timestampMs = parseUnixTimestampMs(timestampRaw);
    if (timestampMs === null) {
      return "invalid timestamp";
    }

    const maxSkewMs = Math.max(1_000, Math.floor(config.maxSkewMs ?? DEFAULT_HMAC_MAX_SKEW_MS));
    if (Math.abs(this.now() - timestampMs) > maxSkewMs) {
      return "timestamp outside allowed skew";
    }

    const nonce = nonceRaw.trim();
    if (!nonce) {
      return "empty nonce";
    }

    const expectedSignature = createIngressHmacSignature({
      secret,
      timestamp: timestampRaw,
      nonce,
      body,
    })
      .replace(/^v1=/u, "")
      .trim();
    if (!safeEqualText(signature, expectedSignature)) {
      return "invalid signature";
    }

    // nonceStore defaults to InMemoryReplayStore, which is per-process.
    // In a multi-instance deployment each instance tracks nonces independently,
    // so the same nonce can be accepted once per instance. The timestamp skew
    // window (maxSkewMs) remains the primary replay boundary. To enforce
    // cross-instance nonce uniqueness, inject a shared ReplayStore via
    // TelegramIngressProcessorOptions.nonceStore.
    const nonceTtlMs = Math.max(1_000, Math.floor(config.nonceTtlMs ?? maxSkewMs));
    const nonceKey = `hmac:${nonce}`;
    if (!this.nonceStore.putIfAbsent(nonceKey, nonceTtlMs, this.now())) {
      return "replayed nonce";
    }
    return null;
  }
}

class PayloadTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PayloadTooLargeError";
  }
}

export interface CreateTelegramIngressServerOptions extends TelegramIngressProcessorOptions {
  path?: string;
  maxBodyBytes?: number;
  onError?: (error: unknown) => Promise<void> | void;
}

function writeJson(
  response: ServerResponse,
  status: number,
  body: TelegramIngressResponseBody,
): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(body));
}

function readRequestBody(request: IncomingMessage, maxBodyBytes: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;

    const rejectOnce = (error: unknown) => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    const resolveOnce = (value: string) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    request.on("error", (error) => {
      rejectOnce(error);
    });
    request.on("data", (chunk) => {
      const asBuffer = typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk);
      total += asBuffer.length;
      if (total > maxBodyBytes) {
        rejectOnce(new PayloadTooLargeError(`request body exceeds ${maxBodyBytes} bytes`));
        request.destroy();
        return;
      }
      chunks.push(asBuffer);
    });
    request.on("end", () => {
      resolveOnce(Buffer.concat(chunks).toString("utf8"));
    });
  });
}

export function createTelegramIngressServer(options: CreateTelegramIngressServerOptions): Server {
  const ingressPath = (options.path ?? DEFAULT_INGRESS_PATH).trim() || DEFAULT_INGRESS_PATH;
  const maxBodyBytes = Math.max(1_024, Math.floor(options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES));
  const processor = new TelegramIngressProcessor(options);

  return createServer(async (request, response) => {
    const requestPath = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (requestPath !== ingressPath) {
      writeJson(response, 404, {
        ok: false,
        code: "not_found",
        message: "route not found",
      });
      return;
    }

    let rawBody = "";
    try {
      rawBody = await readRequestBody(request, maxBodyBytes);
      const result = await processor.handle({
        method: request.method ?? "GET",
        headers: toHeaderMap(request.headers),
        body: rawBody,
      });
      writeJson(response, result.status, result.body);
    } catch (error) {
      if (error instanceof PayloadTooLargeError) {
        // Body-too-large is an expected client error, not a server fault.
        // Do not forward it to onError to avoid false-positive alerts.
        writeJson(response, 413, {
          ok: false,
          code: "payload_too_large",
          message: error.message,
        });
        return;
      }
      await options.onError?.(error);
      writeJson(response, 500, {
        ok: false,
        code: "internal_error",
        message: "ingress handler failed",
      });
    }
  });
}
