import type { ImageContent, TextContent, ThinkingContent } from "./content.js";
import type { ToolCall } from "./tool.js";

type Content = TextContent | ThinkingContent | ImageContent | ToolCall;

export function isTextContent(content: Content): content is TextContent {
  return content.type === "text";
}

export function isThinkingContent(content: Content): content is ThinkingContent {
  return content.type === "thinking";
}

export function isImageContent(content: Content): content is ImageContent {
  return content.type === "image";
}

export function isToolCallContent(content: Content): content is ToolCall {
  return content.type === "toolCall";
}
