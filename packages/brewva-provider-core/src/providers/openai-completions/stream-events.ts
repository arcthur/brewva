import { BrewvaEffect } from "@brewva/brewva-effect/primitives";
import type { ChatCompletionChunk } from "openai/resources/chat/completions.js";
import type {
  AssistantMessage,
  ProviderEventSink,
  Model,
  ProviderStreamError,
  StopReason,
  TextContent,
  ThinkingContent,
  ToolCall,
} from "../../contracts/index.js";
import { failProviderStream, runAsyncIterableEffect } from "../../stream/effect-interop.js";
import type { IncrementalToolCallFolder } from "../../stream/tool-call-folder.js";
import { normalizeOpenAICompletionsUsage } from "./usage.js";
import { readChoiceUsage, readReasoningDeltaField, readReasoningDetails } from "./wire.js";

type OpenAICompletionCurrentBlock =
  | {
      type: "text";
      block: TextContent;
      outputIndex: number;
    }
  | {
      type: "thinking";
      block: ThinkingContent;
      outputIndex: number;
    }
  | null;

function mapStopReason(reason: ChatCompletionChunk.Choice["finish_reason"] | string): {
  stopReason: StopReason;
  errorMessage?: string;
} {
  if (reason === null) return { stopReason: "stop" };
  switch (reason) {
    case "stop":
    case "end":
      return { stopReason: "stop" };
    case "length":
      return { stopReason: "length" };
    case "function_call":
    case "tool_calls":
      return { stopReason: "toolUse" };
    case "content_filter":
      return { stopReason: "error", errorMessage: "Provider finish_reason: content_filter" };
    case "network_error":
      return { stopReason: "error", errorMessage: "Provider finish_reason: network_error" };
    default:
      return {
        stopReason: "error",
        errorMessage: `Provider finish_reason: ${reason}`,
      };
  }
}

