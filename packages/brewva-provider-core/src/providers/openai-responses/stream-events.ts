import type OpenAI from "openai";
import type {
  ResponseFunctionToolCall,
  ResponseOutputMessage,
  ResponseReasoningItem,
  ResponseStreamEvent,
} from "openai/resources/responses/responses.js";
import { calculateCost } from "../../catalog/index.js";
import type {
  Api,
  AssistantMessage,
  Model,
  StopReason,
  TextContent,
  TextSignatureV1,
  ThinkingContent,
  Usage,
  ProviderEventSink,
} from "../../contracts/index.js";
import type { IncrementalToolCallFolder } from "../../stream/tool-call-folder.js";
import type { OpenAIResponsesStreamOptions } from "./contract.js";

type ResponseReasoningSummaryPart = NonNullable<ResponseReasoningItem["summary"]>[number];

function readReasoningSummaryIndex(event: { summary_index?: unknown }): number | null {
  return typeof event.summary_index === "number" && Number.isInteger(event.summary_index)
    ? event.summary_index
    : null;
}

function readReasoningSummaryPart(part: unknown): ResponseReasoningSummaryPart | null {
  if (!part || typeof part !== "object" || Array.isArray(part)) {
    return null;
  }
  if (typeof (part as { text?: unknown }).text !== "string") {
    return null;
  }
  return part as ResponseReasoningSummaryPart;
}

function ensureReasoningSummaryPart(
  item: ResponseReasoningItem,
  event: { part?: unknown; summary_index?: unknown },
): ResponseReasoningSummaryPart {
  item.summary = item.summary || [];
  const index = readReasoningSummaryIndex(event) ?? item.summary.length;
  const existing = item.summary[index];
  if (existing) {
    return existing;
  }

  const part =
    readReasoningSummaryPart(event.part) ?? ({ type: "summary_text", text: "" } as const);
  item.summary[index] = part;
  return part;
}

function resolveReasoningSummaryPart(
  item: ResponseReasoningItem,
  event: { summary_index?: unknown },
): ResponseReasoningSummaryPart | null {
  item.summary = item.summary || [];
  const index = readReasoningSummaryIndex(event);
  if (index !== null) {
    return item.summary[index] ?? ensureReasoningSummaryPart(item, event);
  }
  return item.summary[item.summary.length - 1] ?? null;
}

function encodeTextSignatureV1(id: string, phase?: TextSignatureV1["phase"]): string {
  const payload: TextSignatureV1 = { v: 1, id };
  if (phase) payload.phase = phase;
  return JSON.stringify(payload);
}

