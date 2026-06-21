import type * as NodeOs from "node:os";
import { fromAbortableBoundaryPromise, retryWithBrewvaPolicy } from "@brewva/brewva-effect";
import { BrewvaEffect } from "@brewva/brewva-effect/primitives";
import { supportsXhigh } from "../../catalog/index.js";
import type {
  Context,
  Model,
  SimpleStreamOptions,
  StreamFunction,
  Transport,
} from "../../contracts/index.js";
import {
  failProviderStream,
  providerTryPromise,
  toProviderStreamError,
} from "../../stream/effect-interop.js";
import { runProviderStream } from "../../stream/run-provider-stream.js";
import { buildProviderPayloadMetadata } from "../_shared/payload-metadata.js";
import { buildBaseOptions, clampReasoning } from "../_shared/simple-options.js";
import type { OpenAICodexResponsesOptions, RequestBody } from "./contract.js";
import { buildRequestBody, resolveCodexUrl, resolveCodexWebSocketUrl } from "./request.js";
import { processStream } from "./sse.js";
import {
  isCodexWebSocketFallbackActive,
  processWebSocketStream,
  recordCodexWebSocketFallback,
} from "./websocket.js";

let _os: typeof NodeOs | null = null;

type DynamicImport = (specifier: string) => Promise<unknown>;
const dynamicImport: DynamicImport = (specifier) => import(specifier);
const NODE_OS_SPECIFIER = "node:" + "os";

if (typeof process !== "undefined" && (process.versions?.node || process.versions?.bun)) {
  dynamicImport(NODE_OS_SPECIFIER).then((m) => {
    _os = m as typeof NodeOs;
  });
}

const DEFAULT_MAX_RETRIES = 0;
const BASE_DELAY_MS = 1000;
const DEFAULT_SSE_HEADER_TIMEOUT_MS = 10_000;

class CodexRetryableRequestError extends Error {
  constructor(
    readonly original: Error,
    readonly retryAfterMs?: number,
  ) {
    super(original.message);
    this.name = "CodexRetryableRequestError";
  }
}

class CodexNonRetryableRequestError extends Error {
  constructor(readonly original: Error) {
    super(original.message);
    this.name = "CodexNonRetryableRequestError";
  }
}

export function resolveCodexTransport(
  options?: Pick<OpenAICodexResponsesOptions, "transport">,
): Transport {
  return options?.transport ?? "auto";
}

export function shouldAttemptCodexWebSocketTransport(
  transport: Transport,
  sessionId?: string,
): boolean {
  if (transport === "sse") {
    return false;
  }
  if (transport === "auto" && isCodexWebSocketFallbackActive(sessionId)) {
    return false;
  }
  return true;
}

function isRetryableError(status: number, errorText: string): boolean {
  if (isTerminalRateLimitError(status, errorText)) {
    return false;
  }
  if (status === 429 || status === 500 || status === 502 || status === 503 || status === 504) {
    return true;
  }
  return /rate.?limit|overloaded|service.?unavailable|upstream.?connect|connection.?refused/i.test(
    errorText,
  );
}

function isTerminalRateLimitError(status: number, errorText: string): boolean {
  if (status !== 429) {
    return false;
  }
  return /usage_limit_reached|usage_not_included|insufficient_quota|billing|quota|credits?|plan_type/i.test(
    errorText,
  );
}

function normalizeNonNegativeInteger(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(0, Math.trunc(value));
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(1, Math.trunc(value));
}

function normalizeOptionalTimeoutMs(
  value: number | undefined,
  fallback: number,
): number | undefined {
  const normalized = normalizeNonNegativeInteger(value, fallback);
  return normalized > 0 ? normalized : undefined;
}

function capRetryDelayMs(delayMs: number, maxRetryDelayMs: number | undefined): number {
  const normalizedDelay = normalizePositiveInteger(delayMs, BASE_DELAY_MS);
  if (maxRetryDelayMs === undefined) {
    return normalizedDelay;
  }
  return Math.min(normalizedDelay, normalizePositiveInteger(maxRetryDelayMs, normalizedDelay));
}

function defaultRetryDelayForAttempt(attempt: number): number {
  return BASE_DELAY_MS * 2 ** Math.max(0, attempt);
}

