import type {
  ContentBlockParam,
  MessageCreateParamsStreaming,
  MessageParam,
} from "@anthropic-ai/sdk/resources/messages.js";
import type {
  ImageContent,
  Message,
  Model,
  StreamOptions,
  TextContent,
  ThinkingContent,
  ToolResultMessage,
} from "../../contracts/index.js";
import { sanitizeSurrogates } from "../../utils/sanitize-unicode.js";
import {
  buildAnthropicDocumentBlock,
  materializeResolvedUserMessageContentPart,
  resolveUserMessageContent,
} from "../_shared/prompt-content.js";
import { transformMessages } from "../_shared/transform-messages.js";
import { toClaudeCodeName } from "./compat.js";
import type { AnthropicCacheControl, AnthropicCacheControlAllocator } from "./contract.js";

export function convertContentBlocks(content: (TextContent | ImageContent)[]):
  | string
  | Array<
      | { type: "text"; text: string }
      | {
          type: "image";
          source: {
            type: "base64";
            media_type: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
            data: string;
          };
        }
    > {
  const hasImages = content.some((c) => c.type === "image");
  if (!hasImages) {
    return sanitizeSurrogates(content.map((c) => (c as TextContent).text).join("\n"));
  }

  const blocks = content.map((block) => {
    if (block.type === "text") {
      return {
        type: "text" as const,
        text: sanitizeSurrogates(block.text),
      };
    }
    return {
      type: "image" as const,
      source: {
        type: "base64" as const,
        media_type: block.mimeType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
        data: block.data,
      },
    };
  });

  const hasText = blocks.some((b) => b.type === "text");
  if (!hasText) {
    blocks.unshift({
      type: "text" as const,
      text: "(see attached image)",
    });
  }

  return blocks;
}

export function normalizeToolCallId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
}

export function convertMessages(
  messages: Message[],
  model: Model<"anthropic-messages">,
  isOAuthToken: boolean,
  cacheControlAllocator?: AnthropicCacheControlAllocator,
  options?: Pick<StreamOptions, "resolveFile">,
): MessageParam[] {
  const params: MessageParam[] = [];
  const transformedMessages = transformMessages(messages, model, normalizeToolCallId);

  for (let i = 0; i < transformedMessages.length; i++) {
    const msg = transformedMessages[i];
    if (!msg) {
      continue;
    }

    if (msg.role === "user") {
      const blocks: ContentBlockParam[] = [];
      for (const item of resolveUserMessageContent(model, msg.content, options)) {
        if (item.type === "text") {
          blocks.push({
            type: "text",
            text: sanitizeSurrogates(item.text),
          });
          continue;
        }
        if (item.type === "image") {
          blocks.push({
            type: "image",
            source: {
              type: "base64",
              media_type: item.mimeType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
              data: item.data,
            },
          });
          continue;
        }
        const documentBlock = buildAnthropicDocumentBlock(item);
        if (documentBlock) {
          blocks.push(documentBlock);
          continue;
        }
        for (const materialized of materializeResolvedUserMessageContentPart(model, item)) {
          if (materialized.type === "text") {
            blocks.push({
              type: "text",
              text: sanitizeSurrogates(materialized.text),
            });
            continue;
          }
          blocks.push({
            type: "image",
            source: {
              type: "base64",
              media_type: materialized.mimeType as
                | "image/jpeg"
                | "image/png"
                | "image/gif"
                | "image/webp",
              data: materialized.data,
            },
          });
        }
      }
      let filteredBlocks = !model.input.includes("image")
        ? blocks.filter((b) => b.type !== "image")
        : blocks;
      filteredBlocks = filteredBlocks.filter((b) => {
        if (b.type === "text") {
          return b.text.trim().length > 0;
        }
        return true;
      });
      if (filteredBlocks.length === 0) continue;
      params.push({
        role: "user",
        content: filteredBlocks,
      });
    } else if (msg.role === "assistant") {
      const blocks: ContentBlockParam[] = [];

      for (const block of msg.content) {
        if (block.type === "text") {
          if (block.text.trim().length === 0) continue;
          blocks.push({
            type: "text",
            text: sanitizeSurrogates(block.text),
          });
        } else if (block.type === "thinking") {
          if (block.redacted) {
            blocks.push({
              type: "redacted_thinking",
              data: block.thinkingSignature!,
            });
            continue;
          }
          if (block.thinking.trim().length === 0) continue;
          if (!block.thinkingSignature || block.thinkingSignature.trim().length === 0) {
            blocks.push({
              type: "text",
              text: sanitizeSurrogates(block.thinking),
            });
          } else {
            blocks.push({
              type: "thinking",
              thinking: sanitizeSurrogates(block.thinking),
              signature: block.thinkingSignature,
            });
          }
        } else if (block.type === "toolCall") {
          blocks.push({
            type: "tool_use",
            id: block.id,
            name: isOAuthToken ? toClaudeCodeName(block.name) : block.name,
            input: block.arguments ?? {},
          });
        }
      }
      if (blocks.length === 0) continue;
      params.push({
        role: "assistant",
        content: blocks,
      });
    } else if (msg.role === "toolResult") {
      const toolResults: ContentBlockParam[] = [];

      toolResults.push({
        type: "tool_result",
        tool_use_id: msg.toolCallId,
        content: convertContentBlocks(msg.content),
        is_error: msg.isError,
      });

      let j = i + 1;
      while (j < transformedMessages.length) {
        const nextMsg = transformedMessages[j];
        if (!nextMsg || nextMsg.role !== "toolResult") {
          break;
        }
        toolResults.push({
          type: "tool_result",
          tool_use_id: nextMsg.toolCallId,
          content: convertContentBlocks(nextMsg.content),
          is_error: nextMsg.isError,
        });
        j++;
      }

      i = j - 1;
      params.push({
        role: "user",
        content: toolResults,
      });
    }
  }

  applyMessageCacheBreakpoints(params, cacheControlAllocator);
  return params;
}

