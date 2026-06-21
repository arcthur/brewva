import { BrewvaEffect } from "@brewva/brewva-effect/primitives";
import type { ResponseStreamEvent } from "openai/resources/responses/responses.js";
import type {
  AssistantMessage,
  ProviderEventSink,
  Model,
  ProviderStreamError,
} from "../../contracts/index.js";
import { readSseFrames } from "../../stream/sse-frame-reader.js";
import type { IncrementalToolCallFolder } from "../../stream/tool-call-folder.js";
import { processResponsesStream } from "../openai-responses/stream-events.js";
import type { CodexResponseStatus } from "./contract.js";
import {
  asCodexResponseStreamEvent,
  readCodexErrorCode,
  readCodexErrorMessage,
  readCodexFailedMessage,
  readCodexResponseObject,
} from "./wire.js";

const CODEX_RESPONSE_STATUSES = new Set<CodexResponseStatus>([
  "completed",
  "incomplete",
  "failed",
  "cancelled",
  "queued",
  "in_progress",
]);

// One protocol normalizer for every Codex transport. Each transport yields raw
// Codex frames; this is the single seam where they become normalized provider
// events AND where terminal integrity is asserted: `mapCodexEvents` rejects a frame
// stream that ends without a terminal response event, so a truncated SSE body can
// never be committed as a complete `stop`. The WebSocket transport additionally
// fails fast (parseWebSocket throws on close before response.completed); both
// transports therefore guarantee completion before a `done` is emitted.
export function runCodexNormalizer(
  rawFrames: AsyncIterable<Record<string, unknown>>,
  output: AssistantMessage,
  stream: ProviderEventSink,
  model: Model<"openai-codex-responses">,
  toolCalls: IncrementalToolCallFolder,
): BrewvaEffect.Effect<void, ProviderStreamError> {
  return processResponsesStream(mapCodexEvents(rawFrames), output, stream, model, toolCalls);
}

export function processStream(
  response: Response,
  output: AssistantMessage,
  stream: ProviderEventSink,
  model: Model<"openai-codex-responses">,
  toolCalls: IncrementalToolCallFolder,
): BrewvaEffect.Effect<void, ProviderStreamError> {
  return runCodexNormalizer(parseSSE(response), output, stream, model, toolCalls);
}

export async function* mapCodexEvents(
  events: AsyncIterable<Record<string, unknown>>,
): AsyncGenerator<ResponseStreamEvent> {
  for await (const event of events) {
    const type = typeof event.type === "string" ? event.type : undefined;
    if (!type) continue;

    if (type === "error") {
      const code = readCodexErrorCode(event) || "";
      const message = readCodexErrorMessage(event) || "";
      throw new Error(`Codex error: ${message || code || JSON.stringify(event)}`);
    }

    if (type === "response.failed") {
      const msg = readCodexFailedMessage(event);
      throw new Error(msg || "Codex response failed");
    }

    if (
      type === "response.done" ||
      type === "response.completed" ||
      type === "response.incomplete"
    ) {
      const response = readCodexResponseObject(event);
      const normalizedResponse = response
        ? { ...response, status: normalizeCodexStatus(response.status) }
        : response;
      yield asCodexResponseStreamEvent({
        ...event,
        type: "response.completed",
        response: normalizedResponse,
      });
      return;
    }

    yield asCodexResponseStreamEvent(event);
  }
  // Reached EOF without a terminal response event (response.completed / .done /
  // .incomplete) or an explicit error/failed frame: the body was truncated. Reject
  // it so a partial Codex response cannot be committed as a complete `stop`. The
  // throw is converted to a terminal `error` event by the stream runner, matching
  // the terminal-integrity guarantee OpenAI Completions and Anthropic already hold.
  throw new Error("Codex stream ended before a terminal response event (truncated stream)");
}

function normalizeCodexStatus(status: unknown): CodexResponseStatus | undefined {
  if (typeof status !== "string") return undefined;
  return CODEX_RESPONSE_STATUSES.has(status as CodexResponseStatus)
    ? (status as CodexResponseStatus)
    : undefined;
}

export async function* parseSSE(response: Response): AsyncGenerator<Record<string, unknown>> {
  for await (const frame of readSseFrames(response)) {
    const data = frame.data.trim();
    if (!data || data === "[DONE]") {
      continue;
    }
    try {
      yield JSON.parse(data);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Invalid Codex SSE JSON: ${message}`);
    }
  }
}