export function processOpenAICompletionsStream(
  openaiStream: AsyncIterable<ChatCompletionChunk>,
  output: AssistantMessage,
  stream: ProviderEventSink,
  model: Model<"openai-completions">,
  toolCalls: IncrementalToolCallFolder,
): BrewvaEffect.Effect<void, ProviderStreamError> {
  return BrewvaEffect.gen(function* () {
    let currentBlock: OpenAICompletionCurrentBlock = null;
    let hasFinishReason = false;

    const finishCurrentBlock = () =>
      BrewvaEffect.gen(function* () {
        if (!currentBlock) {
          return;
        }
        if (currentBlock.type === "text") {
          yield* stream.push({
            type: "text_end",
            contentIndex: currentBlock.outputIndex,
            content: currentBlock.block.text,
            partial: output,
          });
          currentBlock = null;
          return;
        }
        if (currentBlock.type === "thinking") {
          yield* stream.push({
            type: "thinking_end",
            contentIndex: currentBlock.outputIndex,
            content: currentBlock.block.thinking,
            partial: output,
          });
          currentBlock = null;
          return;
        }
        currentBlock = null;
      });

    const resolveToolCallKey = (toolCall: {
      index?: number;
      id?: string;
      function?: { name?: string };
    }): string => {
      if (typeof toolCall.index === "number" && Number.isFinite(toolCall.index)) {
        return `index:${toolCall.index}`;
      }
      if (toolCall.id) {
        return `id:${toolCall.id}`;
      }
      if (toolCall.function?.name) {
        for (const block of output.content) {
          if (block.type === "toolCall" && block.name === toolCall.function.name) {
            return `name:${toolCall.function.name}`;
          }
        }
      }
      const toolCallCount = output.content.filter((block) => block.type === "toolCall").length;
      if (toolCallCount === 1) {
        const onlyToolCall = output.content.find((block) => block.type === "toolCall");
        if (onlyToolCall) {
          return `id:${onlyToolCall.id}`;
        }
      }
      return `slot:${toolCallCount}`;
    };

    yield* runAsyncIterableEffect(openaiStream, (chunk) =>
      BrewvaEffect.gen(function* () {
        if (!chunk || typeof chunk !== "object") {
          return;
        }

        output.responseId ||= chunk.id;
        if (typeof chunk.model === "string" && chunk.model.length > 0 && chunk.model !== model.id) {
          output.responseModel ||= chunk.model;
        }
        if (chunk.usage) {
          output.usage = normalizeOpenAICompletionsUsage(chunk.usage, model);
        }

        const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : undefined;
        if (!choice) {
          return;
        }

        const choiceUsage = readChoiceUsage(choice);
        if (!chunk.usage && choiceUsage) {
          output.usage = normalizeOpenAICompletionsUsage(choiceUsage, model);
        }

        if (choice.finish_reason !== null && choice.finish_reason !== undefined) {
          const finishReasonResult = mapStopReason(choice.finish_reason);
          output.stopReason = finishReasonResult.stopReason;
          if (finishReasonResult.errorMessage) {
            output.errorMessage = finishReasonResult.errorMessage;
          }
          hasFinishReason = true;
        }

        if (!choice.delta) {
          return;
        }

        if (
          choice.delta.content !== null &&
          choice.delta.content !== undefined &&
          choice.delta.content.length > 0
        ) {
          if (!currentBlock || currentBlock.type !== "text") {
            yield* finishCurrentBlock();
            const block: TextContent = { type: "text", text: "" };
            output.content.push(block);
            currentBlock = {
              type: "text",
              block,
              outputIndex: output.content.length - 1,
            };
            yield* stream.push({
              type: "text_start",
              contentIndex: currentBlock.outputIndex,
              partial: output,
            });
          }
          if (currentBlock.type === "text") {
            currentBlock.block.text += choice.delta.content;
            yield* stream.push({
              type: "text_delta",
              contentIndex: currentBlock.outputIndex,
              delta: choice.delta.content,
              partial: output,
            });
          }
        }

        const reasoningDelta = readReasoningDeltaField(choice.delta);
        if (reasoningDelta) {
          if (!currentBlock || currentBlock.type !== "thinking") {
            yield* finishCurrentBlock();
            const block: ThinkingContent = {
              type: "thinking",
              thinking: "",
              thinkingSignature: reasoningDelta.field,
            };
            output.content.push(block);
            currentBlock = {
              type: "thinking",
              block,
              outputIndex: output.content.length - 1,
            };
            yield* stream.push({
              type: "thinking_start",
              contentIndex: currentBlock.outputIndex,
              partial: output,
            });
          }
          if (currentBlock.type === "thinking") {
            currentBlock.block.thinking += reasoningDelta.value;
            yield* stream.push({
              type: "thinking_delta",
              contentIndex: currentBlock.outputIndex,
              delta: reasoningDelta.value,
              partial: output,
            });
          }
        }

        if (choice.delta.tool_calls) {
          for (const toolCall of choice.delta.tool_calls) {
            if (currentBlock) {
              yield* finishCurrentBlock();
            }
            const toolCallKey = resolveToolCallKey(toolCall);
            yield* toolCalls.begin(toolCallKey, {
              id: toolCall.id || "",
              name: toolCall.function?.name || "",
              arguments: {},
            });
            yield* toolCalls.appendArgumentsDelta(toolCallKey, toolCall.function?.arguments || "", {
              ...(toolCall.id ? { id: toolCall.id } : {}),
              ...(toolCall.function?.name ? { name: toolCall.function.name } : {}),
            });
          }
        }

        const reasoningDetails = readReasoningDetails(choice.delta);
        if (reasoningDetails) {
          for (const detail of reasoningDetails) {
            if (
              typeof detail === "object" &&
              detail !== null &&
              "type" in detail &&
              "id" in detail &&
              "data" in detail &&
              detail.type === "reasoning.encrypted"
            ) {
              const matchingToolCall = output.content.find(
                (block) => block.type === "toolCall" && block.id === detail.id,
              ) as ToolCall | undefined;
              if (matchingToolCall) {
                matchingToolCall.thoughtSignature = JSON.stringify(detail);
              }
            }
          }
        }
      }),
    );

    if (!hasFinishReason) {
      return yield* failProviderStream("Stream ended without finish_reason");
    }
    yield* finishCurrentBlock();
    yield* toolCalls.finalizeAll();
  });
}