function readRetryAfterMs(headers: Headers): number | undefined {
  const value = headers.get("retry-after");
  if (!value) {
    return undefined;
  }
  const seconds = Number(value);
  if (Number.isFinite(seconds)) {
    return Math.max(0, Math.trunc(seconds * 1000));
  }
  const retryAt = Date.parse(value);
  if (!Number.isNaN(retryAt)) {
    return Math.max(0, retryAt - Date.now());
  }
  return undefined;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" ||
      error.name === "BrewvaCancelled" ||
      /aborted|cancelled|canceled/i.test(error.message))
  );
}

function unwrapCodexRequestError(error: unknown): Error {
  if (
    error instanceof CodexRetryableRequestError ||
    error instanceof CodexNonRetryableRequestError
  ) {
    return error.original;
  }
  return toError(error);
}

async function parseErrorResponse(
  response: Response,
): Promise<{ message: string; friendlyMessage?: string }> {
  const raw = await response.text();
  let message = raw || response.statusText || "Request failed";
  let friendlyMessage: string | undefined;

  try {
    const parsed = JSON.parse(raw) as {
      error?: {
        code?: string;
        type?: string;
        message?: string;
        plan_type?: string;
        resets_at?: number;
      };
    };
    const err = parsed?.error;
    if (err) {
      const code = err.code || err.type || "";
      const errMessage = err.message || "";
      const usageLimited =
        /usage_limit_reached|usage_not_included|insufficient_quota|billing|quota|credits?/i.test(
          code,
        ) || /usage limit|billing|quota|credits?/i.test(errMessage);
      if (usageLimited) {
        const plan = err.plan_type ? ` (${err.plan_type.toLowerCase()} plan)` : "";
        const mins = err.resets_at
          ? Math.max(0, Math.round((err.resets_at * 1000 - Date.now()) / 60000))
          : undefined;
        const when = mins !== undefined ? ` Try again in ~${mins} min.` : "";
        friendlyMessage = `You have hit your ChatGPT usage limit${plan}.${when}`.trim();
      }
      message = err.message || friendlyMessage || message;
    }
  } catch {}

  return { message, friendlyMessage };
}

async function runWithTimeoutSignal<A>(
  signal: AbortSignal,
  timeoutMs: number | undefined,
  timeoutMessage: string,
  run: (signal: AbortSignal) => PromiseLike<A>,
): Promise<A> {
  if (timeoutMs === undefined) {
    return await run(signal);
  }

  const controller = new AbortController();
  let timedOut = false;
  const abortFromParent = () => controller.abort(signal.reason);
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new DOMException(timeoutMessage, "TimeoutError"));
  }, timeoutMs);
  timer.unref?.();

  if (signal.aborted) {
    abortFromParent();
  } else {
    signal.addEventListener("abort", abortFromParent, { once: true });
  }

  try {
    return await run(controller.signal);
  } catch (error) {
    if (timedOut) {
      throw new Error(timeoutMessage);
    }
    throw error;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abortFromParent);
  }
}

function extractAccountId(token: string): string {
  try {
    const parts = token.split(".");
    const payloadPart = parts[1];
    if (parts.length !== 3 || !payloadPart) throw new Error("Invalid token");
    const payload = JSON.parse(atob(payloadPart));
    const accountId = payload?.["https://api.openai.com/auth"]?.chatgpt_account_id;
    if (!accountId) throw new Error("No account ID in token");
    return accountId;
  } catch {
    throw new Error("Failed to extract accountId from token");
  }
}

