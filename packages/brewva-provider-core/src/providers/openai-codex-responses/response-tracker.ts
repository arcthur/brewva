import type { ResponseInput } from "openai/resources/responses/responses.js";
import type { ResponseInputItem } from "./contract.js";

export interface CodexResponseTracker {
  responseId?: string;
  outputItems: ResponseInput;
}

export async function* trackCodexResponse(
  events: AsyncIterable<Record<string, unknown>>,
  tracker: CodexResponseTracker,
): AsyncGenerator<Record<string, unknown>> {
  for await (const event of events) {
    const outputItem = readCodexOutputItem(event);
    if (outputItem) {
      tracker.outputItems.push(structuredClone(outputItem));
    }
    const responseId = readCodexResponseId(event);
    if (responseId) {
      tracker.responseId = responseId;
    }
    yield event;
  }
}

function readCodexOutputItem(event: Record<string, unknown>): ResponseInputItem | undefined {
  if (event.type !== "response.output_item.done") {
    return undefined;
  }
  const item = event.item;
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    return undefined;
  }
  const type = (item as { type?: unknown }).type;
  if (type !== "message" && type !== "function_call" && type !== "reasoning") {
    return undefined;
  }
  return item as ResponseInputItem;
}

function readCodexResponseId(event: Record<string, unknown>): string | undefined {
  const type = event.type;
  if (type !== "response.completed" && type !== "response.done" && type !== "response.incomplete") {
    return undefined;
  }
  const response = event.response;
  if (!response || typeof response !== "object") {
    return undefined;
  }
  const id = (response as { id?: unknown }).id;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}
