import type { BrewvaRuntime } from "@brewva/brewva-runtime";
import type {
  BrewvaHostPluginFactory,
  BrewvaManagedPromptSession,
  BrewvaModelCatalog,
  BrewvaMutableModelCatalog,
  BrewvaReadToolDetails,
  BrewvaReadToolOptions,
  BrewvaRegisteredModel,
  BrewvaToolDefinition,
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
  runtimePlugins?: readonly BrewvaHostPluginFactory[];
  requestedModel?: BrewvaRegisteredModel;
  requestedThinkingLevel?: string;
  customTools?: HostedSessionCustomTool[];
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
