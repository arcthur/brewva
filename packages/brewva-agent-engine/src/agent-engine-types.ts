import type {
  ProviderCachePolicy,
  ProviderCacheRenderResult,
  ProviderPayloadMetadata,
} from "@brewva/brewva-provider-core";
import type {
  BrewvaRegisteredModel,
  BrewvaResolvedRequestAuth,
  ToolExecutionPhase,
} from "@brewva/brewva-substrate";
import type { TSchema } from "@sinclair/typebox";

type BrewvaAgentEngineApi = BrewvaRegisteredModel["api"];

export type BrewvaAgentEngineThinkingLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh";

export interface BrewvaAgentEngineThinkingBudgets {
  minimal?: number;
  low?: number;
  medium?: number;
  high?: number;
}

export type BrewvaAgentEngineTransport = "sse" | "websocket" | "auto";

export type BrewvaAgentEngineCachePolicy = ProviderCachePolicy;
export type BrewvaAgentEngineCacheRenderResult = ProviderCacheRenderResult;
export type BrewvaAgentEnginePayloadMetadata = ProviderPayloadMetadata;

export interface BrewvaAgentEngineTextContent {
  type: "text";
  text: string;
  textSignature?: string;
}

export interface BrewvaAgentEngineThinkingContent {
  type: "thinking";
  thinking: string;
  thinkingSignature?: string;
  redacted?: boolean;
}

export interface BrewvaAgentEngineImageContent {
  type: "image";
  data: string;
  mimeType: string;
}

export interface BrewvaAgentEngineFileContent {
  type: "file";
  uri: string;
  name?: string;
  mimeType?: string;
  displayText?: string;
}

export interface BrewvaAgentEngineMessageVisibility {
  display?: boolean;
  excludeFromContext?: boolean;
  details?: unknown;
}

export interface BrewvaAgentEngineToolCall {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  thoughtSignature?: string;
}

export interface BrewvaAgentEngineUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
}

export type BrewvaAgentEngineStopReason = "stop" | "length" | "toolUse" | "error" | "aborted";
export type BrewvaAgentEngineSteerDropReason =
  | "aborted"
  | "failed"
  | "no_tool_boundary"
  | "overwritten";

export interface BrewvaAgentEngineUserMessage extends BrewvaAgentEngineMessageVisibility {
  role: "user";
  content: Array<
    BrewvaAgentEngineTextContent | BrewvaAgentEngineImageContent | BrewvaAgentEngineFileContent
  >;
  timestamp: number;
}

export interface BrewvaAgentEngineAssistantMessage extends BrewvaAgentEngineMessageVisibility {
  role: "assistant";
  content: Array<
    BrewvaAgentEngineTextContent | BrewvaAgentEngineThinkingContent | BrewvaAgentEngineToolCall
  >;
  api: BrewvaAgentEngineApi;
  provider: string;
  model: string;
  responseId?: string;
  usage: BrewvaAgentEngineUsage;
  stopReason: BrewvaAgentEngineStopReason;
  errorMessage?: string;
  timestamp: number;
}

export interface BrewvaAgentEngineToolResultMessage<TDetails = unknown> extends Omit<
  BrewvaAgentEngineMessageVisibility,
  "details"
> {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: Array<BrewvaAgentEngineTextContent | BrewvaAgentEngineImageContent>;
  details?: TDetails;
  isError: boolean;
  timestamp: number;
}

export interface BrewvaAgentEngineCustomMessage<TDetails = unknown> extends Omit<
  BrewvaAgentEngineMessageVisibility,
  "display" | "details"
> {
  role: "custom";
  customType: string;
  content: string | Array<BrewvaAgentEngineTextContent | BrewvaAgentEngineImageContent>;
  display: boolean;
  details?: TDetails;
  timestamp: number;
}

export interface BrewvaAgentEngineBranchSummaryMessage extends BrewvaAgentEngineMessageVisibility {
  role: "branchSummary";
  summary: string;
  fromId: string;
  timestamp: number;
}

export interface BrewvaAgentEngineCompactionSummaryMessage extends BrewvaAgentEngineMessageVisibility {
  role: "compactionSummary";
  summary: string;
  tokensBefore: number;
  timestamp: number;
}

