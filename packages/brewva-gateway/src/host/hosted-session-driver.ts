import type { BrewvaRuntime } from "@brewva/brewva-runtime";
import type {
  InternalHostPlugin,
  BrewvaManagedPromptSession,
  BrewvaModelCatalog,
  BrewvaMutableModelCatalog,
  BrewvaReadToolDetails,
  BrewvaReadToolOptions,
  BrewvaRegisteredModel,
  BrewvaToolDefinition,
  BrewvaToolUiPort,
} from "@brewva/brewva-substrate";
import {
  createBrewvaEditToolDefinition,
  createBrewvaReadToolDefinition,
  createBrewvaWriteToolDefinition,
} from "@brewva/brewva-substrate";
import {
  createHostedSessionRuntimeDriver,
  createHostedSessionRuntimeSettings,
} from "./hosted-session-runtime.js";
import type { HostedSessionLogger } from "./logger.js";

export type HostedSessionCustomTool = BrewvaToolDefinition;
export type HostedSessionReadToolDetails = BrewvaReadToolDetails;
export type HostedSessionReadToolOptions = BrewvaReadToolOptions;

export interface HostedSessionUiOverrides {
  quietStartup?: boolean;
  imageAutoResize?: boolean;
}

export interface HostedSessionSettingsView {
  applyOverrides(overrides: HostedSessionUiOverrides): void;
  getImageAutoResize(): boolean;
  getQuietStartup(): boolean;
}

export interface HostedSessionSettings {
  readonly view: HostedSessionSettingsView;
}

export interface HostedSessionServiceDiagnostic {
  type: "info" | "warning" | "error";
  message: string;
}

export interface CreateHostedManagedSessionOptions {
  model?: BrewvaRegisteredModel;
  thinkingLevel?: string;
  customTools?: HostedSessionCustomTool[];
  ui?: BrewvaToolUiPort;
  logger?: HostedSessionLogger;
}

export interface HostedSessionServices {
  readonly cwd: string;
  readonly diagnostics: readonly HostedSessionServiceDiagnostic[];
  readonly settings: HostedSessionSettingsView;
  readonly modelCatalog: BrewvaModelCatalog;
  createSession(
    options: CreateHostedManagedSessionOptions,
  ): Promise<Pick<HostedManagedSessionRuntimeResult, "session" | "modelFallbackMessage">>;
}

export interface CreateHostedSessionRuntimeOptions {
  cwd: string;
  settings: HostedSessionSettings;
  runtime?: BrewvaRuntime;
  internalRuntimePlugins?: readonly InternalHostPlugin[];
  requestedModel?: BrewvaRegisteredModel;
  requestedThinkingLevel?: string;
  customTools?: HostedSessionCustomTool[];
  sessionId?: string;
  ui?: BrewvaToolUiPort;
  logger?: HostedSessionLogger;
}

export interface HostedManagedSessionRuntimeResult {
  services: HostedSessionServices;
  session: BrewvaManagedPromptSession;
  modelFallbackMessage?: string;
}

export interface HostedSessionDriver {
  readonly modelCatalog: BrewvaMutableModelCatalog;
  createRuntime(
    options: CreateHostedSessionRuntimeOptions,
  ): Promise<HostedManagedSessionRuntimeResult>;
}

export function createHostedSessionDriver(agentDir: string): HostedSessionDriver {
  return createHostedSessionRuntimeDriver(agentDir);
}

export function createHostedSettingsManager(cwd: string, agentDir: string): HostedSessionSettings {
  return createHostedSessionRuntimeSettings(cwd, agentDir);
}

export function createHostedReadTool(
  cwd: string,
  options?: HostedSessionReadToolOptions,
): HostedSessionCustomTool {
  return createBrewvaReadToolDefinition(cwd, options);
}

export function createHostedEditTool(cwd: string): HostedSessionCustomTool {
  return createBrewvaEditToolDefinition(cwd);
}

export function createHostedWriteTool(cwd: string): HostedSessionCustomTool {
  return createBrewvaWriteToolDefinition(cwd);
}
