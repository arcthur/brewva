import { BrewvaStream } from "@brewva/brewva-effect/primitives";
import type {
  AssistantMessageEventOf,
  ProviderCachePolicy,
  ProviderCacheRenderResult,
  ProviderPayloadMetadata,
  ProviderRuntime,
  ProviderStreamError,
  ResolvedFileContent,
} from "@brewva/brewva-provider-core/contracts";
import type { TSchema } from "@sinclair/typebox";
import type { BrewvaRegisteredModel, BrewvaResolvedRequestAuth } from "../contracts/provider.js";
import type { BrewvaThinkingLevel } from "../contracts/thinking.js";
import type { ToolExecutionPhase } from "../execution/tool-phase.js";

type BrewvaAgentProtocolApi = BrewvaRegisteredModel["api"];

export type BrewvaAgentProtocolThinkingLevel = BrewvaThinkingLevel;

export interface BrewvaAgentProtocolThinkingBudgets {
  minimal?: number;
  low?: number;
  medium?: number;
  high?: number;
}

export type BrewvaAgentProtocolTransport = "sse" | "websocket" | "auto";

export interface BrewvaAgentProtocolTextContent {
  type: "text";
  text: string;
  textSignature?: string;
}

export interface BrewvaAgentProtocolThinkingContent {
  type: "thinking";
  thinking: string;
  thinkingSignature?: string;
  redacted?: boolean;
}

export interface BrewvaAgentProtocolImageContent {
  type: "image";
  data: string;
  mimeType: string;
}

export interface BrewvaAgentProtocolFileContent {
  type: "file";
  uri: string;
  name?: string;
  mimeType?: string;
  displayText?: string;
}

export interface BrewvaAgentProtocolMessageVisibility {
  display?: boolean;
  excludeFromContext?: boolean;
  details?: unknown;
}

export interface BrewvaAgentProtocolToolCall {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  thoughtSignature?: string;
}

export interface BrewvaAgentProtocolUsage {
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

export type BrewvaAgentProtocolStopReason = "stop" | "length" | "toolUse" | "error" | "aborted";
export type BrewvaAgentProtocolSteerDropReason =
  | "aborted"
  | "failed"
  | "no_tool_boundary"
  | "overwritten";

export interface BrewvaAgentProtocolUserMessage extends BrewvaAgentProtocolMessageVisibility {
  role: "user";
  content: Array<
    | BrewvaAgentProtocolTextContent
    | BrewvaAgentProtocolImageContent
    | BrewvaAgentProtocolFileContent
  >;
  timestamp: number;
}

export interface BrewvaAgentProtocolAssistantMessage extends BrewvaAgentProtocolMessageVisibility {
  role: "assistant";
  content: Array<
    | BrewvaAgentProtocolTextContent
    | BrewvaAgentProtocolThinkingContent
    | BrewvaAgentProtocolToolCall
  >;
  api: BrewvaAgentProtocolApi;
  provider: string;
  model: string;
  responseId?: string;
  usage: BrewvaAgentProtocolUsage;
  stopReason: BrewvaAgentProtocolStopReason;
  errorMessage?: string;
  timestamp: number;
}

export interface BrewvaAgentProtocolToolResultMessage<TDetails = unknown> extends Omit<
  BrewvaAgentProtocolMessageVisibility,
  "details"
> {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: Array<BrewvaAgentProtocolTextContent | BrewvaAgentProtocolImageContent>;
  details?: TDetails;
  isError: boolean;
  timestamp: number;
}

export interface BrewvaAgentProtocolCustomMessage<TDetails = unknown> extends Omit<
  BrewvaAgentProtocolMessageVisibility,
  "display" | "details"
> {
  role: "custom";
  customType: string;
  content: string | Array<BrewvaAgentProtocolTextContent | BrewvaAgentProtocolImageContent>;
  display: boolean;
  details?: TDetails;
  timestamp: number;
}

export interface BrewvaAgentProtocolBranchSummaryMessage extends BrewvaAgentProtocolMessageVisibility {
  role: "branchSummary";
  summary: string;
  fromId: string;
  timestamp: number;
}

export interface BrewvaAgentProtocolCompactionSummaryMessage extends BrewvaAgentProtocolMessageVisibility {
  role: "compactionSummary";
  summary: string;
  tokensBefore: number;
  timestamp: number;
}

export type BrewvaAgentProtocolMessage =
  | BrewvaAgentProtocolUserMessage
  | BrewvaAgentProtocolAssistantMessage
  | BrewvaAgentProtocolToolResultMessage
  | BrewvaAgentProtocolCustomMessage
  | BrewvaAgentProtocolBranchSummaryMessage
  | BrewvaAgentProtocolCompactionSummaryMessage;

export type BrewvaAgentProtocolLlmMessage =
  | BrewvaAgentProtocolUserMessage
  | BrewvaAgentProtocolAssistantMessage
  | BrewvaAgentProtocolToolResultMessage;

export interface BrewvaAgentProtocolToolResult<TDetails = unknown> {
  content: Array<BrewvaAgentProtocolTextContent | BrewvaAgentProtocolImageContent>;
  details: TDetails;
  isError?: boolean;
}

export type BrewvaAgentProtocolToolUpdateCallback<TDetails = unknown> = (
  partialResult: BrewvaAgentProtocolToolResult<TDetails>,
) => Promise<void>;

export interface BrewvaAgentProtocolTool {
  name: string;
  label: string;
  description: string;
  parameters: TSchema;
  prepareArguments?: (args: unknown) => unknown;
  execute(
    toolCallId: string,
    params: unknown,
    signal?: AbortSignal,
    onUpdate?: BrewvaAgentProtocolToolUpdateCallback,
  ): Promise<BrewvaAgentProtocolToolResult>;
}

export interface BrewvaAgentProtocolContext {
  systemPrompt: string;
  messages: BrewvaAgentProtocolMessage[];
  tools: BrewvaAgentProtocolTool[];
}

export interface BrewvaAgentProtocolBeforeToolCallContext {
  assistantMessage: BrewvaAgentProtocolAssistantMessage;
  toolCall: BrewvaAgentProtocolToolCall;
  args: unknown;
  context: BrewvaAgentProtocolContext;
}

export interface BrewvaAgentProtocolAfterToolCallContext {
  assistantMessage: BrewvaAgentProtocolAssistantMessage;
  toolCall: BrewvaAgentProtocolToolCall;
  args: unknown;
  result: BrewvaAgentProtocolToolResult;
  isError: boolean;
  context: BrewvaAgentProtocolContext;
}

export type BrewvaAgentProtocolAssistantMessageEvent = AssistantMessageEventOf<
  BrewvaAgentProtocolAssistantMessage,
  BrewvaAgentProtocolToolCall,
  BrewvaAgentProtocolStopReason
>;

export type BrewvaAgentProtocolEvent =
  | { type: "agent_start" }
  | { type: "agent_end"; messages: BrewvaAgentProtocolMessage[] }
  | { type: "turn_start" }
  | {
      type: "turn_end";
      message: BrewvaAgentProtocolMessage;
      toolResults: BrewvaAgentProtocolToolResultMessage[];
    }
  | { type: "message_start"; message: BrewvaAgentProtocolMessage }
  | {
      type: "message_update";
      message: BrewvaAgentProtocolMessage;
      assistantMessageEvent: BrewvaAgentProtocolAssistantMessageEvent;
    }
  | { type: "message_end"; message: BrewvaAgentProtocolMessage }
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
      message: BrewvaAgentProtocolToolResultMessage;
    }
  | {
      type: "steer_dropped";
      text: string;
      reason: BrewvaAgentProtocolSteerDropReason;
    };

