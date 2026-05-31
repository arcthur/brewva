import { BrewvaEffect } from "@brewva/brewva-effect/primitives";
import type {
  AssistantMessage,
  ProviderEventSink,
  Model,
  ProviderStreamError,
  StopReason,
  TextContent,
  ThinkingContent,
  Tool,
  ToolCall,
} from "../../contracts/index.js";
import { failProviderStream, runAsyncIterableEffect } from "../../stream/effect-interop.js";
import type { IncrementalToolCallFolder } from "../../stream/tool-call-folder.js";
import { fromClaudeCodeName } from "./compat.js";
import { applyAnthropicUsageTotals } from "./usage.js";

type AnthropicTextBlockState = {
  type: "text";
  outputIndex: number;
  block: TextContent;
};

type AnthropicThinkingBlockState = {
  type: "thinking";
  outputIndex: number;
  block: ThinkingContent;
};

type AnthropicToolCallBlockState = {
  type: "toolCall";
  outputIndex: number;
  block: ToolCall;
  partialJson: string;
};

type AnthropicBlockState =
  | AnthropicTextBlockState
  | AnthropicThinkingBlockState
  | AnthropicToolCallBlockState;

export function processAnthropicStream(
  anthropicStream: AsyncIterable<any>,
  output: AssistantMessage,
  stream: ProviderEventSink,
  model: Model<"anthropic-messages">,
  toolCalls: IncrementalToolCallFolder,
  options: {
    isOAuth: boolean;
    tools?: Tool[];
  },
): BrewvaEffect.Effect<void, ProviderStreamError> {
  return BrewvaEffect.gen(function* () {
    const blocks = new Map<number, AnthropicBlockState>();
    let sawMessageStart = false;
    let sawMessageStop = false;

    yield* runAsyncIterableEffect(anthropicStream, (event) =>
      BrewvaEffect.gen(function* () {
        if (event.type === "message_start") {
          sawMessageStart = true;
          output.responseId = event.message.id;
          output.usage.input = event.message.usage.input_tokens || 0;
          output.usage.output = event.message.usage.output_tokens || 0;
          output.usage.cacheRead = event.message.usage.cache_read_input_tokens || 0;
          output.usage.cacheWrite = event.message.usage.cache_creation_input_tokens || 0;
          applyAnthropicUsageTotals(output, model);
          return;
        }

        if (event.type === "content_block_start") {
          if (event.content_block.type === "text") {
            const block: TextContent = {
              type: "text",
              text: "",
            };
            output.content.push(block);
            const outputIndex = output.content.length - 1;
            blocks.set(event.index, { type: "text", outputIndex, block });
            yield* stream.push({
              type: "text_start",
              contentIndex: outputIndex,
              partial: output,
            });
            return;
          }

          if (event.content_block.type === "thinking") {
            const block: ThinkingContent = {
              type: "thinking",
              thinking: "",
              thinkingSignature: "",
            };
            output.content.push(block);
            const outputIndex = output.content.length - 1;
            blocks.set(event.index, { type: "thinking", outputIndex, block });
            yield* stream.push({
              type: "thinking_start",
              contentIndex: outputIndex,
              partial: output,
            });
            return;
          }

          if (event.content_block.type === "redacted_thinking") {
            const block: ThinkingContent = {
              type: "thinking",
              thinking: "[Reasoning redacted]",
              thinkingSignature: event.content_block.data,
              redacted: true,
            };
            output.content.push(block);
            const outputIndex = output.content.length - 1;
            blocks.set(event.index, { type: "thinking", outputIndex, block });
            yield* stream.push({
              type: "thinking_start",
              contentIndex: outputIndex,
              partial: output,
            });
            return;
          }

          if (event.content_block.type === "tool_use") {
            const outputIndex = yield* toolCalls.begin(
              `anthropic:${event.index}`,
              {
                id: event.content_block.id,
                name: options.isOAuth
                  ? fromClaudeCodeName(event.content_block.name, options.tools)
                  : event.content_block.name,
                arguments: (event.content_block.input as Record<string, unknown>) ?? {},
              },
              "",
            );
            const block = output.content[outputIndex];
            if (!block || block.type !== "toolCall") {
              return;
            }
            blocks.set(event.index, {
              type: "toolCall",
              outputIndex,
              block,
              partialJson: "",
            });
          }
          return;
        }

        if (event.type === "content_block_delta") {
          const state = blocks.get(event.index);
          if (!state) {
            return;
          }

          if (event.delta.type === "text_delta" && state.type === "text") {
            state.block.text += event.delta.text;
            yield* stream.push({
              type: "text_delta",
              contentIndex: state.outputIndex,
              delta: event.delta.text,
              partial: output,
            });
            return;
          }

          if (event.delta.type === "thinking_delta" && state.type === "thinking") {
            state.block.thinking += event.delta.thinking;
            const estimatedTokens = event.delta.estimated_tokens;
            if (typeof estimatedTokens === "number" && Number.isFinite(estimatedTokens)) {
              const details = (output.usage.details ??= {});
              details.thoughtsTokens = (details.thoughtsTokens ?? 0) + estimatedTokens;
            }
            yield* stream.push({
              type: "thinking_delta",
              contentIndex: state.outputIndex,
              delta: event.delta.thinking,
              partial: output,
            });
            return;
          }

          if (event.delta.type === "input_json_delta" && state.type === "toolCall") {
            state.partialJson += event.delta.partial_json;
            yield* toolCalls.appendArgumentsDelta(
              `anthropic:${event.index}`,
              event.delta.partial_json,
            );
            return;
          }

          if (event.delta.type === "signature_delta" && state.type === "thinking") {
            state.block.thinkingSignature = state.block.thinkingSignature || "";
            state.block.thinkingSignature += event.delta.signature;
          }
          return;
        }

        if (event.type === "content_block_stop") {
          const state = blocks.get(event.index);
          if (!state) {
            return;
          }
          blocks.delete(event.index);
          if (state.type === "text") {
            yield* stream.push({
              type: "text_end",
              contentIndex: state.outputIndex,
              content: state.block.text,
              partial: output,
            });
            return;
          }
          if (state.type === "thinking") {
            yield* stream.push({
              type: "thinking_end",
              contentIndex: state.outputIndex,
              content: state.block.thinking,
              partial: output,
            });
            return;
          }
          return;
        }

        if (event.type === "message_delta") {
          if (event.delta.stop_reason) {
            output.stopReason = mapAnthropicStopReason(event.delta.stop_reason);
          }
          if (event.usage.input_tokens != null) {
            output.usage.input = event.usage.input_tokens;
          }
          if (event.usage.output_tokens != null) {
            output.usage.output = event.usage.output_tokens;
          }
          if (event.usage.cache_read_input_tokens != null) {
            output.usage.cacheRead = event.usage.cache_read_input_tokens;
          }
          if (event.usage.cache_creation_input_tokens != null) {
            output.usage.cacheWrite = event.usage.cache_creation_input_tokens;
          }
          applyAnthropicUsageTotals(output, model);
        }

        if (event.type === "message_stop") {
          sawMessageStop = true;
        }
      }),
    );

    if (sawMessageStart && !sawMessageStop) {
      return yield* failProviderStream("Anthropic stream ended before message_stop");
    }
    if (sawMessageStop) {
      yield* toolCalls.finalizeAll();
    }
  });
}

export function mapAnthropicStopReason(reason: string): StopReason {
  switch (reason) {
    case "end_turn":
      return "stop";
    case "max_tokens":
      return "length";
    case "tool_use":
      return "toolUse";
    case "refusal":
      return "error";
    case "pause_turn":
      return "stop";
    case "stop_sequence":
      return "stop";
    case "sensitive":
      return "error";
    default:
      throw new Error(`Unhandled stop reason: ${reason}`);
  }
}
