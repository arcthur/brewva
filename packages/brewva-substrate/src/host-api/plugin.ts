import type { ContextState } from "../contracts/context-state.js";
import type { SessionPhase } from "../contracts/session-phase.js";
import type {
  BrewvaToolContentPart,
  BrewvaToolContextUsage,
  BrewvaToolDefinition,
  BrewvaToolResult,
} from "../contracts/tool.js";
import type { ToolExecutionPhase } from "../execution/tool-phase.js";
import type { BrewvaPromptContentPart } from "../session/prompt-content.js";
import type { BrewvaPromptAssistantMessageEvent } from "../session/prompt-session.js";
import type { BrewvaToolUiPort } from "./ui.js";

export interface HostCommandPort {
  interrupt(): Promise<void> | void;
  newSession(): Promise<void> | void;
  reloadSession(): Promise<void> | void;
}

export interface HostUIPort {
  setStatus(text: string | undefined): void;
  notify(message: string, level?: "info" | "warning" | "error"): void;
}

export interface HostRuntimePluginContext {
  commands: HostCommandPort;
  ui: HostUIPort;
}

export interface HostRuntimePlugin {
  name: string;
  onSessionPhaseChange?(
    phase: SessionPhase,
    context: HostRuntimePluginContext,
  ): Promise<void> | void;
  onToolRegistered?(
    tool: BrewvaToolDefinition,
    context: HostRuntimePluginContext,
  ): Promise<void> | void;
  onToolResult?(
    toolName: string,
    result: BrewvaToolResult,
    context: HostRuntimePluginContext,
  ): Promise<void> | void;
}

export interface BrewvaHostSessionManagerView {
  getSessionId(): string;
  getLeafId?(): string | null | undefined;
}

export interface BrewvaHostCommandContextOptions {
  parentSession?: string;
  setup?: (sessionManager: BrewvaHostSessionManagerView) => Promise<void>;
}

export interface BrewvaHostCommandContext extends BrewvaHostContext {
  waitForIdle(): Promise<void>;
  newSession(options?: BrewvaHostCommandContextOptions): Promise<{ cancelled: boolean }>;
  fork(entryId: string): Promise<{ cancelled: boolean }>;
  navigateTree(
    targetId: string,
    options?: {
      summarize?: boolean;
      customInstructions?: string;
      replaceInstructions?: boolean;
      label?: string;
    },
  ): Promise<{ cancelled: boolean }>;
  switchSession(sessionPath: string): Promise<{ cancelled: boolean }>;
  reload(): Promise<void>;
}

export interface BrewvaHostContext {
  ui: BrewvaToolUiPort;
  hasUI: boolean;
  cwd: string;
  sessionManager: BrewvaHostSessionManagerView;
  modelRegistry?: unknown;
  model?: unknown;
  isIdle(): boolean;
  signal?: AbortSignal;
  abort(): void;
  hasPendingMessages(): boolean;
  shutdown(): void;
  getContextUsage(): BrewvaToolContextUsage | undefined;
  compact(options?: {
    customInstructions?: string;
    onComplete?: (result: unknown) => void;
    onError?: (error: Error) => void;
  }): void;
  getSystemPrompt(): string;
}

export interface BrewvaHostToolInfo {
  name: string;
  description: string;
  parameters: unknown;
  sourceInfo?: unknown;
}

export interface BrewvaHostRegisteredCommand {
  description?: string;
  handler(args: string, ctx: BrewvaHostCommandContext): Promise<void> | void;
}

export interface BrewvaHostCustomMessage {
  customType: string;
  content: string;
  display?: boolean;
  details?: unknown;
}

export interface BrewvaHostSessionStartEvent {
  type: "session_start";
  reason?: "startup" | "reload" | "new" | "resume" | "fork";
  previousSessionFile?: string;
}

export interface BrewvaHostSessionSwitchEvent {
  type: "session_switch";
  reason?: "new" | "resume";
  targetSessionFile?: string;
}

export interface BrewvaHostSessionBeforeCompactEvent {
  type: "session_before_compact";
  preparation?: unknown;
  branchEntries: unknown[];
  customInstructions?: string;
  signal?: AbortSignal;
}

export interface BrewvaHostSessionCompactEvent {
  type: "session_compact";
  compactionEntry?: unknown;
  fromExtension?: boolean;
}

export interface BrewvaHostSessionShutdownEvent {
  type: "session_shutdown";
}

export interface BrewvaHostContextEvent {
  type: "context";
  messages: unknown[];
}

export interface BrewvaHostBeforeProviderRequestEvent {
  type: "before_provider_request";
  payload: unknown;
}

export interface BrewvaHostBeforeAgentStartEvent {
  type: "before_agent_start";
  prompt: string;
  parts: BrewvaPromptContentPart[];
  systemPrompt: string;
}

export interface BrewvaHostAgentStartEvent {
  type: "agent_start";
}

export interface BrewvaHostAgentEndEvent {
  type: "agent_end";
  messages: unknown[];
}

export interface BrewvaHostTurnStartEvent {
  type: "turn_start";
  turnIndex: number;
  timestamp: number;
}

export interface BrewvaHostTurnEndEvent {
  type: "turn_end";
  turnIndex: number;
  message: unknown;
  toolResults: unknown[];
}

export interface BrewvaHostMessageStartEvent {
  type: "message_start";
  message: unknown;
}

export interface BrewvaHostMessageUpdateEvent {
  type: "message_update";
  message: unknown;
  assistantMessageEvent: BrewvaPromptAssistantMessageEvent;
}

export interface BrewvaHostMessageEndEvent {
  type: "message_end";
  message: unknown;
}

export interface BrewvaHostToolExecutionStartEvent {
  type: "tool_execution_start";
  toolCallId: string;
  toolName: string;
  args: unknown;
}

