import { fromAbortableBoundaryPromise, retryWithBrewvaPolicy } from "@brewva/brewva-effect";
import { BrewvaEffect } from "@brewva/brewva-effect/primitives";
import { asPartialObject } from "@brewva/brewva-std/unknown";
import type { Context, Model, SimpleStreamOptions, StreamFunction } from "../../contracts/index.js";
import {
  failProviderStream,
  providerTryPromise,
  toProviderStreamError,
} from "../../stream/effect-interop.js";
import { runProviderStream } from "../../stream/run-provider-stream.js";
import { readSseFrames } from "../../stream/sse-frame-reader.js";
import { buildProviderPayloadMetadata } from "../_shared/payload-metadata.js";
import {
  GOOGLE_CLOUD_CODE_ASSIST_CREDENTIAL_HINT,
  parseGoogleGeminiCliCredential,
} from "./cached-content.js";
import {
  BASE_DELAY_MS,
  DEFAULT_ENDPOINT,
  EMPTY_STREAM_BASE_DELAY_MS,
  GEMINI_CLI_HEADERS,
  MAX_EMPTY_STREAM_RETRIES,
  MAX_RETRIES,
  extractErrorMessage,
  extractRetryDelay,
  getGeminiCliThinkingLevel,
  isRetryableError,
  resolveThinkingBudget,
} from "./compat.js";
import type { CloudCodeAssistResponseChunk, GoogleGeminiCliOptions } from "./contract.js";
import { buildRequest } from "./request.js";
import { processGoogleGeminiCliSseStream } from "./stream-events.js";

class GoogleGeminiCliRetryableRequestError extends Error {
  constructor(
    readonly original: Error,
    readonly retryDelayMs?: number,
  ) {
    super(original.message);
    this.name = "GoogleGeminiCliRetryableRequestError";
  }
}

class GoogleGeminiCliNonRetryableRequestError extends Error {
  constructor(readonly original: Error) {
    super(original.message);
    this.name = "GoogleGeminiCliNonRetryableRequestError";
  }
}

type GoogleGeminiCliRequestError =
  | GoogleGeminiCliRetryableRequestError
  | GoogleGeminiCliNonRetryableRequestError;

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function unwrapGoogleGeminiCliRequestError(error: unknown): Error {
  if (
    error instanceof GoogleGeminiCliRetryableRequestError ||
    error instanceof GoogleGeminiCliNonRetryableRequestError
  ) {
    return error.original;
  }
  return toError(error);
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" ||
      error.name === "BrewvaCancelled" ||
      error.message === "Request was aborted")
  );
}

