import type { Api, Provider } from "./api.js";
import type { FileContent, ImageContent, TextContent, ThinkingContent } from "./content.js";
import type { ToolCall } from "./tool.js";

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  details?: {
    promptTokens?: number;
    candidateTokens?: number;
    thoughtsTokens?: number;
    toolUsePromptTokens?: number;
    cachedContentTokens?: number;
  };
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
}

export type StopReason = "stop" | "length" | "toolUse" | "error" | "aborted";

export interface UserMessage {
  role: "user";
  content: Array<TextContent | ImageContent | FileContent>;
  timestamp: number;
}

export interface AssistantMessage {
  role: "assistant";
  content: Array<TextContent | ThinkingContent | ToolCall>;
  api: Api;
  provider: Provider;
  model: string;
  responseModel?: string;
  responseId?: string;
  usage: Usage;
  stopReason: StopReason;
  errorMessage?: string;
  timestamp: number;
}

export interface ToolResultMessage<TDetails = unknown> {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: Array<TextContent | ImageContent>;
  details?: TDetails;
  isError: boolean;
  timestamp: number;
}

export type Message = UserMessage | AssistantMessage | ToolResultMessage;
