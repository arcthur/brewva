import type { BrewvaRuntime, ManagedToolMode } from "@brewva/brewva-runtime";
import type { BrewvaSteerOutcome } from "@brewva/brewva-substrate/session";
import type { HostedExtensionPlugin } from "../extensions/api.js";
import type { SubscribablePromptSession } from "../hosted/api.js";
import type { ChannelToolTurnOutput } from "./channel-reply-writer.js";
import type { ChannelModeLauncher, SupportedChannel } from "./launcher.js";
export type {
  ChannelInspectCommandInput,
  ChannelInspectCommandResult,
  ChannelInsightsCommandInput,
  ChannelInsightsCommandResult,
  ChannelQuestionsCommandInput,
  ChannelQuestionsCommandResult,
} from "./command/contracts.js";
import type {
  ChannelInspectCommandInput,
  ChannelInspectCommandResult,
  ChannelInsightsCommandInput,
  ChannelInsightsCommandResult,
  ChannelQuestionsCommandInput,
  ChannelQuestionsCommandResult,
} from "./command/contracts.js";

export interface ChannelPromptTurnOutputSession extends SubscribablePromptSession {}

export interface ChannelPromptTurnOutputs {
  assistantText: string;
  toolOutputs: ChannelToolTurnOutput[];
}

export interface ChannelHostedPromptSession extends SubscribablePromptSession {
  sessionManager: {
    getSessionId(): string;
  };
  steer(text: string, options?: { source?: string }): Promise<BrewvaSteerOutcome>;
  abort(): Promise<void>;
  dispose(): void;
}

export interface ChannelHostedSessionResult {
  session: ChannelHostedPromptSession;
  runtime: BrewvaRuntime;
}

export interface ChannelCreateSessionOptions {
  cwd?: string;
  configPath?: string;
  model?: string;
  managedToolMode: ManagedToolMode;
  runtime?: BrewvaRuntime;
  scopeId?: string;
  extensions?: HostedExtensionPlugin[];
}

export interface ChannelSessionPromptPort {
  createSession?: (options?: ChannelCreateSessionOptions) => Promise<ChannelHostedSessionResult>;
  collectPromptTurnOutputs?: (
    session: ChannelPromptTurnOutputSession,
    prompt: string,
    options?: {
      runtime?: BrewvaRuntime;
      sessionId?: string;
      turnId?: string;
    },
  ) => Promise<ChannelPromptTurnOutputs>;
}

export interface ChannelOperatorCommandPort {
  handleInspectCommand?: (
    input: ChannelInspectCommandInput,
  ) => Promise<ChannelInspectCommandResult>;
  handleInsightsCommand?: (
    input: ChannelInsightsCommandInput,
  ) => Promise<ChannelInsightsCommandResult>;
  handleQuestionsCommand?: (
    input: ChannelQuestionsCommandInput,
  ) => Promise<ChannelQuestionsCommandResult>;
}

export interface ChannelLauncherPort {
  launchers?: Partial<Record<SupportedChannel, ChannelModeLauncher>>;
}

export type RunChannelModeDependencies = ChannelSessionPromptPort &
  ChannelOperatorCommandPort &
  ChannelLauncherPort;