export type BrewvaAgentEngineMessage =
  | BrewvaAgentEngineUserMessage
  | BrewvaAgentEngineAssistantMessage
  | BrewvaAgentEngineToolResultMessage
  | BrewvaAgentEngineCustomMessage
  | BrewvaAgentEngineBranchSummaryMessage
  | BrewvaAgentEngineCompactionSummaryMessage;

export type BrewvaAgentEngineLlmMessage =
  | BrewvaAgentEngineUserMessage
  | BrewvaAgentEngineAssistantMessage
  | BrewvaAgentEngineToolResultMessage;

export interface BrewvaAgentEngineToolResult<TDetails = unknown> {
  content: Array<BrewvaAgentEngineTextContent | BrewvaAgentEngineImageContent>;
  details: TDetails;
  isError?: boolean;
}

export type BrewvaAgentEngineToolUpdateCallback<TDetails = unknown> = (
  partialResult: BrewvaAgentEngineToolResult<TDetails>,
) => void;

export interface BrewvaAgentEngineTool {
  name: string;
  label: string;
  description: string;
  parameters: TSchema;
  prepareArguments?: (args: unknown) => unknown;
  execute(
    toolCallId: string,
    params: unknown,
    signal?: AbortSignal,
    onUpdate?: BrewvaAgentEngineToolUpdateCallback,
  ): Promise<BrewvaAgentEngineToolResult>;
}

export interface BrewvaAgentEngineContext {
  systemPrompt: string;
  messages: BrewvaAgentEngineMessage[];
  tools?: BrewvaAgentEngineTool[];
}

export interface BrewvaAgentEngineBeforeToolCallContext {
  assistantMessage: BrewvaAgentEngineAssistantMessage;
  toolCall: BrewvaAgentEngineToolCall;
  args: unknown;
  context: BrewvaAgentEngineContext;
}

export interface BrewvaAgentEngineAfterToolCallContext {
  assistantMessage: BrewvaAgentEngineAssistantMessage;
  toolCall: BrewvaAgentEngineToolCall;
  args: unknown;
  result: BrewvaAgentEngineToolResult;
  isError: boolean;
  context: BrewvaAgentEngineContext;
}

export type BrewvaAgentEngineAssistantMessageEvent =
  | { type: "start"; partial: BrewvaAgentEngineAssistantMessage }
  | { type: "text_start"; contentIndex: number; partial: BrewvaAgentEngineAssistantMessage }
  | {
      type: "text_delta";
      contentIndex: number;
      delta: string;
      partial: BrewvaAgentEngineAssistantMessage;
    }
  | {
      type: "text_end";
      contentIndex: number;
      content: string;
      partial: BrewvaAgentEngineAssistantMessage;
    }
  | { type: "thinking_start"; contentIndex: number; partial: BrewvaAgentEngineAssistantMessage }
  | {
      type: "thinking_delta";
      contentIndex: number;
      delta: string;
      partial: BrewvaAgentEngineAssistantMessage;
    }
  | {
      type: "thinking_end";
      contentIndex: number;
      content: string;
      partial: BrewvaAgentEngineAssistantMessage;
    }
  | { type: "toolcall_start"; contentIndex: number; partial: BrewvaAgentEngineAssistantMessage }
  | {
      type: "toolcall_delta";
      contentIndex: number;
      delta: string;
      partial: BrewvaAgentEngineAssistantMessage;
    }
  | {
      type: "toolcall_end";
      contentIndex: number;
      toolCall: BrewvaAgentEngineToolCall;
      partial: BrewvaAgentEngineAssistantMessage;
    }
  | {
      type: "done";
      reason: Extract<BrewvaAgentEngineStopReason, "stop" | "length" | "toolUse">;
      message: BrewvaAgentEngineAssistantMessage;
    }
  | {
      type: "error";
      reason: Extract<BrewvaAgentEngineStopReason, "aborted" | "error">;
      error: BrewvaAgentEngineAssistantMessage;
    };

