import type { BrewvaToolDefinition as ToolDefinition } from "@brewva/brewva-substrate/tools";
import { buildDefaultBundledBrewvaTools } from "../bundle/index.js";
import type {
  BrewvaBundledToolRuntime,
  BrewvaToolDelegationQuery,
  BrewvaToolOrchestration,
} from "../contracts/index.js";
import {
  createManagedExecProcessRegistryRuntime,
  registerManagedExecProcessRegistryRuntimeHooks,
} from "../families/execution/exec-process-registry/runtime.js";

export interface BuildBrewvaToolsOptions {
  runtime: BrewvaBundledToolRuntime;
  orchestration?: BrewvaToolOrchestration;
  delegation?: BrewvaToolDelegationQuery;
  toolNames?: readonly string[];
}

export type BuildBrewvaToolsResult = ToolDefinition[];

function extendBundledToolRuntime(
  runtime: BrewvaBundledToolRuntime,
  options: Pick<BuildBrewvaToolsOptions, "orchestration" | "delegation">,
): BrewvaBundledToolRuntime {
  const execProcessRegistry =
    runtime.execProcessRegistry ?? createManagedExecProcessRegistryRuntime();
  const extended = {
    ...runtime,
    execProcessRegistry,
    ...(options.orchestration ? { orchestration: options.orchestration } : {}),
    ...(options.delegation ? { delegation: options.delegation } : {}),
  };
  registerManagedExecProcessRegistryRuntimeHooks(extended, execProcessRegistry);
  return {
    ...extended,
  };
}

export function buildBrewvaTools(options: BuildBrewvaToolsOptions): BuildBrewvaToolsResult {
  const runtime = extendBundledToolRuntime(options.runtime, options);
  // The bundle applies the `toolNames` filter internally so tool_chain's sibling
  // resolver spans exactly the visible surface (capability-scope parity).
  return buildDefaultBundledBrewvaTools(runtime, { toolNames: options.toolNames });
}
