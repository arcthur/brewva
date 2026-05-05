import type {
  AssistantMessageEventOf,
  ProviderCachePolicy,
  ProviderCacheRenderResult,
  ProviderPayloadMetadata,
  ResolvedFileContent,
} from "@brewva/brewva-provider-core/contracts";
import type { TSchema } from "@sinclair/typebox";
import type { BrewvaRegisteredModel, BrewvaResolvedRequestAuth } from "../contracts/provider.js";
import type { BrewvaThinkingLevel } from "../contracts/thinking.js";
import type { ToolExecutionPhase } from "../execution/tool-phase.js";

type BrewvaTurnLoopApi = BrewvaRegisteredModel["api"];

export type BrewvaTurnLoopThinkingLevel = BrewvaThinkingLevel;

export interface BrewvaTurnLoopThinkingBudgets {
  minimal?: number;
  low?: number;
  medium?: number;
  high?: number;
}

export type BrewvaTurnLoopTransport = "sse" | "websocket" | "auto";

export interface BrewvaTurnLoopTextContent {
  type: "text";
  text: string;
  textSignature?: string;
}

export interface BrewvaTurnLoopThinkingContent {
  type: "thinking";
  thinking: string;
  thinkingSignature?: string;
  redacted?: boolean;
}

export interface BrewvaTurnLoopImageContent {
  type: "image";
  data: string;
  mimeType: string;
}

export interface BrewvaTurnLoopFileContent {
  type: "file";
  uri: string;
  name?: string;
  mimeType?: string;
  displayText?: string;
}

export interface BrewvaTurnLoopMessageVisibility {
  display?: boolean;
  excludeFromContext?: boolean;
  details?: unknown;
}

export interface BrewvaTurnLoopToolCall {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  thoughtSignature?: string;
}

export interface BrewvaTurnLoopUsage {
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

export type BrewvaTurnLoopStopReason = "stop" | "length" | "toolUse" | "error" | "aborted";
export type BrewvaTurnLoopSteerDropReason =
  | "aborted"
  | "failed"
  | "no_tool_boundary"
  | "overwritten";

export interface BrewvaTurnLoopUserMessage extends BrewvaTurnLoopMessageVisibility {
  role: "user";
  content: Array<
    BrewvaTurnLoopTextContent | BrewvaTurnLoopImageContent | BrewvaTurnLoopFileContent
  >;
  timestamp: number;
}

export interface BrewvaTurnLoopAssistantMessage extends BrewvaTurnLoopMessageVisibility {
  role: "assistant";
  content: Array<
    BrewvaTurnLoopTextContent | BrewvaTurnLoopThinkingContent | BrewvaTurnLoopToolCall
  >;
  api: BrewvaTurnLoopApi;
  provider: string;
  model: string;
  responseId?: string;
  usage: BrewvaTurnLoopUsage;
  stopReason: BrewvaTurnLoopStopReason;
  errorMessage?: string;
  timestamp: number;
}

export interface BrewvaTurnLoopToolResultMessage<TDetails = unknown> extends Omit<
  BrewvaTurnLoopMessageVisibility,
  "details"
> {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: Array<BrewvaTurnLoopTextContent | BrewvaTurnLoopImageContent>;
  details?: TDetails;
  isError: boolean;
  timestamp: number;
}

export interface BrewvaTurnLoopCustomMessage<TDetails = unknown> extends Omit<
  BrewvaTurnLoopMessageVisibility,
  "display" | "details"
> {
  role: "custom";
  customType: string;
  content: string | Array<BrewvaTurnLoopTextContent | BrewvaTurnLoopImageContent>;
  display: boolean;
  details?: TDetails;
  timestamp: number;
}

export interface BrewvaTurnLoopBranchSummaryMessage extends BrewvaTurnLoopMessageVisibility {
  role: "branchSummary";
  summary: string;
  fromId: string;
  timestamp: number;
}

export interface BrewvaTurnLoopCompactionSummaryMessage extends BrewvaTurnLoopMessageVisibility {
  role: "compactionSummary";
  summary: string;
  tokensBefore: number;
  timestamp: number;
}

export type BrewvaTurnLoopMessage =
  | BrewvaTurnLoopUserMessage
  | BrewvaTurnLoopAssistantMessage
  | BrewvaTurnLoopToolResultMessage
  | BrewvaTurnLoopCustomMessage
  | BrewvaTurnLoopBranchSummaryMessage
  | BrewvaTurnLoopCompactionSummaryMessage;

export type BrewvaTurnLoopLlmMessage =
  | BrewvaTurnLoopUserMessage
  | BrewvaTurnLoopAssistantMessage
  | BrewvaTurnLoopToolResultMessage;

export interface BrewvaTurnLoopToolResult<TDetails = unknown> {
  content: Array<BrewvaTurnLoopTextContent | BrewvaTurnLoopImageContent>;
  details: TDetails;
  isError?: boolean;
}

export type BrewvaTurnLoopToolUpdateCallback<TDetails = unknown> = (
  partialResult: BrewvaTurnLoopToolResult<TDetails>,
) => void;

export interface BrewvaTurnLoopTool {
  name: string;
  label: string;
  description: string;
  parameters: TSchema;
  prepareArguments?: (args: unknown) => unknown;
  execute(
    toolCallId: string,
    params: unknown,
    signal?: AbortSignal,
    onUpdate?: BrewvaTurnLoopToolUpdateCallback,
  ): Promise<BrewvaTurnLoopToolResult>;
}

export interface BrewvaTurnLoopContext {
  systemPrompt: string;
  messages: BrewvaTurnLoopMessage[];
  tools: BrewvaTurnLoopTool[];
}

export interface BrewvaTurnLoopBeforeToolCallContext {
  assistantMessage: BrewvaTurnLoopAssistantMessage;
  toolCall: BrewvaTurnLoopToolCall;
  args: unknown;
  context: BrewvaTurnLoopContext;
}

export interface BrewvaTurnLoopAfterToolCallContext {
  assistantMessage: BrewvaTurnLoopAssistantMessage;
  toolCall: BrewvaTurnLoopToolCall;
  args: unknown;
  result: BrewvaTurnLoopToolResult;
  isError: boolean;
  context: BrewvaTurnLoopContext;
}

export type BrewvaTurnLoopAssistantMessageEvent = AssistantMessageEventOf<
  BrewvaTurnLoopAssistantMessage,
  BrewvaTurnLoopToolCall,
  BrewvaTurnLoopStopReason
>;

export type BrewvaTurnLoopEvent =
  | { type: "agent_start" }
  | { type: "agent_end"; messages: BrewvaTurnLoopMessage[] }
  | { type: "turn_start" }
  | {
      type: "turn_end";
      message: BrewvaTurnLoopMessage;
      toolResults: BrewvaTurnLoopToolResultMessage[];
    }
  | { type: "message_start"; message: BrewvaTurnLoopMessage }
  | {
      type: "message_update";
      message: BrewvaTurnLoopMessage;
      assistantMessageEvent: BrewvaTurnLoopAssistantMessageEvent;
    }
  | { type: "message_end"; message: BrewvaTurnLoopMessage }
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
      message: BrewvaTurnLoopToolResultMessage;
    }
  | {
      type: "steer_dropped";
      text: string;
      reason: BrewvaTurnLoopSteerDropReason;
    };