export function createAnthropicCacheControlAllocator(
  cacheControl: AnthropicCacheControl | undefined,
  maxBreakpoints = 4,
): AnthropicCacheControlAllocator {
  let used = 0;
  return {
    claim() {
      if (!cacheControl || used >= maxBreakpoints) {
        return undefined;
      }
      used += 1;
      return cacheControl;
    },
    remaining() {
      return Math.max(0, maxBreakpoints - used);
    },
  };
}

export function applySystemCacheBreakpoint(
  system: MessageCreateParamsStreaming["system"] | undefined,
  allocator: AnthropicCacheControlAllocator,
): void {
  if (!Array.isArray(system) || system.length === 0) {
    return;
  }
  const cacheControl = allocator.claim();
  if (!cacheControl) {
    return;
  }
  const lastBlock = system[system.length - 1];
  if (lastBlock?.type === "text") {
    (lastBlock as typeof lastBlock & { cache_control?: AnthropicCacheControl }).cache_control =
      cacheControl;
  }
}

export function applyMessageCacheBreakpoints(
  messages: MessageParam[],
  allocator: AnthropicCacheControlAllocator | undefined,
): void {
  if (!allocator || allocator.remaining() <= 0) {
    return;
  }
  const userMessageIndexes = messages
    .map((message, index) => (message.role === "user" ? index : -1))
    .filter((index) => index >= 0);
  if (userMessageIndexes.length === 0) {
    return;
  }

  const currentUserIndex = userMessageIndexes[userMessageIndexes.length - 1];
  const previousUserIndex =
    userMessageIndexes.length > 1 ? userMessageIndexes[userMessageIndexes.length - 2] : undefined;
  if (currentUserIndex === undefined) {
    return;
  }

  if (previousUserIndex !== undefined) {
    applyCacheControlToMessageBlock(messages[previousUserIndex], "last", allocator);
  }
  applyCacheControlToMessageBlock(messages[currentUserIndex], "first", allocator);
  if (allocator.remaining() > 0) {
    applyCacheControlToMessageBlock(messages[currentUserIndex], "last", allocator);
  }
}

function applyCacheControlToMessageBlock(
  message: MessageParam | undefined,
  position: "first" | "last",
  allocator: AnthropicCacheControlAllocator,
): void {
  if (!message || message.role !== "user") {
    return;
  }
  if (typeof message.content === "string") {
    const cacheControl = allocator.claim();
    if (!cacheControl) {
      return;
    }
    message.content = [
      {
        type: "text",
        text: message.content,
        cache_control: cacheControl,
      },
    ];
    return;
  }
  if (!Array.isArray(message.content) || message.content.length === 0) {
    return;
  }
  const indexes =
    position === "first"
      ? message.content.map((_, index) => index)
      : message.content.map((_, index) => index).reverse();
  for (const index of indexes) {
    const block = message.content[index];
    if (!isCacheControlEligibleBlock(block)) {
      continue;
    }
    if ((block as { cache_control?: unknown }).cache_control) {
      return;
    }
    const cacheControl = allocator.claim();
    if (!cacheControl) {
      return;
    }
    (block as typeof block & { cache_control?: AnthropicCacheControl }).cache_control =
      cacheControl;
    return;
  }
}

function isCacheControlEligibleBlock(block: ContentBlockParam | undefined): boolean {
  if (!block) {
    return false;
  }
  return block.type === "text" || block.type === "image" || block.type === "tool_result";
}
