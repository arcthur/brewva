import type { TelegramChannelTransport, TelegramChannelTransportSendResult } from "./adapter.js";
import type { TelegramOutboundRequest, TelegramUpdate } from "./types.js";

const TELEGRAM_API_BASE_URL_DEFAULT = "https://api.telegram.org";
const TELEGRAM_POLL_TIMEOUT_SECONDS_DEFAULT = 20;
const TELEGRAM_POLL_LIMIT_DEFAULT = 100;
const TELEGRAM_POLL_RETRY_DELAY_MS_DEFAULT = 1_000;
const TELEGRAM_POLL_LIMIT_MIN = 1;
const TELEGRAM_POLL_LIMIT_MAX = 100;
const TELEGRAM_POLL_TIMEOUT_MIN = 0;
const TELEGRAM_POLL_TIMEOUT_MAX = 600;
const TELEGRAM_SEND_MAX_ATTEMPTS = 3;
const TELEGRAM_SEND_RETRY_DELAY_MS_DEFAULT = 1_000;
const TELEGRAM_SEND_RETRY_DELAY_MS_MAX = 10_000;

interface TelegramApiOkResponse<T> {
  ok: true;
  result: T;
}

interface TelegramApiErrorResponse {
  ok: false;
  error_code?: number;
  description?: string;
  parameters?: Record<string, unknown>;
}

type TelegramApiResponse<T> = TelegramApiOkResponse<T> | TelegramApiErrorResponse;

export type TelegramFetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

type SleepLike = (delayMs: number) => Promise<void>;

export interface TelegramLongPollingOptions {
  timeoutSeconds?: number;
  limit?: number;
  allowedUpdates?: string[];
  retryDelayMs?: number;
}

export interface TelegramHttpTransportOptions {
  token: string;
  apiBaseUrl?: string;
  fetchImpl?: TelegramFetchLike;
  sleepImpl?: SleepLike;
  poll?: TelegramLongPollingOptions;
  initialOffset?: number;
  onError?: (error: unknown) => Promise<void> | void;
}

interface TelegramSendResultPayload {
  message_id?: string | number;
}

class TelegramTransportError extends Error {
  constructor(
    readonly method: string,
    readonly category: "network" | "http" | "api" | "response",
    message: string,
    readonly options: {
      retryable?: boolean;
      retryAfterMs?: number;
      status?: number;
      errorCode?: number;
    } = {},
  ) {
    super(message);
    this.name = "TelegramTransportError";
  }

  get retryable(): boolean {
    return this.options.retryable === true;
  }

  get retryAfterMs(): number | undefined {
    return this.options.retryAfterMs;
  }
}

function normalizeToken(token: string): string {
  const normalized = token.trim();
  if (!normalized) {
    throw new Error("telegram token is required");
  }
  return normalized;
}

function normalizeApiBaseUrl(value: string | undefined): string {
  const normalized = (value ?? TELEGRAM_API_BASE_URL_DEFAULT).trim();
  if (!normalized) {
    throw new Error("telegram apiBaseUrl is required");
  }
  return normalized.replace(/\/+$/g, "");
}

function normalizePollTimeoutSeconds(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return TELEGRAM_POLL_TIMEOUT_SECONDS_DEFAULT;
  }
  return Math.max(
    TELEGRAM_POLL_TIMEOUT_MIN,
    Math.min(TELEGRAM_POLL_TIMEOUT_MAX, Math.floor(value)),
  );
}

function normalizePollLimit(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return TELEGRAM_POLL_LIMIT_DEFAULT;
  }
  return Math.max(TELEGRAM_POLL_LIMIT_MIN, Math.min(TELEGRAM_POLL_LIMIT_MAX, Math.floor(value)));
}

function normalizeRetryDelayMs(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return TELEGRAM_POLL_RETRY_DELAY_MS_DEFAULT;
  }
  return Math.max(0, Math.floor(value));
}

function normalizeInitialOffset(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.floor(value));
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeRetryAfterMs(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return Math.max(0, Math.floor(value * 1_000));
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  const numeric = Number(trimmed);
  if (Number.isFinite(numeric) && numeric >= 0) {
    return Math.max(0, Math.floor(numeric * 1_000));
  }
  const parsedDateMs = Date.parse(trimmed);
  if (!Number.isFinite(parsedDateMs)) {
    return undefined;
  }
  return Math.max(0, parsedDateMs - Date.now());
}

function resolveSendRetryDelayMs(error: TelegramTransportError, attempt: number): number {
  if (error.retryAfterMs !== undefined) {
    return error.retryAfterMs;
  }
  const exponentialDelay = TELEGRAM_SEND_RETRY_DELAY_MS_DEFAULT * 2 ** attempt;
  return Math.min(TELEGRAM_SEND_RETRY_DELAY_MS_MAX, exponentialDelay);
}

