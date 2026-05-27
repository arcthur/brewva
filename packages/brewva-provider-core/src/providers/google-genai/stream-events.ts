import { BrewvaEffect } from "@brewva/brewva-effect/primitives";
import type { GenerateContentResponse } from "@google/genai";
import type {
  AssistantMessage,
  Model,
  ProviderEventSink,
  ProviderStreamError,
  TextContent,
  ThinkingContent,
} from "../../contracts/index.js";
import { failProviderStream, runAsyncIterableEffect } from "../../stream/effect-interop.js";
import type { IncrementalToolCallFolder } from "../../stream/tool-call-folder.js";
import { mapStopReason, retainThoughtSignature } from "../_shared/google/messages.js";
import { applyGoogleUsage } from "../_shared/google/usage.js";

export function processGoogleGenAIStream(
  chunks: AsyncIterable<GenerateContentResponse>,
  output: AssistantMessage,
  stream: ProviderEventSink,
  model: Model<"google-genai">,
  toolCalls: IncrementalToolCallFolder,
): BrewvaEffect.Effect<void, ProviderStreamError> {
  return BrewvaEffect.gen(function* () {
    let hadContent = false;
    let currentTextBlock: TextContent | null = null;
    let currentTextBlockIndex = -1;
    let currentThinkingBlock: ThinkingContent | null = null;
    let currentThinkingBlockIndex = -1;

    const endCurrentTextBlock = () =>
      BrewvaEffect.gen(function* () {
        if (!currentTextBlock) return;
        yield* stream.push({
          type: "text_end",
          contentIndex: currentTextBlockIndex,
          content: currentTextBlock.text,
          partial: output,
        });
        currentTextBlock = null;
        currentTextBlockIndex = -1;
      });

    const endCurrentThinkingBlock = () =>
      BrewvaEffect.gen(function* () {
        if (!currentThinkingBlock) return;
        yield* stream.push({
          type: "thinking_end",
          contentIndex: currentThinkingBlockIndex,
          content: currentThinkingBlock.thinking,
          partial: output,
        });
        currentThinkingBlock = null;
        currentThinkingBlockIndex = -1;
      });

    yield* runAsyncIterableEffect(chunks, (chunk) =>
      BrewvaEffect.gen(function* () {
        const candidate = chunk.candidates?.[0];
        const parts = candidate?.content?.parts ?? [];

        if (chunk.usageMetadata) {
          applyGoogleUsage(output, model, chunk.usageMetadata);
        }
        if (chunk.responseId) {
          output.responseId = chunk.responseId;
        }

        for (const part of parts) {
          if (part.text) {
            hadContent = true;
            if (part.thought) {
              yield* endCurrentTextBlock();
              if (!currentThinkingBlock) {
                currentThinkingBlock = {
                  type: "thinking",
                  thinking: "",
                  thinkingSignature: part.thoughtSignature,
                };
                output.content.push(currentThinkingBlock);
                currentThinkingBlockIndex = output.content.length - 1;
                yield* stream.push({
                  type: "thinking_start",
                  contentIndex: currentThinkingBlockIndex,
                  partial: output,
                });
              } else {
                currentThinkingBlock.thinkingSignature = retainThoughtSignature(
                  currentThinkingBlock.thinkingSignature,
                  part.thoughtSignature,
                );
              }
              currentThinkingBlock.thinking += part.text;
              yield* stream.push({
                type: "thinking_delta",
                contentIndex: currentThinkingBlockIndex,
                delta: part.text,
                partial: output,
              });
            } else {
              yield* endCurrentThinkingBlock();
              if (!currentTextBlock) {
                currentTextBlock = { type: "text", text: "" };
                output.content.push(currentTextBlock);
                currentTextBlockIndex = output.content.length - 1;
                yield* stream.push({
                  type: "text_start",
                  contentIndex: currentTextBlockIndex,
                  partial: output,
                });
              }
              currentTextBlock.text += part.text;
              yield* stream.push({
                type: "text_delta",
                contentIndex: currentTextBlockIndex,
                delta: part.text,
                partial: output,
              });
            }
          }

          if (part.functionCall) {
            hadContent = true;
            output.stopReason = "toolUse";
            yield* endCurrentTextBlock();
            yield* endCurrentThinkingBlock();
            const name = part.functionCall.name ?? part.functionCall.id ?? "function_call";
            const id = part.functionCall.id ?? name;
            yield* toolCalls.pushAtomic(
              {
                type: "toolCall",
                id,
                name,
                arguments: part.functionCall.args || {},
                ...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {}),
              },
              id,
            );
          }
        }

        if (candidate?.finishReason) {
          const stopReason = mapStopReason(candidate.finishReason);
          output.stopReason = output.stopReason === "toolUse" ? "toolUse" : stopReason;
        }
      }),
    );

    yield* endCurrentTextBlock();
    yield* endCurrentThinkingBlock();

    if (!hadContent) {
      return yield* failProviderStream("Empty Google GenAI response");
    }
  });
}