export interface BrewvaTurnLoopController {
  readonly state: {
    model: { provider: string; id: string } | undefined;
    thinkingLevel: string;
    isStreaming: boolean;
    systemPrompt: string;
    tools: Array<{ name: string }>;
  };
  readonly signal: AbortSignal | undefined;
  subscribe(
    listener: (
      event: BrewvaTurnLoopEvent,
    ) => Promise<BrewvaTurnLoopEvent | void> | BrewvaTurnLoopEvent | void,
  ): () => void;
  prompt(message: BrewvaTurnLoopMessage | BrewvaTurnLoopMessage[]): Promise<void>;
  waitForIdle(): Promise<void>;
  setModel(model: BrewvaRegisteredModel): void;
  setThinkingLevel(level: BrewvaTurnLoopThinkingLevel): void;
  replaceMessages(messages: BrewvaTurnLoopMessage[]): void;
  abort(): void;
  setTools(tools: BrewvaTurnLoopTool[]): void;
  setSystemPrompt(prompt: string): void;
  followUp(message: BrewvaTurnLoopMessage): void;
  queue(message: BrewvaTurnLoopMessage): void;
  removeQueuedMessage(message: BrewvaTurnLoopMessage, queue: "queue" | "followUp"): boolean;
  steer(text: string): boolean;
  hasPendingSteer(): boolean;
  appendMessage(message: BrewvaTurnLoopMessage): void;
  hasQueuedMessages(): boolean;
}

export interface BrewvaTurnLoopStreamContext {
  systemPrompt?: string;
  messages: BrewvaTurnLoopLlmMessage[];
  tools?: Array<Pick<BrewvaTurnLoopTool, "name" | "description" | "parameters">>;
}

export interface BrewvaTurnLoopStreamOptions {
  reasoning?: BrewvaTurnLoopThinkingLevel;
  signal?: AbortSignal;
  apiKey?: string;
  transport?: BrewvaTurnLoopTransport;
  sessionId?: string;
  cachePolicy?: ProviderCachePolicy;
  onCacheRender?: (
    render: ProviderCacheRenderResult,
    model: BrewvaRegisteredModel,
  ) => void | Promise<void>;
  onPayload?: (
    payload: unknown,
    model: BrewvaRegisteredModel,
    metadata?: ProviderPayloadMetadata,
  ) => Promise<unknown>;
  headers?: Record<string, string>;
  maxRetryDelayMs?: number;
  thinkingBudgets?: BrewvaTurnLoopThinkingBudgets;
  resolveFile?: (
    part: BrewvaTurnLoopFileContent,
    model: BrewvaRegisteredModel,
  ) => ResolvedFileContent | undefined;
}

export type BrewvaTurnLoopStopAfterToolResults = (
  toolResults: BrewvaTurnLoopToolResultMessage[],
) => boolean | Promise<boolean>;

export interface BrewvaTurnLoopAssistantMessageEventStream extends AsyncIterable<BrewvaTurnLoopAssistantMessageEvent> {
  result(): Promise<BrewvaTurnLoopAssistantMessage>;
}

export type BrewvaTurnLoopResolveRequestAuth = (
  model: BrewvaRegisteredModel,
) => Promise<BrewvaResolvedRequestAuth> | BrewvaResolvedRequestAuth;

export type BrewvaTurnLoopStreamFunction = (
  model: BrewvaRegisteredModel,
  context: BrewvaTurnLoopStreamContext,
  options: BrewvaTurnLoopStreamOptions,
) => BrewvaTurnLoopAssistantMessageEventStream | Promise<BrewvaTurnLoopAssistantMessageEventStream>;
