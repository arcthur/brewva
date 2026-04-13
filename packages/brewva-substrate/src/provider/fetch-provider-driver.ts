import type { BrewvaRegisteredModel } from "../contracts/provider.js";
import type {
  BrewvaProviderCompletionDriver,
  BrewvaProviderCompletionRequest,
  BrewvaProviderCompletionResponse,
  BrewvaProviderCompletionUsage,
} from "./completion.js";

const DEFAULT_MAX_OUTPUT_TOKENS = 1024;

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type JsonRecord = Record<string, unknown>;

export interface CreateFetchProviderCompletionDriverOptions {
  fetchImpl?: FetchLike;
  maxOutputTokens?: number;
}

export class UnsupportedBrewvaProviderApiError extends Error {
  readonly api: string;

  constructor(api: string) {
    super(`Unsupported Brewva provider completion API: ${api}`);
    this.name = "UnsupportedBrewvaProviderApiError";
    this.api = api;
  }
}

export function isUnsupportedBrewvaProviderApiError(
  error: unknown,
): error is UnsupportedBrewvaProviderApiError {
  return error instanceof UnsupportedBrewvaProviderApiError;
}

class FetchProviderCompletionDriver implements BrewvaProviderCompletionDriver {
  readonly #fetchImpl: FetchLike;
  readonly #maxOutputTokens: number;

  constructor(options: CreateFetchProviderCompletionDriverOptions = {}) {
    this.#fetchImpl = options.fetchImpl ?? fetch;
    this.#maxOutputTokens = options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
  }

  async complete(
    input: BrewvaProviderCompletionRequest,
  ): Promise<BrewvaProviderCompletionResponse> {
    switch (input.model.api) {
      case "openai-completions":
        return this.#completeOpenAIChat(input);
      case "openai-responses":
        return this.#completeOpenAIResponses(input);
      case "openai-codex-responses":
        return this.#completeOpenAIResponses(input, { codex: true });
      case "anthropic-messages":
        return this.#completeAnthropic(input);
      case "google-generative-ai":
        return this.#completeGoogleGenerativeAI(input);
      default:
        throw new UnsupportedBrewvaProviderApiError(input.model.api);
    }
  }

  async #completeOpenAIChat(
    input: BrewvaProviderCompletionRequest,
  ): Promise<BrewvaProviderCompletionResponse> {
    const response = await this.#postJson(
      resolveOpenAIChatCompletionsUrl(input.model.baseUrl),
      {
        model: input.model.id,
        messages: [
          { role: "system", content: input.systemPrompt },
          { role: "user", content: input.userText },
        ],
        temperature: 0,
        [resolveOpenAIChatMaxTokensField(input.model)]: resolveMaxOutputTokens(
          input.model,
          this.#maxOutputTokens,
        ),
      },
      buildOpenAIHeaders(input),
    );
    const choice = firstRecord(readArray(response.choices));
    const message = readRecord(choice?.message);

    const text = readString(message?.content) ?? extractOpenAITextParts(message?.content);

    return {
      role: "assistant",
      provider: input.model.provider,
      model: readString(response.model) ?? input.model.id,
      stopReason: readString(choice?.finish_reason),
      timestamp: Date.now(),
      usage: buildOpenAIUsage(response.usage),
      content: buildTextContent(text),
    };
  }

  async #completeOpenAIResponses(
    input: BrewvaProviderCompletionRequest,
    options: { codex?: boolean } = {},
  ): Promise<BrewvaProviderCompletionResponse> {
    const response = await this.#postJson(
      resolveOpenAIResponsesUrl(input.model.baseUrl, options),
      {
        model: input.model.id,
        input: [
          {
            role: "system",
            content: [{ type: "input_text", text: input.systemPrompt }],
          },
          {
            role: "user",
            content: [{ type: "input_text", text: input.userText }],
          },
        ],
        store: false,
        max_output_tokens: resolveMaxOutputTokens(input.model, this.#maxOutputTokens),
      },
      buildOpenAIHeaders(input),
    );

    const text =
      readString(response.output_text) ??
      extractOpenAIResponsesOutputText(response.output) ??
      extractOpenAITextParts(firstRecord(readArray(response.output))?.content);

    return {
      role: "assistant",
      provider: input.model.provider,
      model: readString(response.model) ?? input.model.id,
      stopReason: readString(response.stop_reason),
      timestamp: Date.now(),
      usage: buildOpenAIUsage(response.usage),
      content: buildTextContent(text),
    };
  }

  async #completeAnthropic(
    input: BrewvaProviderCompletionRequest,
  ): Promise<BrewvaProviderCompletionResponse> {
    const response = await this.#postJson(
      resolveAnthropicMessagesUrl(input.model.baseUrl),
      {
        model: input.model.id,
        system: input.systemPrompt,
        messages: [{ role: "user", content: input.userText }],
        max_tokens: resolveMaxOutputTokens(input.model, this.#maxOutputTokens),
      },
      buildAnthropicHeaders(input),
    );

    return {
      role: "assistant",
      provider: input.model.provider,
      model: readString(response.model) ?? input.model.id,
      stopReason: readString(response.stop_reason),
      timestamp: Date.now(),
      usage: buildAnthropicUsage(response.usage),
      content: buildTextContent(extractAnthropicText(response.content)),
    };
  }

  async #completeGoogleGenerativeAI(
    input: BrewvaProviderCompletionRequest,
  ): Promise<BrewvaProviderCompletionResponse> {
    const response = await this.#postJson(
      resolveGoogleGenerativeAiUrl(input.model),
      {
        systemInstruction: {
          parts: [{ text: input.systemPrompt }],
        },
        contents: [
          {
            role: "user",
            parts: [{ text: input.userText }],
          },
        ],
        generationConfig: {
          temperature: 0,
          maxOutputTokens: resolveMaxOutputTokens(input.model, this.#maxOutputTokens),
        },
      },
      buildGoogleHeaders(input),
    );

    const firstCandidate = firstRecord(readArray(response.candidates));
    return {
      role: "assistant",
      provider: input.model.provider,
      model: input.model.id,
      stopReason: normalizeGoogleStopReason(readString(firstCandidate?.finishReason)),
      timestamp: Date.now(),
      usage: buildGoogleUsage(response.usageMetadata),
      content: buildTextContent(extractGoogleText(firstCandidate?.content)),
    };
  }

  async #postJson(
    url: string,
    payload: Record<string, unknown>,
    headers: Record<string, string>,
  ): Promise<JsonRecord> {
    const response = await this.#fetchImpl(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      const bodyText = await response.text();
      throw new Error(
        `Provider completion request failed: ${response.status} ${response.statusText} ${bodyText}`.trim(),
      );
    }
    const data = (await response.json()) as unknown;
    if (!isRecord(data)) {
      throw new Error("Provider completion response must be a JSON object.");
    }
    return data;
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readRecord(value: unknown): JsonRecord | undefined {
  return isRecord(value) ? value : undefined;
}

function readArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

function firstRecord(value: unknown[] | undefined): JsonRecord | undefined {
  if (!value || value.length === 0) {
    return undefined;
  }
  return readRecord(value[0]);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function buildTextContent(text: string | undefined): Array<{ type: "text"; text: string }> {
  return typeof text === "string" && text.length > 0 ? [{ type: "text", text }] : [];
}

function resolveMaxOutputTokens(model: BrewvaRegisteredModel, fallback: number): number {
  return Math.max(1, Math.min(model.maxTokens, fallback));
}

function resolveOpenAIChatMaxTokensField(model: BrewvaRegisteredModel): string {
  return model.compat &&
    "maxTokensField" in model.compat &&
    model.compat.maxTokensField === "max_tokens"
    ? "max_tokens"
    : "max_completion_tokens";
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/u, "");
}

function resolveOpenAIChatCompletionsUrl(baseUrl: string): string {
  const normalized = normalizeBaseUrl(baseUrl);
  return normalized.endsWith("/chat/completions") ? normalized : `${normalized}/chat/completions`;
}

function resolveOpenAIResponsesUrl(baseUrl: string, options: { codex?: boolean }): string {
  const normalized = normalizeBaseUrl(baseUrl);
  if (options.codex) {
    if (normalized.endsWith("/codex/responses")) {
      return normalized;
    }
    if (normalized.endsWith("/codex")) {
      return `${normalized}/responses`;
    }
    return `${normalized}/codex/responses`;
  }
  return normalized.endsWith("/responses") ? normalized : `${normalized}/responses`;
}

function resolveAnthropicMessagesUrl(baseUrl: string): string {
  const normalized = normalizeBaseUrl(baseUrl);
  return normalized.endsWith("/messages") ? normalized : `${normalized}/messages`;
}

function resolveGoogleGenerativeAiUrl(model: BrewvaRegisteredModel): string {
  const normalized = normalizeBaseUrl(model.baseUrl);
  const encodedModelId = encodeURIComponent(model.id);
  if (normalized.includes(`/models/${encodedModelId}:generateContent`)) {
    return normalized;
  }
  if (normalized.endsWith("/models")) {
    return `${normalized}/${encodedModelId}:generateContent`;
  }
  return `${normalized}/models/${encodedModelId}:generateContent`;
}

function mergeHeaders(
  ...sources: Array<Record<string, string> | undefined>
): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const source of sources) {
    if (!source) {
      continue;
    }
    for (const [key, value] of Object.entries(source)) {
      merged[key] = value;
    }
  }
  return merged;
}

function buildOpenAIHeaders(input: BrewvaProviderCompletionRequest): Record<string, string> {
  const headers = mergeHeaders(input.model.headers, input.auth.headers);
  if (input.auth.apiKey && !headers.Authorization) {
    headers.Authorization = `Bearer ${input.auth.apiKey}`;
  }
  headers["content-type"] = "application/json";
  return headers;
}

