import type { ResponseStreamEvent } from "openai/resources/responses/responses.js";
import type {
  AssistantMessage,
  AssistantMessageEventStream,
  Model,
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

export async function processStream(
  response: Response,
  output: AssistantMessage,
  stream: AssistantMessageEventStream,
  model: Model<"openai-codex-responses">,
  toolCalls: IncrementalToolCallFolder,
): Promise<void> {
  await processResponsesStream(
    mapCodexEvents(parseSSE(response)),
    output,
    stream,
    model,
    toolCalls,
  );
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