function extractApiErrorDetails(body: string): {
  description?: string;
  errorCode?: number;
  retryAfterMs?: number;
} {
  if (!body.trim()) {
    return {};
  }
  try {
    const parsed = JSON.parse(body) as unknown;
    if (!isRecord(parsed)) {
      return {};
    }
    const description =
      typeof parsed.description === "string" && parsed.description.trim()
        ? parsed.description.trim()
        : undefined;
    const errorCode =
      typeof parsed.error_code === "number" && Number.isFinite(parsed.error_code)
        ? parsed.error_code
        : undefined;
    const retryAfterMs = isRecord(parsed.parameters)
      ? normalizeRetryAfterMs(parsed.parameters.retry_after)
      : undefined;
    return {
      ...(description ? { description } : {}),
      ...(errorCode !== undefined ? { errorCode } : {}),
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    };
  } catch {
    return {};
  }
}

function buildApiError(
  method: string,
  message: string,
  options: {
    retryable?: boolean;
    retryAfterMs?: number;
    errorCode?: number;
  } = {},
): TelegramTransportError {
  return new TelegramTransportError(method, "api", `telegram api ${method} failed: ${message}`, {
    retryable: options.retryable,
    retryAfterMs: options.retryAfterMs,
    errorCode: options.errorCode,
  });
}

function buildHttpError(
  method: string,
  status: number,
  text: string,
  options: {
    retryable?: boolean;
    retryAfterMs?: number;
    errorCode?: number;
  } = {},
): TelegramTransportError {
  const summary = text.trim();
  return new TelegramTransportError(
    method,
    "http",
    `telegram http ${method} failed: status=${status}${summary ? ` body=${summary}` : ""}`,
    {
      status,
      retryable: options.retryable,
      retryAfterMs: options.retryAfterMs,
      errorCode: options.errorCode,
    },
  );
}

function buildNetworkError(method: string, cause: unknown): TelegramTransportError {
  const message = cause instanceof Error ? cause.message : String(cause);
  return new TelegramTransportError(
    method,
    "network",
    `telegram network ${method} failed: ${message}`,
  );
}

