import type { BrewvaToolDefinition as ToolDefinition } from "@brewva/brewva-substrate/tools";
import { buildDefaultBundledBrewvaTools } from "../bundle/index.js";
import type {
  BrewvaBundledToolRuntime,
  BrewvaToolDelegationQuery,
  BrewvaToolOrchestration,
} from "../contracts/index.js";

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
  return {
    ...runtime,
    ...(options.orchestration ? { orchestration: options.orchestration } : {}),
    ...(options.delegation ? { delegation: options.delegation } : {}),
  };
}

export function buildBrewvaTools(options: BuildBrewvaToolsOptions): BuildBrewvaToolsResult {
  const runtime = extendBundledToolRuntime(options.runtime, options);
  const tools = buildDefaultBundledBrewvaTools(runtime);

  if (!options.toolNames || options.toolNames.length === 0) {
    return tools;
  }

  const allowed = new Set(options.toolNames);
  return tools.filter((tool) => allowed.has(tool.name));
}
