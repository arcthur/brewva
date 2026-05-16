import { resolve } from "node:path";
import { createBrewvaRuntime } from "@brewva/brewva-runtime";
import type { BrewvaConfig, BrewvaHostedRuntimePort } from "@brewva/brewva-runtime";
import { resolveBrewvaAgentDir } from "@brewva/brewva-runtime/config";
import { createTrustedLocalGovernancePort } from "@brewva/brewva-runtime/governance";
import type { ManagedToolMode } from "@brewva/brewva-runtime/session";
import { resolveBrewvaModelSelection } from "../../../../policy/model-routing/api.js";
import { toHostedRuntimePort } from "../runtime-ports.js";
import type { HostedSessionSettingsView } from "../session-factory.js";
import { createHostedSessionFactory, type HostedSessionFactory } from "../session-factory.js";
import type { CreateHostedSessionOptions } from "./session-assembly.js";

export interface HostedEnvironment {
  cwd: string;
  agentDir: string;
  sessionFactory: HostedSessionFactory;
  requestedModelSelection: ReturnType<typeof resolveBrewvaModelSelection>;
}

export function applyRuntimeUiSettings(
  settingsManager: HostedSessionSettingsView,
  uiConfig: BrewvaConfig["ui"],
): void {
  settingsManager.applyOverrides({
    quietStartup: uiConfig.quietStartup,
  });
}

export function resolveManagedToolMode(mode: ManagedToolMode | undefined): ManagedToolMode {
  return mode === "direct" ? "direct" : "hosted";
}

export function resolveHostedEnvironment(options: CreateHostedSessionOptions): HostedEnvironment {
  const cwd = resolve(options.cwd ?? process.cwd());
  const agentDir = resolveBrewvaAgentDir();
  const sessionFactory = createHostedSessionFactory(agentDir);
  const requestedModelSelection = resolveBrewvaModelSelection(
    options.model,
    sessionFactory.modelCatalog,
  );
  return {
    cwd,
    agentDir,
    sessionFactory,
    requestedModelSelection,
  };
}

export function createKernelRuntime(
  options: CreateHostedSessionOptions,
  cwd: string,
): BrewvaHostedRuntimePort {
  return toHostedRuntimePort(
    options.runtime ??
      createBrewvaRuntime({
        cwd,
        configPath: options.configPath,
        config: options.config,
        agentId: options.agentId,
        governancePort: createTrustedLocalGovernancePort({ profile: "team" }),
      }),
  );
}

export function assertRoutingScopeCompatibility(
  _runtime: BrewvaHostedRuntimePort,
  _options: CreateHostedSessionOptions,
): void {
  return;
}
