import { resolve } from "node:path";
import { BrewvaRuntime, createHostedRuntimePort } from "@brewva/brewva-runtime";
import type { BrewvaHostedRuntimePort } from "@brewva/brewva-runtime";
import { resolveBrewvaAgentDir } from "@brewva/brewva-runtime/config";
import { createTrustedLocalGovernancePort } from "@brewva/brewva-runtime/governance";
import type { ManagedToolMode } from "@brewva/brewva-runtime/session";
import { resolveBrewvaModelSelection } from "../../../../policy/model-routing/api.js";
import { DEFAULT_HOSTED_ROUTING_SCOPES } from "../session-factory.js";
import type { HostedSessionSettingsView } from "../session-factory.js";
import { createHostedSessionFactory, type HostedSessionFactory } from "../session-factory.js";
import type { CreateHostedSessionOptions } from "./session-assembly.js";

export interface HostedEnvironment {
  cwd: string;
  agentDir: string;
  sessionFactory: HostedSessionFactory;
  requestedModelSelection: ReturnType<typeof resolveBrewvaModelSelection>;
}

function sameRoutingScopes(actual: readonly string[], expected: readonly string[]): boolean {
  if (actual.length !== expected.length) {
    return false;
  }
  return actual.every((scope, index) => scope === expected[index]);
}

export function applyRuntimeUiSettings(
  settingsManager: HostedSessionSettingsView,
  uiConfig: BrewvaRuntime["config"]["ui"],
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
  return createHostedRuntimePort(
    options.runtime ??
      new BrewvaRuntime({
        cwd,
        configPath: options.configPath,
        config: options.config,
        agentId: options.agentId,
        governancePort: createTrustedLocalGovernancePort({ profile: "team" }),
        routingScopes: options.routingScopes,
        routingDefaultScopes:
          options.routingScopes && options.routingScopes.length > 0
            ? options.routingDefaultScopes
            : (options.routingDefaultScopes ?? [...DEFAULT_HOSTED_ROUTING_SCOPES]),
      }),
  );
}

export function assertRoutingScopeCompatibility(
  runtime: BrewvaHostedRuntimePort,
  options: CreateHostedSessionOptions,
): void {
  const hasRoutingOverride = Boolean(options.routingScopes && options.routingScopes.length > 0);
  const requestedRoutingScopes = options.routingScopes ? [...new Set(options.routingScopes)] : [];
  if (options.runtime && hasRoutingOverride) {
    const runtimeRoutingEnabled = runtime.config.skills.routing.enabled;
    const runtimeRoutingScopes = [...runtime.config.skills.routing.scopes];
    if (
      !runtimeRoutingEnabled ||
      !sameRoutingScopes(runtimeRoutingScopes, requestedRoutingScopes)
    ) {
      throw new Error(
        "routingScopes must be applied when constructing BrewvaRuntime; createHostedSession no longer mutates runtime.config",
      );
    }
  }
  if (options.runtime && options.routingDefaultScopes && options.routingDefaultScopes.length > 0) {
    throw new Error(
      "routingDefaultScopes must be applied when constructing BrewvaRuntime; createHostedSession does not infer runtime config intent from an existing runtime",
    );
  }
}
