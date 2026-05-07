import type {
  AssistantMessage,
  ProviderEventSink,
  Model,
  TextContent,
  ThinkingContent,
} from "../../contracts/index.js";
import type { IncrementalToolCallFolder } from "../../stream/tool-call-folder.js";
import type { CloudCodeAssistResponseChunk } from "./contract.js";
import { mapStopReasonString, retainThoughtSignature } from "./shared.js";
import { applyGoogleGeminiCliUsage } from "./usage.js";

export async function processGoogleGeminiCliSseStream(
  chunks: AsyncIterable<CloudCodeAssistResponseChunk>,
  output: AssistantMessage,
  stream: ProviderEventSink,
  model: Model<"google-gemini-cli">,
  toolCalls: IncrementalToolCallFolder,
): Promise<void> {
  let hadContent = false;
  let currentTextBlock: TextContent | null = null;
  let currentTextBlockIndex = -1;
  let currentThinkingBlock: ThinkingContent | null = null;
  let currentThinkingBlockIndex = -1;

  const endCurrentTextBlock = async () => {
    if (!currentTextBlock) return;
    await stream.push({
      type: "text_end",
      contentIndex: currentTextBlockIndex,
      content: currentTextBlock.text,
      partial: output,
    });
    currentTextBlock = null;
    currentTextBlockIndex = -1;
  };

  const endCurrentThinkingBlock = async () => {
    if (!currentThinkingBlock) return;
    await stream.push({
      type: "thinking_end",
      contentIndex: currentThinkingBlockIndex,
      content: currentThinkingBlock.thinking,
      partial: output,
    });
    currentThinkingBlock = null;
    currentThinkingBlockIndex = -1;
  };

  for await (const chunk of chunks) {
    const candidate = chunk.response?.candidates?.[0];
    const parts = candidate?.content?.parts ?? [];
    const usageMetadata = chunk.response?.usageMetadata;

    if (usageMetadata) {
      applyGoogleGeminiCliUsage(output, model, usageMetadata);
    }
    if (chunk.response?.responseId) {
      output.responseId = chunk.response.responseId;
    }

    for (const part of parts) {
      if (part.text) {
        hadContent = true;
        if (part.thought) {
          await endCurrentTextBlock();
          if (!currentThinkingBlock) {
            currentThinkingBlock = {
              type: "thinking",
              thinking: "",
              thinkingSignature: part.thoughtSignature,
            };
            output.content.push(currentThinkingBlock);
            currentThinkingBlockIndex = output.content.length - 1;
            await stream.push({
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
          await stream.push({
            type: "thinking_delta",
            contentIndex: currentThinkingBlockIndex,
            delta: part.text,
            partial: output,
          });
        } else {
          await endCurrentThinkingBlock();
          if (!currentTextBlock) {
            currentTextBlock = { type: "text", text: "" };
            output.content.push(currentTextBlock);
            currentTextBlockIndex = output.content.length - 1;
            await stream.push({
              type: "text_start",
              contentIndex: currentTextBlockIndex,
              partial: output,
            });
          }
          currentTextBlock.text += part.text;
          await stream.push({
            type: "text_delta",
            contentIndex: currentTextBlockIndex,
            delta: part.text,
            partial: output,
          });
        }
      }

      if (part.functionCall) {
        hadContent = true;
        await endCurrentTextBlock();
        await endCurrentThinkingBlock();
        const key = part.functionCall.id || part.functionCall.name;
        await toolCalls.pushAtomic(
          {
            type: "toolCall",
            id: part.functionCall.id || part.functionCall.name,
            name: part.functionCall.name,
            arguments: part.functionCall.args || {},
            ...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {}),
          },
          key,
        );
      }
    }

    if (candidate?.finishReason) {
      output.stopReason = mapStopReasonString(candidate.finishReason);
    }
  }

  await endCurrentTextBlock();
  await endCurrentThinkingBlock();

  if (!hadContent) {
    throw new Error("Empty SSE response");
  }
}
