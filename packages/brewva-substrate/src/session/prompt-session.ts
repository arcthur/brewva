import type { ContextState } from "../contracts/context-state.js";
import type { BrewvaToolDefinition } from "../contracts/tool.js";
import type { ToolExecutionPhase } from "../execution/tool-phase.js";
import type { BrewvaToolUiPort } from "../host-api/ui.js";
import type { BrewvaPromptContentPart } from "./prompt-content.js";

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

export interface BrewvaModelPreferenceRef {
  provider: string;
  id: string;
}

export interface BrewvaModelPreferences {
  recent: BrewvaModelPreferenceRef[];
  favorite: BrewvaModelPreferenceRef[];
}

export type BrewvaDiffStyle = "auto" | "stacked";
export type BrewvaDiffWrapMode = "word" | "none";

export interface BrewvaDiffPreferences {
  style: BrewvaDiffStyle;
  wrapMode: BrewvaDiffWrapMode;
}

export interface BrewvaShellViewPreferences {
  showThinking: boolean;
  toolDetails: boolean;
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
  branch?(entryId: string): void;
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
  getModelPreferences?(): BrewvaModelPreferences;
  setModelPreferences?(preferences: BrewvaModelPreferences): void;
  getDiffPreferences?(): BrewvaDiffPreferences;
  setDiffPreferences?(preferences: BrewvaDiffPreferences): void;
  getShellViewPreferences?(): BrewvaShellViewPreferences;
  setShellViewPreferences?(preferences: BrewvaShellViewPreferences): void;
}

export interface BrewvaManagedSessionSettingsView extends BrewvaSessionSettingsView {
  getQuietStartup(): boolean;
  getModelPreferences(): BrewvaModelPreferences;
  setModelPreferences(preferences: BrewvaModelPreferences): void;
  getDiffPreferences(): BrewvaDiffPreferences;
  setDiffPreferences(preferences: BrewvaDiffPreferences): void;
  getShellViewPreferences(): BrewvaShellViewPreferences;
  setShellViewPreferences(preferences: BrewvaShellViewPreferences): void;
}

export interface BrewvaPromptDispatchSession {
  prompt(parts: readonly BrewvaPromptContentPart[], options?: BrewvaPromptOptions): Promise<void>;
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
  type: "start";
  partial: unknown;
}

export type BrewvaPromptAssistantMessageEvent =
  | BrewvaPromptMessageDeltaEvent
  | {
      type: "text_start";
      contentIndex: number;
      partial: unknown;
    }
  | {
      type: "text_delta";
      contentIndex: number;
      delta: string;
      partial: unknown;
    }
  | {
      type: "text_end";
      contentIndex: number;
      content: string;
      partial: unknown;
    }
  | {
      type: "thinking_start";
      contentIndex: number;
      partial: unknown;
    }
  | {
      type: "thinking_delta";
      contentIndex: number;
      delta: string;
      partial: unknown;
    }
  | {
      type: "thinking_end";
      contentIndex: number;
      content: string;
      partial: unknown;
    }
  | {
      type: "toolcall_start";
      contentIndex: number;
      partial: unknown;
    }
  | {
      type: "toolcall_delta";
      contentIndex: number;
      delta: string;
      partial: unknown;
    }
  | {
      type: "toolcall_end";
      contentIndex: number;
      toolCall: {
        type: "toolCall";
        id: string;
        name: string;
        arguments: Record<string, unknown>;
        thoughtSignature?: string;
      };
      partial: unknown;
    }
  | {
      type: "done";
      reason: "stop" | "length" | "toolUse";
      message: unknown;
    }
  | {
      type: "error";
      reason: "aborted" | "error";
      error: unknown;
    };

export type BrewvaPromptSessionEvent =
  | {
      type: "message_start";
      message: unknown;
    }
  | {
      type: "message_update";
      message?: unknown;
      assistantMessageEvent?: BrewvaPromptAssistantMessageEvent;
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
  getRegisteredTools(): readonly BrewvaToolDefinition[];
  getContextState(): ContextState;
  waitForIdle(): Promise<void>;
  setUiPort(ui: BrewvaToolUiPort): void;
  abort(): Promise<void>;
  dispose(): void;
}
