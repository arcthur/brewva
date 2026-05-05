import type {
  ChatCompletionAssistantMessageParam,
  ChatCompletionContentPart,
  ChatCompletionContentPartImage,
  ChatCompletionContentPartText,
  ChatCompletionMessageParam,
  ChatCompletionToolMessageParam,
} from "openai/resources/chat/completions.js";
import {
  isImageContent,
  isTextContent,
  isThinkingContent,
  isToolCallContent,
} from "../../contracts/content-guards.js";
import type {
  Context,
  ImageContent,
  Model,
  ResolvedOpenAICompletionsCompat,
  StreamOptions,
  TextContent,
  ThinkingContent,
  ToolCall,
} from "../../contracts/index.js";
import { sanitizeSurrogates } from "../../utils/sanitize-unicode.js";
import { materializeUserMessageContent } from "../_shared/prompt-content.js";
import { transformMessages } from "../_shared/transform-messages.js";
import {
  readToolImagePayload,
  readToolTextContent,
  setAssistantMessageSignature,
  setAssistantReasoningDetails,
  setToolMessageName,
} from "./wire.js";

export function convertMessages(
  model: Model<"openai-completions">,
  context: Context,
  compat: ResolvedOpenAICompletionsCompat,
  options?: Pick<StreamOptions, "resolveFile">,
): ChatCompletionMessageParam[] {
  const params: ChatCompletionMessageParam[] = [];

  const normalizeToolCallId = (id: string): string => {
    if (id.includes("|")) {
      const [callId] = id.split("|");
      return (callId ?? id).replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40);
    }

    if (model.provider === "openai") return id.length > 40 ? id.slice(0, 40) : id;
    return id;
  };

  const transformedMessages = transformMessages(context.messages, model, (id) =>
    normalizeToolCallId(id),
  );

  if (context.systemPrompt) {
    const useDeveloperRole = model.reasoning && compat.supportsDeveloperRole;
    const role = useDeveloperRole ? "developer" : "system";
    params.push({ role, content: sanitizeSurrogates(context.systemPrompt) });
  }

  let lastRole: string | null = null;

  for (let i = 0; i < transformedMessages.length; i++) {
    const msg = transformedMessages[i];
    if (!msg) {
      continue;
    }
    if (
      compat.requiresAssistantAfterToolResult &&
      lastRole === "toolResult" &&
      msg.role === "user"
    ) {
      params.push({
        role: "assistant",
        content: "I have processed the tool results.",
      });
    }

    if (msg.role === "user") {
      const materializedContent = materializeUserMessageContent(model, msg.content, options);
      const content: ChatCompletionContentPart[] = materializedContent.map(
        (item): ChatCompletionContentPart => {
          if (item.type === "text") {
            return {
              type: "text",
              text: sanitizeSurrogates(item.text),
            } satisfies ChatCompletionContentPartText;
          }
          return {
            type: "image_url",
            image_url: {
              url: `data:${item.mimeType};base64,${item.data}`,
            },
          } satisfies ChatCompletionContentPartImage;
        },
      );
      const filteredContent = !model.input.includes("image")
        ? content.filter((c) => c.type !== "image_url")
        : content;
      if (filteredContent.length === 0) continue;
      params.push({
        role: "user",
        content: filteredContent,
      });
    } else if (msg.role === "assistant") {
      const assistantMsg: ChatCompletionAssistantMessageParam = {
        role: "assistant",
        content: compat.requiresAssistantAfterToolResult ? "" : null,
      };

      const textBlocks = msg.content.filter(isTextContent);
      const nonEmptyTextBlocks = textBlocks.filter((b) => b.text && b.text.trim().length > 0);
      if (nonEmptyTextBlocks.length > 0) {
        assistantMsg.content = nonEmptyTextBlocks.map((b) => sanitizeSurrogates(b.text)).join("");
      }

      const toolCalls = msg.content.filter(isToolCallContent);
      const thinkingBlocks = msg.content.filter(isThinkingContent);
      const nonEmptyThinkingBlocks = thinkingBlocks.filter(
        (b) => b.thinking && b.thinking.trim().length > 0,
      );
      const shouldSerializeThinking =
        nonEmptyThinkingBlocks.length > 0 &&
        (compat.thinkingFormat !== "deepseek" || toolCalls.length > 0);
      if (shouldSerializeThinking) {
        if (compat.requiresThinkingAsText) {
          const thinkingText = nonEmptyThinkingBlocks.map((b) => b.thinking).join("\n\n");
          const textContent = assistantMsg.content as Array<{ type: "text"; text: string }> | null;
          if (textContent) {
            textContent.unshift({ type: "text", text: thinkingText });
          } else {
            assistantMsg.content = [{ type: "text", text: thinkingText }];
          }
        } else {
          const signature = nonEmptyThinkingBlocks[0]?.thinkingSignature;
          if (signature && signature.length > 0) {
            setAssistantMessageSignature(
              assistantMsg,
              signature,
              nonEmptyThinkingBlocks.map((b) => b.thinking).join("\n"),
            );
          }
        }
      }

      if (toolCalls.length > 0) {
        assistantMsg.tool_calls = toolCalls.map((tc) => ({
          id: tc.id,
          type: "function" as const,
          function: {
            name: tc.name,
            arguments: JSON.stringify(tc.arguments),
          },
        }));
        const reasoningDetails = toolCalls
          .filter((tc) => tc.thoughtSignature)
          .map((tc) => {
            try {
              return JSON.parse(tc.thoughtSignature!);
            } catch {
              return null;
            }
          })
          .filter(Boolean);
        if (reasoningDetails.length > 0) {
          setAssistantReasoningDetails(assistantMsg, reasoningDetails);
        }
      }

      const content = assistantMsg.content;
      const hasContent =
        content !== null &&
        content !== undefined &&
        (typeof content === "string" ? content.length > 0 : content.length > 0);
      if (!hasContent && !assistantMsg.tool_calls) {
        continue;
      }
      params.push(assistantMsg);
    } else if (msg.role === "toolResult") {
      const imageBlocks: Array<{ type: "image_url"; image_url: { url: string } }> = [];
      let j = i;

      for (; j < transformedMessages.length; j++) {
        const toolMsg = transformedMessages[j];
        if (!toolMsg || toolMsg.role !== "toolResult") {
          break;
        }

        const textResult = toolMsg.content
          .map(readToolTextContent)
          .filter((value): value is string => typeof value === "string")
          .join("\n");
        const hasImages = toolMsg.content.some(isImageContent);

        const hasText = textResult.length > 0;
        const toolResultMsg: ChatCompletionToolMessageParam = {
          role: "tool",
          content: sanitizeSurrogates(hasText ? textResult : "(see attached image)"),
          tool_call_id: toolMsg.toolCallId,
        };
        if (compat.requiresToolResultName && toolMsg.toolName) {
          setToolMessageName(toolResultMsg, toolMsg.toolName);
        }
        params.push(toolResultMsg);

        if (hasImages && model.input.includes("image")) {
          for (const block of toolMsg.content) {
            if (isImageContent(block)) {
              const imagePayload = readToolImagePayload(block);
              if (!imagePayload) {
                continue;
              }
              imageBlocks.push({
                type: "image_url",
                image_url: {
                  url: `data:${imagePayload.mimeType};base64,${imagePayload.data}`,
                },
              });
            }
          }
        }
      }

      i = j - 1;

      if (imageBlocks.length > 0) {
        if (compat.requiresAssistantAfterToolResult) {
          params.push({
            role: "assistant",
            content: "I have processed the tool results.",
          });
        }

        params.push({
          role: "user",
          content: [
            {
              type: "text",
              text: "Attached image(s) from tool result:",
            },
            ...imageBlocks,
          ],
        });
        lastRole = "user";
      } else {
        lastRole = "toolResult";
      }
      continue;
    }

    lastRole = msg.role;
  }

  return params;
}
