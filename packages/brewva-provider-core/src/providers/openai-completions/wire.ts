import type OpenAI from "openai";
import type {
  ChatCompletionAssistantMessageParam,
  ChatCompletionChunk,
  ChatCompletionToolMessageParam,
} from "openai/resources/chat/completions.js";
import { isRecord, readArray, readObject, readString } from "../../utils/unknown-object.js";

export type OpenAICompletionsRequestCompat = Omit<
  OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming,
  "reasoning_effort" | "stream_options"
> & {
  stream_options?: { include_usage?: boolean } | null;
  max_tokens?: number;
  enable_thinking?: boolean;
  chat_template_kwargs?: { enable_thinking: boolean };
  thinking?: { type: "enabled" | "disabled" };
  reasoning_effort?: string;
  provider?: Record<string, unknown>;
  prompt_cache_key?: string;
  prompt_cache_retention?: "24h";
};

export function withOpenAICompletionsCompat(
  params: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming,
): OpenAICompletionsRequestCompat {
  return params as OpenAICompletionsRequestCompat;
}

export function asStreamingParams(
  params: OpenAICompletionsRequestCompat,
): OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming {
  // SDK request types lag provider-compatible wire fields; keep the cast at this boundary.
  return params as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming;
}

export type OpenAICompletionChoiceCompat = ChatCompletionChunk.Choice & {
  usage?: OpenAI.CompletionUsage;
};

export function readChoiceUsage(
  choice: ChatCompletionChunk.Choice,
): OpenAI.CompletionUsage | undefined {
  const compatChoice = choice as OpenAICompletionChoiceCompat;
  return compatChoice.usage;
}

export type OpenAICompletionDeltaCompat = ChatCompletionChunk.Choice["delta"] & {
  reasoning_content?: string;
  reasoning?: string;
  reasoning_text?: string;
  reasoning_details?: unknown[];
};

export function readReasoningDeltaField(
  delta: ChatCompletionChunk.Choice["delta"],
): { field: keyof OpenAICompletionDeltaCompat; value: string } | undefined {
  const compatDelta = delta as OpenAICompletionDeltaCompat;
  for (const field of ["reasoning_content", "reasoning", "reasoning_text"] as const) {
    const value = compatDelta[field];
    if (typeof value === "string" && value.length > 0) {
      return { field, value };
    }
  }
  return undefined;
}

export function readReasoningDetails(
  delta: ChatCompletionChunk.Choice["delta"],
): unknown[] | undefined {
  const compatDelta = delta as OpenAICompletionDeltaCompat;
  return Array.isArray(compatDelta.reasoning_details) ? compatDelta.reasoning_details : undefined;
}

export function setAssistantMessageSignature(
  message: ChatCompletionAssistantMessageParam,
  signature: string,
  value: string,
): void {
  const record = message as ChatCompletionAssistantMessageParam & Record<string, unknown>;
  record[signature] = value;
}

export function setAssistantReasoningDetails(
  message: ChatCompletionAssistantMessageParam,
  reasoningDetails: unknown[],
): void {
  const record = message as ChatCompletionAssistantMessageParam & {
    reasoning_details?: unknown[];
  };
  record.reasoning_details = reasoningDetails;
}

export function setToolMessageName(message: ChatCompletionToolMessageParam, name: string): void {
  const record = message as ChatCompletionToolMessageParam & { name?: string };
  record.name = name;
}

export function readErrorRawMetadata(error: unknown): string | undefined {
  const errorObject = readObject(error, "error");
  const metadata = readObject(errorObject, "metadata");
  return readString(metadata, "raw");
}

export function readToolTextContent(content: unknown): string | undefined {
  return isRecord(content) && content.type === "text" ? readString(content, "text") : undefined;
}

export function readToolImagePayload(
  content: unknown,
): { mimeType: string; data: string } | undefined {
  if (!isRecord(content) || content.type !== "image") {
    return undefined;
  }
  const mimeType = readString(content, "mimeType");
  const data = readString(content, "data");
  if (!mimeType || !data) {
    return undefined;
  }
  return { mimeType, data };
}

export function readOpenRouterRouting(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

export function readArrayReasoningDetails(value: unknown): unknown[] {
  return readArray({ details: value }, "details") ?? [];
}
