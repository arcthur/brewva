import { setTimeout as delay } from "node:timers/promises";
import type { Context, Model, SimpleStreamOptions, StreamFunction } from "../../contracts/index.js";
import { runProviderStream } from "../../stream/run-provider-stream.js";
import { readSseFrames } from "../../stream/sse-frame-reader.js";
import { asPartialObject } from "../../utils/unknown-object.js";
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

async function* createChunkStream(
  response: Response,
): AsyncGenerator<CloudCodeAssistResponseChunk> {
  for await (const frame of readSseFrames(response, { ignoreParseErrors: false })) {
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

export const streamGoogleGeminiCli: StreamFunction<"google-gemini-cli", GoogleGeminiCliOptions> = (
  model: Model<"google-gemini-cli">,
  context: Context,
  options?: GoogleGeminiCliOptions,
) => {
  return runProviderStream(
    model,
    async ({ stream, output, ensureStarted, composer }) => {
      if (!options?.apiKey) {
        throw new Error(
          `Google Gemini CLI requires Google Cloud credentials. ${GOOGLE_CLOUD_CODE_ASSIST_CREDENTIAL_HINT}`,
        );
      }

      const { token, projectId: credentialProjectId } = parseGoogleGeminiCliCredential(
        options.apiKey,
      );
      const projectId = options.projectId || credentialProjectId;
      let requestBody = buildRequest(model, context, projectId, options);
      const nextRequestBody = await options.onPayload?.(
        requestBody,
        model,
        buildProviderPayloadMetadata(model, options, requestBody),
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

      ensureStarted();

      let lastError: Error | null = null;
      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        let response: Response;
        try {
          response = await fetch(`${requestUrlBase}/v1internal:streamGenerateContent?alt=sse`, {
            method: "POST",
            headers,
            body: JSON.stringify(requestBody),
            signal: options.signal,
          });
        } catch (error) {
          lastError = error instanceof Error ? error : new Error(String(error));
          if (attempt === MAX_RETRIES) break;
          await delay(BASE_DELAY_MS * 2 ** attempt);
          continue;
        }

        if (!response.ok) {
          const errorText = extractErrorMessage(await response.text());
          lastError = new Error(errorText);
          if (!isRetryableError(response.status, errorText) || attempt === MAX_RETRIES) {
            throw lastError;
          }
          const serverDelay = extractRetryDelay(errorText, response);
          await delay(serverDelay ?? BASE_DELAY_MS * 2 ** attempt);
          continue;
        }

        try {
          await processGoogleGeminiCliSseStream(
            createChunkStream(response),
            output,
            stream,
            model,
            composer.toolCalls,
          );
          return;
        } catch (error) {
          lastError = error instanceof Error ? error : new Error(String(error));
          if (lastError.message !== "Empty SSE response" || attempt >= MAX_EMPTY_STREAM_RETRIES) {
            throw lastError;
          }
          await delay(EMPTY_STREAM_BASE_DELAY_MS * (attempt + 1));
        }
      }

      throw lastError ?? new Error("Google Gemini CLI request failed");
    },
    {
      signal: options?.signal,
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
