import type { ContextState } from "../contracts/context-state.js";
import type { BrewvaToolContentPart } from "../contracts/tool.js";
import type { ToolExecutionPhase } from "../execution/tool-phase.js";

export type BrewvaPromptQueueBehavior = "steer" | "followUp";
export type BrewvaPromptInputSource = "interactive" | "extension" | (string & {});
export type BrewvaPromptThinkingLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | (string & {});

export interface BrewvaPromptOptions {
  expandPromptTemplates?: boolean;
  images?: BrewvaToolContentPart[];
  streamingBehavior?: BrewvaPromptQueueBehavior;
  source?: BrewvaPromptInputSource;
}

export interface BrewvaSessionModelDescriptor {
  provider: string;
  id: string;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  name?: string;
  api?: string;
  baseUrl?: string;
  input?: Array<"text" | "image">;
  cost?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  headers?: Record<string, string>;
  compat?: unknown;
  displayName?: string;
}

export interface BrewvaSessionModelCatalogView {
  getAvailable?():
    | Promise<readonly BrewvaSessionModelDescriptor[]>
    | readonly BrewvaSessionModelDescriptor[];
  getAll?(): readonly BrewvaSessionModelDescriptor[];
}

export interface BrewvaPromptSessionManagerView {
  getSessionId(): string;
  getLeafId?(): string | null | undefined;
  branchWithSummary?(
    targetLeafEntryId: string | null,
    summaryText: string,
    summaryDetails: Record<string, unknown>,
    replaceCurrent: boolean,
  ): void;
  buildSessionContext?(): {
    messages: unknown;
  };
}

export interface BrewvaSessionSettingsView {
  getQuietStartup?(): boolean;
}

export interface BrewvaManagedSessionSettingsView extends BrewvaSessionSettingsView {
  getQuietStartup(): boolean;
}

export interface BrewvaPromptDispatchSession {
  prompt(text: string, options?: BrewvaPromptOptions): Promise<void>;
  sessionManager?: BrewvaPromptSessionManagerView;
  settingsManager?: BrewvaSessionSettingsView;
  model?: BrewvaSessionModelDescriptor;
  thinkingLevel?: BrewvaPromptThinkingLevel;
  modelRegistry?: BrewvaSessionModelCatalogView;
  getContextState?(): ContextState;
  waitForIdle?(): Promise<void>;
  setModel?(model: BrewvaSessionModelDescriptor): Promise<void> | void;
  setThinkingLevel?(level: BrewvaPromptThinkingLevel): void;
  replaceMessages?(messages: unknown): void;
  getAvailableThinkingLevels?(): BrewvaPromptThinkingLevel[];
  isStreaming?: boolean;
  isCompacting?: boolean;
  abort?(): Promise<void>;
  dispose?(): void;
}

export interface BrewvaPromptMessageDeltaEvent {
  type?: string;
  delta?: string;
}

export type BrewvaPromptSessionEvent =
  | {
      type: "message_start";
      message: unknown;
    }
  | {
      type: "message_update";
      message?: unknown;
      assistantMessageEvent?: BrewvaPromptMessageDeltaEvent;
    }
  | {
      type: "message_end";
      message: unknown;
    }
  | {
      type: "tool_execution_start";
      toolCallId?: string;
      toolName?: string;
      args?: unknown;
    }
  | {
      type: "tool_execution_update";
      toolCallId?: string;
      toolName?: string;
      args?: unknown;
      partialResult?: unknown;
    }
  | {
      type: "tool_execution_end";
      toolCallId?: string;
      toolName?: string;
      result?: unknown;
      isError?: boolean;
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
      type: "context_state_change";
      state: ContextState;
      previousState?: ContextState;
    }
  | {
      type: string;
      [key: string]: unknown;
    };

export interface BrewvaSubscribablePromptSession extends BrewvaPromptDispatchSession {
  subscribe(listener: (event: BrewvaPromptSessionEvent) => void): () => void;
}

export interface BrewvaManagedPromptSession extends BrewvaSubscribablePromptSession {
  sessionManager: BrewvaPromptSessionManagerView;
  settingsManager: BrewvaManagedSessionSettingsView;
  getContextState(): ContextState;
  waitForIdle(): Promise<void>;
  abort(): Promise<void>;
  dispose(): void;
}