export interface BrewvaTurnEventScope {
  readonly turn: {
    readonly sessionId?: string;
    readonly turnId?: string;
  };
  readonly toolInvocation?: {
    readonly toolCallId: string;
    readonly toolName: string;
  };
}

export interface BrewvaAgentProtocolController {
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
      event: BrewvaAgentProtocolEvent,
      scope: BrewvaTurnEventScope | undefined,
      signal: AbortSignal | undefined,
    ) => Promise<BrewvaAgentProtocolEvent | void> | BrewvaAgentProtocolEvent | void,
  ): () => void;
  prompt(message: BrewvaAgentProtocolMessage | BrewvaAgentProtocolMessage[]): Promise<void>;
  waitForIdle(): Promise<void>;
  setModel(model: BrewvaRegisteredModel): void;
  setThinkingLevel(level: BrewvaAgentProtocolThinkingLevel): void;
  replaceMessages(messages: BrewvaAgentProtocolMessage[]): void;
  abort(): void;
  setTools(tools: BrewvaAgentProtocolTool[]): void;
  setSystemPrompt(prompt: string): void;
  followUp(message: BrewvaAgentProtocolMessage): void;
  queue(message: BrewvaAgentProtocolMessage): void;
  removeQueuedMessage(message: BrewvaAgentProtocolMessage, queue: "queue" | "followUp"): boolean;
  steer(text: string): boolean;
  hasPendingSteer(): boolean;
  appendMessage(message: BrewvaAgentProtocolMessage): void;
  hasQueuedMessages(): boolean;
}

export interface BrewvaAgentProtocolStreamContext {
  systemPrompt?: string;
  messages: BrewvaAgentProtocolLlmMessage[];
  tools?: Array<Pick<BrewvaAgentProtocolTool, "name" | "description" | "parameters">>;
}

export interface BrewvaAgentProtocolStreamOptions {
  reasoning?: BrewvaAgentProtocolThinkingLevel;
  signal?: AbortSignal;
  apiKey?: string;
  transport?: BrewvaAgentProtocolTransport;
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
  ) => unknown;
  headers?: Record<string, string>;
  maxRetryDelayMs?: number;
  thinkingBudgets?: BrewvaAgentProtocolThinkingBudgets;
  resolveFile?: (
    part: BrewvaAgentProtocolFileContent,
    model: BrewvaRegisteredModel,
  ) => ResolvedFileContent | undefined;
}

export type BrewvaAgentProtocolStopAfterToolResults = (
  toolResults: BrewvaAgentProtocolToolResultMessage[],
  signal?: AbortSignal,
) => boolean | Promise<boolean>;

export type BrewvaAgentProtocolAssistantMessageStream = BrewvaStream.Stream<
  BrewvaAgentProtocolAssistantMessageEvent,
  ProviderStreamError,
  ProviderRuntime
>;

export type BrewvaAgentProtocolResolveRequestAuth = (
  model: BrewvaRegisteredModel,
  signal?: AbortSignal,
) => Promise<BrewvaResolvedRequestAuth> | BrewvaResolvedRequestAuth;

export type BrewvaAgentProtocolStreamFunction = (
  model: BrewvaRegisteredModel,
  context: BrewvaAgentProtocolStreamContext,
  options: BrewvaAgentProtocolStreamOptions,
) => BrewvaAgentProtocolAssistantMessageStream;