export type BrewvaAgentEngineEvent =
  | { type: "agent_start" }
  | { type: "agent_end"; messages: BrewvaAgentEngineMessage[] }
  | { type: "turn_start" }
  | {
      type: "turn_end";
      message: BrewvaAgentEngineMessage;
      toolResults: BrewvaAgentEngineToolResultMessage[];
    }
  | { type: "message_start"; message: BrewvaAgentEngineMessage }
  | {
      type: "message_update";
      message: BrewvaAgentEngineMessage;
      assistantMessageEvent: BrewvaAgentEngineAssistantMessageEvent;
    }
  | { type: "message_end"; message: BrewvaAgentEngineMessage }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: unknown }
  | {
      type: "tool_execution_update";
      toolCallId: string;
      toolName: string;
      args: unknown;
      partialResult: unknown;
    }
  | {
      type: "tool_execution_end";
      toolCallId: string;
      toolName: string;
      result: unknown;
      isError: boolean;
    }
  | {
      type: "tool_execution_phase_change";
      toolCallId: string;
      toolName: string;
      phase: ToolExecutionPhase;
      previousPhase?: ToolExecutionPhase;
      args?: unknown;
    }
  | {
      type: "steer_applied";
      text: string;
      toolCallId: string;
      toolName: string;
      message: BrewvaAgentEngineToolResultMessage;
    }
  | {
      type: "steer_dropped";
      text: string;
      reason: BrewvaAgentEngineSteerDropReason;
    };

export interface BrewvaAgentEngine {
  readonly state: {
    model: { provider: string; id: string };
    thinkingLevel: string;
    isStreaming: boolean;
    systemPrompt: string;
    tools: Array<{ name: string }>;
  };
  readonly signal: AbortSignal | undefined;
  subscribe(
    listener: (
      event: BrewvaAgentEngineEvent,
    ) => Promise<BrewvaAgentEngineEvent | void> | BrewvaAgentEngineEvent | void,
  ): () => void;
  prompt(message: BrewvaAgentEngineMessage | BrewvaAgentEngineMessage[]): Promise<void>;
  waitForIdle(): Promise<void>;
  setModel(model: unknown): void;
  setThinkingLevel(level: BrewvaAgentEngineThinkingLevel): void;
  replaceMessages(messages: BrewvaAgentEngineMessage[]): void;
  abort(): void;
  setTools(tools: BrewvaAgentEngineTool[]): void;
  setSystemPrompt(prompt: string): void;
  followUp(message: BrewvaAgentEngineMessage): void;
  queue(message: BrewvaAgentEngineMessage): void;
  removeQueuedMessage(message: BrewvaAgentEngineMessage, queue: "queue" | "followUp"): boolean;
  steer(text: string): boolean;
  hasPendingSteer(): boolean;
  appendMessage(message: BrewvaAgentEngineMessage): void;
  hasQueuedMessages(): boolean;
}

export interface BrewvaAgentEngineStreamContext {
  systemPrompt?: string;
  messages: BrewvaAgentEngineLlmMessage[];
  tools?: Array<Pick<BrewvaAgentEngineTool, "name" | "description" | "parameters">>;
}

export interface BrewvaAgentEngineStreamOptions {
  reasoning?: BrewvaAgentEngineThinkingLevel;
  signal?: AbortSignal;
  apiKey?: string;
  transport?: BrewvaAgentEngineTransport;
  sessionId?: string;
  cachePolicy?: BrewvaAgentEngineCachePolicy;
  onCacheRender?: (
    render: BrewvaAgentEngineCacheRenderResult,
    model: BrewvaRegisteredModel,
  ) => void | Promise<void>;
  onPayload?: (
    payload: unknown,
    model: BrewvaRegisteredModel,
    metadata?: BrewvaAgentEnginePayloadMetadata,
  ) => Promise<unknown>;
  headers?: Record<string, string>;
  maxRetryDelayMs?: number;
  thinkingBudgets?: BrewvaAgentEngineThinkingBudgets;
  resolveFile?: (part: BrewvaAgentEngineFileContent, model: BrewvaRegisteredModel) => unknown;
}

export type BrewvaAgentEngineStopAfterToolResults = (
  toolResults: BrewvaAgentEngineToolResultMessage[],
) => boolean | Promise<boolean>;

export interface BrewvaAssistantMessageEventStream extends AsyncIterable<BrewvaAgentEngineAssistantMessageEvent> {
  result(): Promise<BrewvaAgentEngineAssistantMessage>;
}

export type BrewvaAgentEngineResolveRequestAuth = (
  model: BrewvaRegisteredModel,
) => Promise<BrewvaResolvedRequestAuth> | BrewvaResolvedRequestAuth;

export type BrewvaAgentEngineStreamFunction = (
  model: BrewvaRegisteredModel,
  context: BrewvaAgentEngineStreamContext,
  options: BrewvaAgentEngineStreamOptions,
) => BrewvaAssistantMessageEventStream | Promise<BrewvaAssistantMessageEventStream>;
