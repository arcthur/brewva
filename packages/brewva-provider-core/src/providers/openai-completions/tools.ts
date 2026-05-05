import type OpenAI from "openai";
import type { Message, ResolvedOpenAICompletionsCompat, Tool } from "../../contracts/index.js";

export function hasToolHistory(messages: Message[]): boolean {
  for (const message of messages) {
    if (message.role === "assistant") {
      for (const content of message.content) {
        if (content.type === "toolCall") {
          return true;
        }
      }
    } else if (message.role === "toolResult") {
      return true;
    }
  }
  return false;
}

export function convertTools(
  tools: Tool[],
  compat: ResolvedOpenAICompletionsCompat,
): OpenAI.Chat.Completions.ChatCompletionTool[] {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters as Record<string, unknown>,
      ...(compat.supportsStrictMode ? { strict: true } : {}),
    },
  }));
}