function isAnthropicOAuthToken(apiKey: string | undefined): boolean {
  return typeof apiKey === "string" && apiKey.includes("sk-ant-oat");
}

function buildAnthropicHeaders(input: BrewvaProviderCompletionRequest): Record<string, string> {
  const headers = mergeHeaders(input.model.headers, input.auth.headers, {
    "anthropic-version": "2023-06-01",
    "anthropic-dangerous-direct-browser-access": "true",
  });
  if (input.auth.apiKey && !headers.Authorization && !headers["x-api-key"]) {
    if (isAnthropicOAuthToken(input.auth.apiKey)) {
      headers.Authorization = `Bearer ${input.auth.apiKey}`;
    } else {
      headers["x-api-key"] = input.auth.apiKey;
    }
  }
  headers["content-type"] = "application/json";
  return headers;
}

function buildGoogleHeaders(input: BrewvaProviderCompletionRequest): Record<string, string> {
  const headers = mergeHeaders(input.model.headers, input.auth.headers);
  if (input.auth.apiKey && !headers.Authorization && !headers["x-goog-api-key"]) {
    headers["x-goog-api-key"] = input.auth.apiKey;
  }
  headers["content-type"] = "application/json";
  return headers;
}

function extractOpenAITextParts(content: unknown): string | undefined {
  if (!Array.isArray(content)) {
    return undefined;
  }
  const text = content
    .map((part) => {
      if (!isRecord(part)) {
        return undefined;
      }
      return readString(part.text);
    })
    .filter((value): value is string => typeof value === "string")
    .join("\n");
  return text.length > 0 ? text : undefined;
}

function extractOpenAIResponsesOutputText(output: unknown): string | undefined {
  if (!Array.isArray(output)) {
    return undefined;
  }
  const text = output
    .flatMap((item) => {
      if (!isRecord(item) || !Array.isArray(item.content)) {
        return [];
      }
      return item.content.flatMap((part) => {
        if (!isRecord(part)) {
          return [];
        }
        const partText =
          readString(part.text) ??
          (isRecord(part.text) ? readString(part.text.value) : undefined) ??
          readString(part.output_text);
        return partText ? [partText] : [];
      });
    })
    .join("\n");
  return text.length > 0 ? text : undefined;
}

function extractAnthropicText(content: unknown): string | undefined {
  if (!Array.isArray(content)) {
    return undefined;
  }
  const text = content
    .flatMap((part) => {
      if (!isRecord(part) || part.type !== "text") {
        return [];
      }
      const value = readString(part.text);
      return value ? [value] : [];
    })
    .join("\n");
  return text.length > 0 ? text : undefined;
}

function extractGoogleText(content: unknown): string | undefined {
  const record = readRecord(content);
  const parts = readArray(record?.parts);
  if (!parts) {
    return undefined;
  }
  const text = parts
    .flatMap((part) => {
      const partRecord = readRecord(part);
      const value = readString(partRecord?.text);
      return value ? [value] : [];
    })
    .join("\n");
  return text.length > 0 ? text : undefined;
}

function buildOpenAIUsage(usage: unknown): BrewvaProviderCompletionUsage {
  if (!isRecord(usage)) {
    return {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
    };
  }
  const input = readNumber(usage.prompt_tokens) ?? readNumber(usage.input_tokens) ?? 0;
  const output = readNumber(usage.completion_tokens) ?? readNumber(usage.output_tokens) ?? 0;
  const cacheRead = isRecord(usage.prompt_tokens_details)
    ? (readNumber(usage.prompt_tokens_details.cached_tokens) ?? 0)
    : 0;
  const totalTokens = readNumber(usage.total_tokens) ?? input + output;
  return {
    input,
    output,
    cacheRead,
    cacheWrite: 0,
    totalTokens,
  };
}

function buildAnthropicUsage(usage: unknown): BrewvaProviderCompletionUsage {
  if (!isRecord(usage)) {
    return {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
    };
  }
  const input = readNumber(usage.input_tokens) ?? 0;
  const output = readNumber(usage.output_tokens) ?? 0;
  return {
    input,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: input + output,
  };
}

function buildGoogleUsage(usage: unknown): BrewvaProviderCompletionUsage {
  if (!isRecord(usage)) {
    return {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
    };
  }
  const input = readNumber(usage.promptTokenCount) ?? 0;
  const output = readNumber(usage.candidatesTokenCount) ?? 0;
  const totalTokens = readNumber(usage.totalTokenCount) ?? input + output;
  return {
    input,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens,
  };
}

function normalizeGoogleStopReason(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = value.toLowerCase();
  if (normalized === "stop") {
    return "stop";
  }
  return normalized;
}

export function createFetchProviderCompletionDriver(
  options: CreateFetchProviderCompletionDriverOptions = {},
): BrewvaProviderCompletionDriver {
  return new FetchProviderCompletionDriver(options);
}