export async function processResponsesStream<TApi extends Api>(
  openaiStream: AsyncIterable<ResponseStreamEvent>,
  output: AssistantMessage,
  stream: ProviderEventSink,
  model: Model<TApi>,
  toolCalls: IncrementalToolCallFolder,
  options?: OpenAIResponsesStreamOptions,
): Promise<void> {
  let currentItem: ResponseReasoningItem | ResponseOutputMessage | ResponseFunctionToolCall | null =
    null;
  let currentBlock: ThinkingContent | TextContent | null = null;
  const blocks = output.content;
  const blockIndex = () => blocks.length - 1;

  for await (const event of openaiStream) {
    if (event.type === "response.created") {
      output.responseId = event.response.id;
    } else if (event.type === "response.output_item.added") {
      const item = event.item;
      if (item.type === "reasoning") {
        currentItem = item;
        currentBlock = { type: "thinking", thinking: "" };
        output.content.push(currentBlock);
        await stream.push({ type: "thinking_start", contentIndex: blockIndex(), partial: output });
      } else if (item.type === "message") {
        currentItem = item;
        currentBlock = { type: "text", text: "" };
        output.content.push(currentBlock);
        await stream.push({ type: "text_start", contentIndex: blockIndex(), partial: output });
      } else if (item.type === "function_call") {
        const toolItemId = item.id ?? item.call_id;
        await toolCalls.begin(
          toolItemId,
          {
            id: `${item.call_id}|${item.id}`,
            name: item.name,
          },
          item.arguments || "",
        );
      }
    } else if (event.type === "response.reasoning_summary_part.added") {
      if (currentItem && currentItem.type === "reasoning") {
        ensureReasoningSummaryPart(currentItem, event);
      }
    } else if (event.type === "response.reasoning_summary_text.delta") {
      if (currentItem?.type === "reasoning" && currentBlock?.type === "thinking") {
        const part = resolveReasoningSummaryPart(currentItem, event);
        if (part) {
          currentBlock.thinking += event.delta;
          part.text += event.delta;
          await stream.push({
            type: "thinking_delta",
            contentIndex: blockIndex(),
            delta: event.delta,
            partial: output,
          });
        }
      }
    } else if (event.type === "response.reasoning_summary_part.done") {
      if (currentItem?.type === "reasoning" && currentBlock?.type === "thinking") {
        const part = resolveReasoningSummaryPart(currentItem, event);
        if (part) {
          currentBlock.thinking += "\n\n";
          part.text += "\n\n";
          await stream.push({
            type: "thinking_delta",
            contentIndex: blockIndex(),
            delta: "\n\n",
            partial: output,
          });
        }
      }
    } else if (event.type === "response.content_part.added") {
      if (currentItem?.type === "message") {
        currentItem.content = currentItem.content || [];
        if (event.part.type === "output_text" || event.part.type === "refusal") {
          currentItem.content.push(event.part);
        }
      }
    } else if (event.type === "response.output_text.delta") {
      if (currentItem?.type === "message" && currentBlock?.type === "text") {
        if (!currentItem.content || currentItem.content.length === 0) {
          continue;
        }
        const lastPart = currentItem.content[currentItem.content.length - 1];
        if (lastPart?.type === "output_text") {
          currentBlock.text += event.delta;
          lastPart.text += event.delta;
          await stream.push({
            type: "text_delta",
            contentIndex: blockIndex(),
            delta: event.delta,
            partial: output,
          });
        }
      }
    } else if (event.type === "response.refusal.delta") {
      if (currentItem?.type === "message" && currentBlock?.type === "text") {
        if (!currentItem.content || currentItem.content.length === 0) {
          continue;
        }
        const lastPart = currentItem.content[currentItem.content.length - 1];
        if (lastPart?.type === "refusal") {
          currentBlock.text += event.delta;
          lastPart.refusal += event.delta;
          await stream.push({
            type: "text_delta",
            contentIndex: blockIndex(),
            delta: event.delta,
            partial: output,
          });
        }
      }
    } else if (event.type === "response.function_call_arguments.delta") {
      await toolCalls.appendArgumentsDelta(event.item_id, event.delta);
    } else if (event.type === "response.function_call_arguments.done") {
      await toolCalls.replaceArguments(event.item_id, event.arguments);
    } else if (event.type === "response.output_item.done") {
      const item = event.item;

      if (item.type === "reasoning" && currentBlock?.type === "thinking") {
        currentBlock.thinking = item.summary?.map((s) => s.text).join("\n\n") || "";
        currentBlock.thinkingSignature = JSON.stringify(item);
        await stream.push({
          type: "thinking_end",
          contentIndex: blockIndex(),
          content: currentBlock.thinking,
          partial: output,
        });
        currentBlock = null;
      } else if (item.type === "message" && currentBlock?.type === "text") {
        currentBlock.text = item.content
          .map((c) => (c.type === "output_text" ? c.text : c.refusal))
          .join("");
        currentBlock.textSignature = encodeTextSignatureV1(item.id, item.phase ?? undefined);
        await stream.push({
          type: "text_end",
          contentIndex: blockIndex(),
          content: currentBlock.text,
          partial: output,
        });
        currentBlock = null;
      } else if (item.type === "function_call") {
        const toolItemId = item.id ?? item.call_id;
        await toolCalls.replaceArguments(toolItemId, item.arguments || "{}");
        await toolCalls.finalize(toolItemId, {
          id: `${item.call_id}|${item.id}`,
          name: item.name,
        });
      }
    } else if (event.type === "response.completed") {
      const response = event.response;
      if (response?.id) {
        output.responseId = response.id;
      }
      if (response?.usage) {
        const cachedTokens = response.usage.input_tokens_details?.cached_tokens || 0;
        output.usage = {
          input: (response.usage.input_tokens || 0) - cachedTokens,
          output: response.usage.output_tokens || 0,
          cacheRead: cachedTokens,
          cacheWrite: 0,
          totalTokens: response.usage.total_tokens || 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        };
      }
      calculateCost(model, output.usage);
      if (options?.applyServiceTierPricing) {
        const serviceTier = response?.service_tier ?? options.serviceTier;
        options.applyServiceTierPricing(output.usage as Usage, serviceTier);
      }
      output.stopReason = mapStopReason(response?.status);
      if (output.content.some((b) => b.type === "toolCall") && output.stopReason === "stop") {
        output.stopReason = "toolUse";
      }
    } else if (event.type === "error") {
      throw new Error(`Error Code ${event.code}: ${event.message}` || "Unknown error");
    } else if (event.type === "response.failed") {
      const error = event.response?.error;
      const details = event.response?.incomplete_details;
      const msg = error
        ? `${error.code || "unknown"}: ${error.message || "no message"}`
        : details?.reason
          ? `incomplete: ${details.reason}`
          : "Unknown error (no error details in response)";
      throw new Error(msg);
    }
  }
}

function mapStopReason(status: OpenAI.Responses.ResponseStatus | undefined): StopReason {
  if (!status) return "stop";
  switch (status) {
    case "completed":
      return "stop";
    case "incomplete":
      return "length";
    case "failed":
    case "cancelled":
      return "error";
    case "in_progress":
    case "queued":
      return "stop";
    default: {
      const _exhaustive: never = status;
      throw new Error(`Unhandled stop reason: ${_exhaustive}`);
    }
  }
}
