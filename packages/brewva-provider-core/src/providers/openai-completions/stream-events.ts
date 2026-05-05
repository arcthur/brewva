import type { ChatCompletionChunk } from "openai/resources/chat/completions.js";
import type {
  AssistantMessage,
  AssistantMessageEventStream,
  Model,
  StopReason,
  TextContent,
  ThinkingContent,
  ToolCall,
} from "../../contracts/index.js";
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

export async function processOpenAICompletionsStream(
  openaiStream: AsyncIterable<ChatCompletionChunk>,
  output: AssistantMessage,
  stream: AssistantMessageEventStream,
  model: Model<"openai-completions">,
  toolCalls: IncrementalToolCallFolder,
): Promise<void> {
  let currentBlock: OpenAICompletionCurrentBlock = null;

  const finishCurrentBlock = () => {
    if (!currentBlock) {
      return;
    }
    if (currentBlock.type === "text") {
      stream.push({
        type: "text_end",
        contentIndex: currentBlock.outputIndex,
        content: currentBlock.block.text,
        partial: output,
      });
      currentBlock = null;
      return;
    }
    if (currentBlock.type === "thinking") {
      stream.push({
        type: "thinking_end",
        contentIndex: currentBlock.outputIndex,
        content: currentBlock.block.thinking,
        partial: output,
      });
      currentBlock = null;
      return;
    }
    currentBlock = null;
  };

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

  for await (const chunk of openaiStream) {
    if (!chunk || typeof chunk !== "object") {
      continue;
    }

    output.responseId ||= chunk.id;
    if (chunk.usage) {
      output.usage = normalizeOpenAICompletionsUsage(chunk.usage, model);
    }

    const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : undefined;
    if (!choice) {
      continue;
    }

    const choiceUsage = readChoiceUsage(choice);
    if (!chunk.usage && choiceUsage) {
      output.usage = normalizeOpenAICompletionsUsage(choiceUsage, model);
    }

    if (choice.finish_reason) {
      const finishReasonResult = mapStopReason(choice.finish_reason);
      output.stopReason = finishReasonResult.stopReason;
      if (finishReasonResult.errorMessage) {
        output.errorMessage = finishReasonResult.errorMessage;
      }
    }

    if (!choice.delta) {
      continue;
    }

    if (
      choice.delta.content !== null &&
      choice.delta.content !== undefined &&
      choice.delta.content.length > 0
    ) {
      if (!currentBlock || currentBlock.type !== "text") {
        finishCurrentBlock();
        const block: TextContent = { type: "text", text: "" };
        output.content.push(block);
        currentBlock = {
          type: "text",
          block,
          outputIndex: output.content.length - 1,
        };
        stream.push({
          type: "text_start",
          contentIndex: currentBlock.outputIndex,
          partial: output,
        });
      }
      if (currentBlock.type === "text") {
        currentBlock.block.text += choice.delta.content;
        stream.push({
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
        finishCurrentBlock();
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
        stream.push({
          type: "thinking_start",
          contentIndex: currentBlock.outputIndex,
          partial: output,
        });
      }
      if (currentBlock.type === "thinking") {
        currentBlock.block.thinking += reasoningDelta.value;
        stream.push({
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
          finishCurrentBlock();
        }
        const toolCallKey = resolveToolCallKey(toolCall);
        toolCalls.begin(toolCallKey, {
          id: toolCall.id || "",
          name: toolCall.function?.name || "",
          arguments: {},
        });
        toolCalls.appendArgumentsDelta(toolCallKey, toolCall.function?.arguments || "", {
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
  }

  finishCurrentBlock();
  toolCalls.finalizeAll();
}
