import type * as NodeOs from "node:os";
import {
  fromAbortableBoundaryPromise,
  retryWithBrewvaPolicy,
  runBoundaryOperation,
} from "@brewva/brewva-effect";
import { BrewvaEffect } from "@brewva/brewva-effect/primitives";
import { supportsXhigh } from "../../catalog/index.js";
import type {
  Context,
  Model,
  SimpleStreamOptions,
  StreamFunction,
  Transport,
} from "../../contracts/index.js";
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

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;
const OPENAI_BETA_RESPONSES_WEBSOCKETS = "responses_websockets=2026-02-06";

class CodexRetryableRequestError extends Error {
  constructor(readonly original: Error) {
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
  if (status === 429 || status === 500 || status === 502 || status === 503 || status === 504) {
    return true;
  }
  return /rate.?limit|overloaded|service.?unavailable|upstream.?connect|connection.?refused/i.test(
    errorText,
  );
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" || error.message === "Request was aborted")
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
      if (
        /usage_limit_reached|usage_not_included|rate_limit_exceeded/i.test(code) ||
        response.status === 429
      ) {
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
    headers.set("session_id", sessionId);
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
  headers.delete("OpenAI-Beta");
  headers.delete("openai-beta");
  headers.set("OpenAI-Beta", OPENAI_BETA_RESPONSES_WEBSOCKETS);
  headers.set("x-client-request-id", requestId);
  headers.set("session_id", requestId);
  return headers;
}

function fetchCodexSseResponseEffect(input: {
  url: string;
  headers: Headers;
  bodyJson: string;
  signal: AbortSignal;
}): BrewvaEffect.Effect<Response, Error> {
  const attempt = BrewvaEffect.gen(function* () {
    if (input.signal.aborted) {
      return yield* BrewvaEffect.fail(
        new CodexNonRetryableRequestError(new Error("Request was aborted")),
      );
    }

    const response = yield* fromAbortableBoundaryPromise(
      (abortSignal) =>
        fetch(input.url, {
          method: "POST",
          headers: input.headers,
          body: input.bodyJson,
          signal: abortSignal,
        }),
      input.signal,
    ).pipe(BrewvaEffect.mapError(toError));

    if (response.ok) {
      return response;
    }

    const errorText = yield* fromAbortableBoundaryPromise(() => response.text(), input.signal).pipe(
      BrewvaEffect.mapError(toError),
    );
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
      return yield* BrewvaEffect.fail(new CodexRetryableRequestError(requestError));
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
    maxRetries: MAX_RETRIES,
    baseDelayMs: BASE_DELAY_MS,
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
    async ({ stream, output, ensureStarted, composer, signal }) => {
      const apiKey = options?.apiKey || "";
      if (!apiKey) {
        throw new Error(`No API key for provider: ${model.provider}`);
      }

      const accountId = extractAccountId(apiKey);
      let body = buildRequestBody(model, context, options);
      const nextBody = await options?.onPayload?.(
        body,
        model,
        buildProviderPayloadMetadata(model, options, body),
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
        try {
          await processWebSocketStream(
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
          );

          if (signal.aborted) {
            throw new Error("Request was aborted");
          }
          return;
        } catch (error) {
          if (transport === "websocket" || websocketStarted) {
            throw error;
          }
          recordCodexWebSocketFallback(options?.sessionId);
        }
      }

      const response = await runBoundaryOperation(
        "provider.openaiCodexResponses.fetchSse",
        fetchCodexSseResponseEffect({
          url: resolveCodexUrl(model.baseUrl),
          headers: sseHeaders,
          bodyJson: JSON.stringify(body),
          signal,
        }),
        { signal },
      );

      if (!response.body) {
        throw new Error("No response body");
      }

      await ensureStarted();
      await processStream(response, output, stream, model, composer.toolCalls);
    },
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