export interface BrewvaHostToolExecutionUpdateEvent {
  type: "tool_execution_update";
  toolCallId: string;
  toolName: string;
  args: unknown;
  partialResult: unknown;
}

export interface BrewvaHostToolExecutionEndEvent {
  type: "tool_execution_end";
  toolCallId: string;
  toolName: string;
  result: unknown;
  isError: boolean;
}

export interface BrewvaHostToolExecutionPhaseChangeEvent {
  type: "tool_execution_phase_change";
  toolCallId: string;
  toolName: string;
  phase: ToolExecutionPhase;
  previousPhase?: ToolExecutionPhase;
  args?: unknown;
}

export interface BrewvaHostSessionPhaseChangeEvent {
  type: "session_phase_change";
  phase: SessionPhase;
  previousPhase?: SessionPhase;
}

export interface BrewvaHostContextStateChangeEvent {
  type: "context_state_change";
  state: ContextState;
  previousState?: ContextState;
}

export interface BrewvaHostModelSelectEvent {
  type: "model_select";
  model: {
    provider: string;
    id: string;
  };
  previousModel?: {
    provider: string;
    id: string;
  };
  source?: string;
}

export interface BrewvaHostThinkingLevelSelectEvent {
  type: "thinking_level_select";
  thinkingLevel: string;
  previousThinkingLevel?: string;
  source?: string;
}

export type BrewvaHostInputEventResult =
  | { action: "continue" }
  | { action: "transform"; parts: BrewvaPromptContentPart[] }
  | { action: "handled" };

export interface BrewvaHostInputEvent {
  type: "input";
  text: string;
  parts: BrewvaPromptContentPart[];
  source?: string;
}

export interface BrewvaHostToolCallEvent {
  type: "tool_call";
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
}

export interface BrewvaHostToolCallResult {
  block?: boolean;
  reason?: string;
}

export interface BrewvaHostToolResultEvent {
  type: "tool_result";
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
  content: BrewvaToolContentPart[];
  isError: boolean;
  details?: unknown;
}

export interface BrewvaHostToolResultResult {
  content?: BrewvaToolContentPart[];
  details?: unknown;
  isError?: boolean;
}

export interface BrewvaHostBeforeAgentStartResult {
  message?: BrewvaHostCustomMessage;
  systemPrompt?: string;
}

export interface BrewvaHostPluginEventMap {
  session_start: BrewvaHostSessionStartEvent;
  session_switch: BrewvaHostSessionSwitchEvent;
  session_before_compact: BrewvaHostSessionBeforeCompactEvent;
  session_compact: BrewvaHostSessionCompactEvent;
  session_shutdown: BrewvaHostSessionShutdownEvent;
  context: BrewvaHostContextEvent;
  before_provider_request: BrewvaHostBeforeProviderRequestEvent;
  before_agent_start: BrewvaHostBeforeAgentStartEvent;
  agent_start: BrewvaHostAgentStartEvent;
  agent_end: BrewvaHostAgentEndEvent;
  turn_start: BrewvaHostTurnStartEvent;
  turn_end: BrewvaHostTurnEndEvent;
  message_start: BrewvaHostMessageStartEvent;
  message_update: BrewvaHostMessageUpdateEvent;
  message_end: BrewvaHostMessageEndEvent;
  tool_execution_start: BrewvaHostToolExecutionStartEvent;
  tool_execution_update: BrewvaHostToolExecutionUpdateEvent;
  tool_execution_end: BrewvaHostToolExecutionEndEvent;
  tool_execution_phase_change: BrewvaHostToolExecutionPhaseChangeEvent;
  session_phase_change: BrewvaHostSessionPhaseChangeEvent;
  context_state_change: BrewvaHostContextStateChangeEvent;
  model_select: BrewvaHostModelSelectEvent;
  thinking_level_select: BrewvaHostThinkingLevelSelectEvent;
  input: BrewvaHostInputEvent;
  tool_call: BrewvaHostToolCallEvent;
  tool_result: BrewvaHostToolResultEvent;
}

type BrewvaHostPluginHandlerResult<TKey extends keyof BrewvaHostPluginEventMap> =
  TKey extends "before_agent_start"
    ? BrewvaHostBeforeAgentStartResult | undefined
    : TKey extends "input"
      ? BrewvaHostInputEventResult | undefined
      : TKey extends "context"
        ? { messages?: unknown[] } | undefined
        : TKey extends "tool_call"
          ? BrewvaHostToolCallResult | undefined
          : TKey extends "tool_result"
            ? BrewvaHostToolResultResult | undefined
            : TKey extends "before_provider_request"
              ? unknown
              : void | undefined;

export interface BrewvaHostPluginApi {
  on<TKey extends keyof BrewvaHostPluginEventMap>(
    event: TKey,
    handler: (
      event: BrewvaHostPluginEventMap[TKey],
      ctx: BrewvaHostContext,
    ) => Promise<BrewvaHostPluginHandlerResult<TKey>> | BrewvaHostPluginHandlerResult<TKey>,
  ): void;
  registerTool(tool: BrewvaToolDefinition): void;
  registerCommand(name: string, command: BrewvaHostRegisteredCommand): void;
  sendMessage(
    message: BrewvaHostCustomMessage,
    options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
  ): void;
  sendUserMessage(
    content: BrewvaPromptContentPart[],
    options?: { deliverAs?: "steer" | "followUp" },
  ): void;
  getActiveTools(): string[];
  getAllTools(): BrewvaHostToolInfo[];
  setActiveTools(toolNames: string[]): void;
  refreshTools(): void;
}

export type BrewvaHostPluginFactory = (api: BrewvaHostPluginApi) => void | Promise<void>;

export type { BrewvaToolUiPort };
