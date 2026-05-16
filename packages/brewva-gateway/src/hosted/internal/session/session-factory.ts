import type { BrewvaHostedRuntimePort } from "@brewva/brewva-runtime";
import type { InternalHostPlugin, BrewvaToolUiPort } from "@brewva/brewva-substrate/host-api";
import type {
  BrewvaModelCatalog,
  BrewvaMutableModelCatalog,
  BrewvaRegisteredModel,
} from "@brewva/brewva-substrate/provider";
import type { BrewvaManagedPromptSession } from "@brewva/brewva-substrate/session";
import type {
  BrewvaReadToolDetails,
  BrewvaReadToolOptions,
  BrewvaToolDefinition,
} from "@brewva/brewva-substrate/tools";
import {
  createBrewvaEditToolDefinition,
  createBrewvaReadToolDefinition,
  createBrewvaWriteToolDefinition,
} from "@brewva/brewva-substrate/tools";
import type { ProviderConnectionSeams } from "../provider/connection-types.js";
import type { HostedSessionLogger } from "../shared/logger.js";
import {
  createHostedSessionRuntimeFactory,
  createHostedSessionRuntimeSettings,
} from "./session-runtime.js";

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
  deferPersistenceUntilPrompt?: boolean;
  onInitialPersistence?: (sessionId: string) => void;
  ui?: BrewvaToolUiPort;
  logger?: HostedSessionLogger;
}

export interface HostedSessionServices {
  readonly cwd: string;
  readonly diagnostics: readonly HostedSessionServiceDiagnostic[];
  readonly settings: HostedSessionSettingsView;
  readonly modelCatalog: BrewvaModelCatalog;
  readonly providerConnections?: ProviderConnectionSeams;
  createSession(
    options: CreateHostedManagedSessionOptions,
  ): Promise<Pick<HostedManagedSessionRuntimeResult, "session" | "modelFallbackMessage">>;
}

export interface CreateHostedSessionRuntimeOptions {
  cwd: string;
  settings: HostedSessionSettings;
  runtime?: BrewvaHostedRuntimePort;
  extensions?: readonly InternalHostPlugin[];
  requestedModel?: BrewvaRegisteredModel;
  requestedThinkingLevel?: string;
  customTools?: HostedSessionCustomTool[];
  sessionId?: string;
  deferPersistenceUntilPrompt?: boolean;
  onInitialPersistence?: (sessionId: string) => void;
  ui?: BrewvaToolUiPort;
  logger?: HostedSessionLogger;
}

export interface HostedManagedSessionRuntimeResult {
  services: HostedSessionServices;
  session: BrewvaManagedPromptSession;
  modelFallbackMessage?: string;
}

export interface HostedSessionFactory {
  readonly modelCatalog: BrewvaMutableModelCatalog;
  createRuntime(
    options: CreateHostedSessionRuntimeOptions,
  ): Promise<HostedManagedSessionRuntimeResult>;
}

export function createHostedSessionFactory(agentDir: string): HostedSessionFactory {
  return createHostedSessionRuntimeFactory(agentDir);
}

export function createHostedModelCatalog(agentDir: string): BrewvaModelCatalog {
  return createHostedSessionFactory(agentDir).modelCatalog;
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