async function* createChunkStream(
  response: Response,
): AsyncGenerator<CloudCodeAssistResponseChunk> {
  for await (const frame of readSseFrames(response, {
    ignoreParseErrors: false,
  })) {
    if (!frame.data || frame.data.trim() === "") continue;
    try {
      yield JSON.parse(frame.data) as CloudCodeAssistResponseChunk;
    } catch (error) {
      throw new Error(
        `Invalid Google SSE JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

function fetchGoogleGeminiCliResponseEffect(input: {
  readonly requestUrl: string;
  readonly headers: Record<string, string>;
  readonly requestBody: unknown;
  readonly signal: AbortSignal;
}): BrewvaEffect.Effect<Response, GoogleGeminiCliRequestError> {
  return BrewvaEffect.gen(function* () {
    if (input.signal.aborted) {
      return yield* BrewvaEffect.fail(
        new GoogleGeminiCliNonRetryableRequestError(new Error("Request was aborted")),
      );
    }

    const response = yield* fromAbortableBoundaryPromise(
      (abortSignal) =>
        fetch(input.requestUrl, {
          method: "POST",
          headers: input.headers,
          body: JSON.stringify(input.requestBody),
          signal: abortSignal,
        }),
      input.signal,
    ).pipe(BrewvaEffect.mapError(toError));

    if (response.ok) {
      return response;
    }

    const rawErrorText = yield* fromAbortableBoundaryPromise(
      () => response.text(),
      input.signal,
    ).pipe(BrewvaEffect.mapError(toError));
    const errorText = extractErrorMessage(rawErrorText);
    const requestError = new Error(errorText);
    if (isRetryableError(response.status, errorText)) {
      return yield* BrewvaEffect.fail(
        new GoogleGeminiCliRetryableRequestError(
          requestError,
          extractRetryDelay(errorText, response),
        ),
      );
    }

    return yield* BrewvaEffect.fail(new GoogleGeminiCliNonRetryableRequestError(requestError));
  }).pipe(
    BrewvaEffect.catch((error) => {
      if (
        error instanceof GoogleGeminiCliRetryableRequestError ||
        error instanceof GoogleGeminiCliNonRetryableRequestError
      ) {
        return BrewvaEffect.fail(error);
      }
      const normalized = toError(error);
      if (isAbortError(normalized)) {
        return BrewvaEffect.fail(new GoogleGeminiCliNonRetryableRequestError(normalized));
      }
      return BrewvaEffect.fail(new GoogleGeminiCliRetryableRequestError(normalized));
    }),
  );
}

function processGoogleGeminiCliStreamEffect(input: {
  readonly response: Response;
  readonly output: Parameters<typeof processGoogleGeminiCliSseStream>[1];
  readonly stream: Parameters<typeof processGoogleGeminiCliSseStream>[2];
  readonly model: Model<"google-gemini-cli">;
  readonly toolCalls: Parameters<typeof processGoogleGeminiCliSseStream>[4];
  readonly signal: AbortSignal;
  readonly emptyStreamRetries: {
    count: number;
  };
}): BrewvaEffect.Effect<void, GoogleGeminiCliRequestError> {
  return processGoogleGeminiCliSseStream(
    createChunkStream(input.response),
    input.output,
    input.stream,
    input.model,
    input.toolCalls,
  ).pipe(
    BrewvaEffect.mapError(toError),
    BrewvaEffect.catch((error) => {
      if (isAbortError(error)) {
        return BrewvaEffect.fail(new GoogleGeminiCliNonRetryableRequestError(error));
      }
      if (error.message !== "Empty SSE response") {
        return BrewvaEffect.fail(new GoogleGeminiCliNonRetryableRequestError(error));
      }
      if (input.emptyStreamRetries.count >= MAX_EMPTY_STREAM_RETRIES) {
        return BrewvaEffect.fail(new GoogleGeminiCliNonRetryableRequestError(error));
      }
      input.emptyStreamRetries.count += 1;
      return BrewvaEffect.fail(
        new GoogleGeminiCliRetryableRequestError(
          error,
          EMPTY_STREAM_BASE_DELAY_MS * input.emptyStreamRetries.count,
        ),
      );
    }),
  );
}

export const streamGoogleGeminiCli: StreamFunction<"google-gemini-cli", GoogleGeminiCliOptions> = (
  model: Model<"google-gemini-cli">,
  context: Context,
  options?: GoogleGeminiCliOptions,
) => {
  return runProviderStream(
    model,
    ({ stream, output, ensureStarted, composer, signal }) =>
      BrewvaEffect.gen(function* () {
        const apiKey = options?.apiKey;
        if (!apiKey) {
          return yield* failProviderStream(
            `Google Gemini CLI requires Google Cloud credentials. ${GOOGLE_CLOUD_CODE_ASSIST_CREDENTIAL_HINT}`,
          );
        }

        const { token, projectId: credentialProjectId } = yield* providerTryPromise(async () =>
          parseGoogleGeminiCliCredential(apiKey),
        );
        const projectId = options.projectId || credentialProjectId;
        let requestBody = buildRequest(model, context, projectId, options);
        const nextRequestBody = yield* providerTryPromise(async () =>
          options.onPayload?.(
            requestBody,
            model,
            buildProviderPayloadMetadata(model, options, requestBody),
          ),
        );
        if (nextRequestBody !== undefined) {
          requestBody = {
            ...requestBody,
            ...asPartialObject<typeof requestBody>(nextRequestBody),
          };
        }
        const requestUrlBase = DEFAULT_ENDPOINT;
        const headers = {
          ...GEMINI_CLI_HEADERS,
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        };

        yield* ensureStarted();

        const emptyStreamRetries = { count: 0 };
        const attempt = BrewvaEffect.gen(function* () {
          const response = yield* fetchGoogleGeminiCliResponseEffect({
            requestUrl: `${requestUrlBase}/v1internal:streamGenerateContent?alt=sse`,
            headers,
            requestBody,
            signal,
          });
          yield* processGoogleGeminiCliStreamEffect({
            response,
            output,
            stream,
            model,
            toolCalls: composer.toolCalls,
            signal,
            emptyStreamRetries,
          });
        });

        yield* retryWithBrewvaPolicy(attempt, {
          maxRetries: MAX_RETRIES,
          baseDelayMs: BASE_DELAY_MS,
          delayFor: (error) =>
            error instanceof GoogleGeminiCliRetryableRequestError ? error.retryDelayMs : undefined,
          while: (error) => error instanceof GoogleGeminiCliRetryableRequestError,
        }).pipe(
          BrewvaEffect.mapError(unwrapGoogleGeminiCliRequestError),
          BrewvaEffect.mapError(toProviderStreamError),
        );
      }),
    {
      signal: options?.signal,
      sessionId: options?.sessionId,
      startMode: "lazy",
      tools: context.tools,
    },
  );
};

export const streamSimpleGoogleGeminiCli: StreamFunction<
  "google-gemini-cli",
  SimpleStreamOptions
> = (model: Model<"google-gemini-cli">, context: Context, options?: SimpleStreamOptions) => {
  const apiKey = options?.apiKey;
  if (!apiKey) {
    throw new Error(
      `Google Gemini CLI requires Google Cloud credentials. ${GOOGLE_CLOUD_CODE_ASSIST_CREDENTIAL_HINT}`,
    );
  }
  const baseMaxTokens = options?.maxTokens || model.maxTokens / 3;
  if (!options?.reasoning) {
    return streamGoogleGeminiCli(model, context, {
      ...options,
      apiKey,
      maxTokens: baseMaxTokens,
      thinking: { enabled: false },
    });
  }
  if (model.id.toLowerCase().startsWith("gemini-3")) {
    return streamGoogleGeminiCli(model, context, {
      ...options,
      apiKey,
      maxTokens: baseMaxTokens,
      thinking: {
        enabled: true,
        level: getGeminiCliThinkingLevel(
          options.reasoning === "xhigh" ? "high" : options.reasoning,
          model.id,
        ),
      },
    });
  }
  const adjusted = resolveThinkingBudget(
    baseMaxTokens,
    model.maxTokens,
    options.reasoning === "xhigh" ? "high" : options.reasoning,
    options.thinkingBudgets,
  );
  return streamGoogleGeminiCli(model, context, {
    ...options,
    apiKey,
    maxTokens: adjusted.maxTokens,
    thinking: {
      enabled: true,
      budgetTokens: adjusted.thinkingBudget,
    },
  });
};
