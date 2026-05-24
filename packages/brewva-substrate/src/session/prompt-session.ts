import type { AssistantMessageEventOf } from "@brewva/brewva-provider-core/contracts";
import type { ContextState } from "../contracts/context-state.js";
import type { BrewvaThinkingLevel } from "../contracts/thinking.js";
import type { BrewvaToolDefinition } from "../contracts/tool.js";
import type { ToolExecutionPhase } from "../execution/tool-phase.js";
import type { BrewvaToolUiPort } from "../host-api/ui.js";
import type { BrewvaPromptContentPart } from "../prompt/content.js";
import type { BrewvaPromptEnvelope } from "./session-host.js";

export type BrewvaPromptQueueBehavior = "queue" | "followUp";
export type BrewvaPromptInputSource = "interactive" | "extension" | (string & {});
export type BrewvaSteerDropReason = "aborted" | "failed" | "no_tool_boundary" | "overwritten";
export type BrewvaSteerOutcome =
  | { status: "queued"; chars: number }
  | { status: "no_active_run" }
  | { status: "rejected_empty" };
export type BrewvaPromptThinkingLevel = BrewvaThinkingLevel;

export interface BrewvaPromptOptions {
  expandPromptTemplates?: boolean;
  streamingBehavior?: BrewvaPromptQueueBehavior;
  source?: BrewvaPromptInputSource;
}

export interface BrewvaQueuedPromptView extends Pick<
  BrewvaPromptEnvelope,
  "promptId" | "submittedAt"
> {
  text: string;
  behavior: BrewvaPromptQueueBehavior;
}

export interface BrewvaSteerOptions {
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

export type BrewvaModelRoleAlias = "default" | "smol" | "slow" | "plan" | "commit" | "task";

export type BrewvaModelRoleMap = Partial<Record<BrewvaModelRoleAlias, string>>;

export interface BrewvaModelPreset {
  name: string;
  roles: BrewvaModelRoleMap;
  synthetic?: boolean;
}

export interface BrewvaModelPresetState {
  activeName: string;
  defaultName: string;
  presets: BrewvaModelPreset[];
  pendingName?: string;
}

export interface BrewvaModelPresetSelectionRequest {
  name: string;
  source?: "startup" | "tui" | "session" | "queued";
}

export interface BrewvaModelPresetSelectionResult {
  selectedName: string;
  previousName?: string;
  modelChanged: boolean;
  queued: boolean;
  effectiveDefaultModel?: string;
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
  resetLeaf?(): void;
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
  steer?(text: string, options?: BrewvaSteerOptions): Promise<BrewvaSteerOutcome>;
  sessionManager?: BrewvaPromptSessionManagerView;
  settingsManager?: BrewvaSessionSettingsView;
  model?: BrewvaSessionModelDescriptor;
  thinkingLevel?: BrewvaPromptThinkingLevel;
  modelRegistry?: BrewvaSessionModelCatalogView;
  getContextState?(): ContextState;
  waitForIdle?(): Promise<void>;
  setModel?(model: BrewvaSessionModelDescriptor): Promise<void> | void;
  getModelPresetState?(): BrewvaModelPresetState;
  selectModelPreset?(
    request: BrewvaModelPresetSelectionRequest,
  ): Promise<BrewvaModelPresetSelectionResult> | BrewvaModelPresetSelectionResult;
  queueModelPresetForNextTurn?(
    name: string,
  ): Promise<BrewvaModelPresetSelectionResult> | BrewvaModelPresetSelectionResult;
  setThinkingLevel?(level: BrewvaPromptThinkingLevel): void;
  replaceMessages?(messages: unknown): void | Promise<void>;
  getAvailableThinkingLevels?(): BrewvaPromptThinkingLevel[];
  isStreaming?: boolean;
  isCompacting?: boolean;
  abort?(): Promise<void>;
  dispose?(): void;
}

export interface BrewvaPromptToolCall {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  thoughtSignature?: string;
}

export type BrewvaPromptAssistantMessageEvent = AssistantMessageEventOf<
  unknown,
  BrewvaPromptToolCall,
  "stop" | "length" | "toolUse" | "error" | "aborted"
>;

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
      type: "steer_applied";
      text: string;
      toolCallId: string;
      toolName: string;
      message: unknown;
    }
  | {
      type: "steer_dropped";
      text: string;
      reason: BrewvaSteerDropReason;
    }
  | {
      type: "queue.changed";
      items: readonly BrewvaQueuedPromptView[];
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
  getQueuedPrompts(): readonly BrewvaQueuedPromptView[];
  removeQueuedPrompt(promptId: string): boolean;
  waitForIdle(): Promise<void>;
  setUiPort(ui: BrewvaToolUiPort): void;
  steer(text: string, options?: BrewvaSteerOptions): Promise<BrewvaSteerOutcome>;
  abort(): Promise<void>;
  dispose(): void;
}