async function defaultSleep(delayMs: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

export class TelegramHttpTransport implements TelegramChannelTransport {
  private readonly token: string;
  private readonly apiBaseUrl: string;
  private readonly fetchImpl: TelegramFetchLike;
  private readonly sleepImpl: SleepLike;
  private readonly pollTimeoutSeconds: number;
  private readonly pollLimit: number;
  private readonly pollAllowedUpdates: string[] | undefined;
  private readonly retryDelayMs: number;
  private readonly onError: ((error: unknown) => Promise<void> | void) | undefined;

  private running = false;
  private onUpdate: ((update: TelegramUpdate) => Promise<void>) | null = null;
  private pollLoopTask: Promise<void> | null = null;
  private activePollAbortController: AbortController | null = null;
  private nextOffset: number;

  constructor(options: TelegramHttpTransportOptions) {
    this.token = normalizeToken(options.token);
    this.apiBaseUrl = normalizeApiBaseUrl(options.apiBaseUrl);
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.sleepImpl = options.sleepImpl ?? defaultSleep;
    this.pollTimeoutSeconds = normalizePollTimeoutSeconds(options.poll?.timeoutSeconds);
    this.pollLimit = normalizePollLimit(options.poll?.limit);
    this.pollAllowedUpdates =
      options.poll?.allowedUpdates?.map((value) => value.trim()).filter(Boolean) ?? undefined;
    this.retryDelayMs = normalizeRetryDelayMs(options.poll?.retryDelayMs);
    this.onError = options.onError;
    this.nextOffset = normalizeInitialOffset(options.initialOffset);
  }

  async start(params: { onUpdate: (update: TelegramUpdate) => Promise<void> }): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    this.onUpdate = params.onUpdate;
    this.pollLoopTask = this.runPollLoop();
  }

  async stop(): Promise<void> {
    if (!this.running) {
      return;
    }
    this.running = false;
    this.activePollAbortController?.abort();
    if (this.pollLoopTask) {
      await this.pollLoopTask;
    }
    this.pollLoopTask = null;
    this.onUpdate = null;
    this.activePollAbortController = null;
  }

  async send(request: TelegramOutboundRequest): Promise<TelegramChannelTransportSendResult> {
    const payload = await this.callSendApiWithRetries<TelegramSendResultPayload>(
      request.method,
      request.params,
    );
    const messageId = payload && typeof payload === "object" ? payload.message_id : undefined;
    if (messageId === undefined || messageId === null) {
      return {};
    }
    return { providerMessageId: messageId };
  }

  private async callSendApiWithRetries<T>(
    method: string,
    params: Record<string, unknown>,
  ): Promise<T> {
    for (let attempt = 0; attempt < TELEGRAM_SEND_MAX_ATTEMPTS; attempt += 1) {
      try {
        return await this.callApi<T>(method, params);
      } catch (error) {
        if (!(error instanceof TelegramTransportError) || !error.retryable) {
          throw error;
        }
        if (attempt + 1 >= TELEGRAM_SEND_MAX_ATTEMPTS) {
          throw error;
        }
        await this.sleepImpl(resolveSendRetryDelayMs(error, attempt));
      }
    }

    throw new Error(`telegram send ${method} exhausted retry loop`);
  }

  private async runPollLoop(): Promise<void> {
    while (this.running) {
      const abortController = new AbortController();
      this.activePollAbortController = abortController;
      try {
        const updates = await this.fetchUpdates(abortController.signal);
        await this.processUpdates(updates);
      } catch (error) {
        if (isAbortError(error)) {
          if (!this.running) {
            break;
          }
          continue;
        }
        await this.reportError(error);
        if (this.running && this.retryDelayMs > 0) {
          await this.sleepImpl(this.retryDelayMs);
        }
      } finally {
        if (this.activePollAbortController === abortController) {
          this.activePollAbortController = null;
        }
      }
    }
  }

  private async fetchUpdates(signal: AbortSignal): Promise<TelegramUpdate[]> {
    const request: Record<string, unknown> = {
      timeout: this.pollTimeoutSeconds,
      limit: this.pollLimit,
      ...(this.nextOffset > 0 ? { offset: this.nextOffset } : {}),
      ...(this.pollAllowedUpdates && this.pollAllowedUpdates.length > 0
        ? { allowed_updates: this.pollAllowedUpdates }
        : {}),
    };
    return this.callApi<TelegramUpdate[]>("getUpdates", request, signal);
  }

  private async processUpdates(updates: TelegramUpdate[]): Promise<void> {
    if (updates.length === 0) {
      return;
    }
    const handler = this.onUpdate;
    if (!handler) {
      return;
    }

    for (const update of updates) {
      const updateId = Number(update.update_id);
      await handler(update);
      if (Number.isInteger(updateId)) {
        this.nextOffset = Math.max(this.nextOffset, updateId + 1);
      }
    }
  }

  private async callApi<T>(
    method: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<T> {
    let response: Response;
    try {
      response = await this.fetchImpl(this.buildMethodUrl(method), {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify(params),
        signal,
      });
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }
      throw buildNetworkError(method, error);
    }

    if (!response.ok) {
      let body = "";
      try {
        body = await response.text();
      } catch {
        body = "";
      }
      const details = extractApiErrorDetails(body);
      throw buildHttpError(method, response.status, details.description ?? body, {
        retryable: response.status === 429 || response.status >= 500,
        retryAfterMs:
          normalizeRetryAfterMs(response.headers.get("retry-after")) ?? details.retryAfterMs,
        errorCode: details.errorCode,
      });
    }

    let parsed: TelegramApiResponse<T>;
    try {
      parsed = (await response.json()) as TelegramApiResponse<T>;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw buildApiError(method, `invalid json response (${message})`);
    }

    if (!parsed || typeof parsed !== "object" || !("ok" in parsed)) {
      throw new TelegramTransportError(
        method,
        "response",
        `telegram api ${method} failed: unexpected response shape`,
      );
    }

    if (!parsed.ok) {
      const errorCode =
        typeof parsed.error_code === "number" && Number.isFinite(parsed.error_code)
          ? parsed.error_code
          : null;
      const description =
        typeof parsed.description === "string" && parsed.description.trim()
          ? parsed.description.trim()
          : "unknown";
      const retryAfterMs = isRecord(parsed.parameters)
        ? normalizeRetryAfterMs(parsed.parameters.retry_after)
        : undefined;
      throw buildApiError(
        method,
        `${errorCode !== null ? `code=${errorCode} ` : ""}${description}`.trim(),
        {
          retryable: errorCode === 429,
          retryAfterMs,
          ...(errorCode !== null ? { errorCode } : {}),
        },
      );
    }

    return parsed.result;
  }

  private buildMethodUrl(method: string): string {
    return `${this.apiBaseUrl}/bot${this.token}/${method}`;
  }

  private async reportError(error: unknown): Promise<void> {
    if (!this.onError) {
      return;
    }
    try {
      await this.onError(error);
    } catch {
      // Ignore telemetry callback failures to keep polling alive.
    }
  }
}