function createCodexRequestId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return `codex_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function buildBaseCodexHeaders(
  initHeaders: Record<string, string> | undefined,
  additionalHeaders: Record<string, string> | undefined,
  accountId: string,
  token: string,
): Headers {
  const headers = new Headers(initHeaders);
  for (const [key, value] of Object.entries(additionalHeaders || {})) {
    headers.set(key, value);
  }
  headers.set("Authorization", `Bearer ${token}`);
  headers.set("chatgpt-account-id", accountId);
  headers.set("originator", "brewva");
  const userAgent = _os
    ? `brewva (${_os.platform()} ${_os.release()}; ${_os.arch()})`
    : "brewva (browser)";
  headers.set("User-Agent", userAgent);
  return headers;
}

function buildSSEHeaders(
  initHeaders: Record<string, string> | undefined,
  additionalHeaders: Record<string, string> | undefined,
  accountId: string,
  token: string,
  sessionId?: string,
): Headers {
  const headers = buildBaseCodexHeaders(initHeaders, additionalHeaders, accountId, token);
  headers.set("OpenAI-Beta", "responses=experimental");
  headers.set("accept", "text/event-stream");
  headers.set("content-type", "application/json");
  if (sessionId) {
    headers.set("session-id", sessionId);
  }
  return headers;
}

function buildWebSocketHeaders(
  initHeaders: Record<string, string> | undefined,
  additionalHeaders: Record<string, string> | undefined,
  accountId: string,
  token: string,
  requestId: string,
): Headers {
  const headers = buildBaseCodexHeaders(initHeaders, additionalHeaders, accountId, token);
  headers.delete("accept");
  headers.delete("content-type");
  // No OpenAI-Beta on the WS handshake: it is an SSE/HTTP-POST-only header. The value
  // previously set here never reached the socket — connectWebSocket strips any beta
  // header before the upgrade, which remains the single defensive guarantee.
  headers.set("x-client-request-id", requestId);
  headers.set("session-id", requestId);
  return headers;
}

function fetchCodexSseResponseEffect(input: {
  url: string;
  headers: Headers;
  bodyJson: string;
  signal: AbortSignal;
  timeoutMs?: number;
  maxRetries?: number;
  maxRetryDelayMs?: number;
}): BrewvaEffect.Effect<Response, Error> {
  const timeoutMs = normalizeOptionalTimeoutMs(input.timeoutMs, DEFAULT_SSE_HEADER_TIMEOUT_MS);
  const maxRetries = normalizeNonNegativeInteger(input.maxRetries, DEFAULT_MAX_RETRIES);
  const attempt = BrewvaEffect.gen(function* () {
    if (input.signal.aborted) {
      return yield* BrewvaEffect.fail(
        new CodexNonRetryableRequestError(new Error("Request was aborted")),
      );
    }

    const response = yield* fromAbortableBoundaryPromise(
      (abortSignal) =>
        runWithTimeoutSignal(
          abortSignal,
          timeoutMs,
          `Codex SSE response headers timed out after ${timeoutMs} ms`,
          (requestSignal) =>
            fetch(input.url, {
              method: "POST",
              headers: input.headers,
              body: input.bodyJson,
              signal: requestSignal,
            }),
        ),
      input.signal,
    ).pipe(BrewvaEffect.mapError(toError));

    if (response.ok) {
      return response;
    }

    const errorText = yield* fromAbortableBoundaryPromise(() => response.text(), input.signal).pipe(
      BrewvaEffect.mapError(toError),
    );
    const retryAfterMs = readRetryAfterMs(response.headers);
    const info = yield* fromAbortableBoundaryPromise(
      () =>
        parseErrorResponse(
          new Response(errorText, {
            status: response.status,
            statusText: response.statusText,
          }),
        ),
      input.signal,
    ).pipe(BrewvaEffect.mapError(toError));
    const requestError = new Error(info.friendlyMessage || info.message);

    if (isRetryableError(response.status, errorText)) {
      return yield* BrewvaEffect.fail(new CodexRetryableRequestError(requestError, retryAfterMs));
    }
    return yield* BrewvaEffect.fail(new CodexNonRetryableRequestError(requestError));
  }).pipe(
    BrewvaEffect.catch((error) => {
      if (
        error instanceof CodexRetryableRequestError ||
        error instanceof CodexNonRetryableRequestError
      ) {
        return BrewvaEffect.fail(error);
      }
      const normalized = toError(error);
      if (isAbortError(normalized) || normalized.message.includes("usage limit")) {
        return BrewvaEffect.fail(new CodexNonRetryableRequestError(normalized));
      }
      return BrewvaEffect.fail(new CodexRetryableRequestError(normalized));
    }),
  );

  return retryWithBrewvaPolicy(attempt, {
    maxRetries,
    baseDelayMs: BASE_DELAY_MS,
    delayFor: (error, attempt) => {
      const retryAfterMs =
        error instanceof CodexRetryableRequestError ? error.retryAfterMs : undefined;
      return capRetryDelayMs(
        retryAfterMs ?? defaultRetryDelayForAttempt(attempt),
        input.maxRetryDelayMs,
      );
    },
    while: (error) => error instanceof CodexRetryableRequestError,
  }).pipe(BrewvaEffect.mapError(unwrapCodexRequestError));
}

export const streamOpenAICodexResponses: StreamFunction<
  "openai-codex-responses",
  OpenAICodexResponsesOptions
> = (
  model: Model<"openai-codex-responses">,
  context: Context,
  options?: OpenAICodexResponsesOptions,
) => {
  return runProviderStream(
    model,
    ({ stream, output, ensureStarted, composer, signal }) =>
      BrewvaEffect.gen(function* () {
        const apiKey = options?.apiKey || "";
        if (!apiKey) {
          return yield* failProviderStream(`No API key for provider: ${model.provider}`);
        }

        const accountId = yield* providerTryPromise(async () => extractAccountId(apiKey));
        let body = buildRequestBody(model, context, options);
        const nextBody = yield* providerTryPromise(async () =>
          options?.onPayload?.(body, model, buildProviderPayloadMetadata(model, options, body)),
        );
        if (nextBody !== undefined) {
          body = nextBody as RequestBody;
        }
        const websocketRequestId = options?.sessionId || createCodexRequestId();
        const sseHeaders = buildSSEHeaders(
          model.headers,
          options?.headers,
          accountId,
          apiKey,
          options?.sessionId,
        );
        const websocketHeaders = buildWebSocketHeaders(
          model.headers,
          options?.headers,
          accountId,
          apiKey,
          websocketRequestId,
        );
        const transport = resolveCodexTransport(options);
        const linkedOptions: OpenAICodexResponsesOptions = { ...options, signal };

        if (shouldAttemptCodexWebSocketTransport(transport, options?.sessionId)) {
          let websocketStarted = false;
          const websocketResult = yield* processWebSocketStream(
            resolveCodexWebSocketUrl(model.baseUrl),
            body,
            websocketHeaders,
            output,
            stream,
            model,
            composer.toolCalls,
            () => {
              websocketStarted = true;
            },
            linkedOptions,
          ).pipe(
            BrewvaEffect.map(() => ({ ok: true as const })),
            BrewvaEffect.catch((error) => BrewvaEffect.succeed({ ok: false as const, error })),
          );

          if (websocketResult.ok) {
            if (signal.aborted) {
              return yield* failProviderStream("Request was aborted");
            }
            return;
          }

          if (transport === "websocket" || websocketStarted) {
            return yield* BrewvaEffect.fail(websocketResult.error);
          }
          recordCodexWebSocketFallback(options?.sessionId);
        }

        const response = yield* fetchCodexSseResponseEffect({
          url: resolveCodexUrl(model.baseUrl),
          headers: sseHeaders,
          bodyJson: JSON.stringify(body),
          signal,
          timeoutMs: options?.timeoutMs,
          maxRetries: options?.maxRetries,
          maxRetryDelayMs: options?.maxRetryDelayMs,
        }).pipe(BrewvaEffect.mapError(toProviderStreamError));

        if (!response.body) {
          return yield* failProviderStream("No response body");
        }

        yield* ensureStarted();
        yield* processStream(response, output, stream, model, composer.toolCalls);
      }),
    {
      signal: options?.signal,
      sessionId: options?.sessionId,
      tools: context.tools,
    },
  );
};

export const streamSimpleOpenAICodexResponses: StreamFunction<
  "openai-codex-responses",
  SimpleStreamOptions
> = (model: Model<"openai-codex-responses">, context: Context, options?: SimpleStreamOptions) => {
  const apiKey = options?.apiKey;
  if (!apiKey) {
    throw new Error(`No API key for provider: ${model.provider}`);
  }

  const base = buildBaseOptions(model, options, apiKey);
  const reasoningEffort = supportsXhigh(model)
    ? options?.reasoning
    : clampReasoning(options?.reasoning);

  return streamOpenAICodexResponses(model, context, {
    ...base,
    reasoningEffort,
  } satisfies OpenAICodexResponsesOptions);
};
