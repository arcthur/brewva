import { DEFAULT_BREWVA_CONFIG } from "@brewva/brewva-runtime";
import type { BrewvaConfig } from "@brewva/brewva-runtime";
import type { ToolBoxPolicy } from "@brewva/brewva-runtime/governance";
import { resolveBoundaryPolicy } from "@brewva/brewva-runtime/security";
import type { ResolvedBoundaryPolicy, ShellCommandAnalysis } from "@brewva/brewva-runtime/security";
import type { BrewvaBundledToolRuntime } from "../../../contracts/index.js";
import { cloneBoxConfig } from "../box-plane-runtime.js";
import type { BoxConfig, ExecutionBackend, SecurityMode } from "./shared.js";

const TOOL_NAME_COMMAND_HINTS = new Set(["workbench_compact"]);

export const DENY_LIST_BEST_EFFORT_MESSAGE =
  "security.boundaryPolicy.commandDenyList is best-effort and must not be treated as a complete shell security boundary.";

export interface ResolvedExecutionPolicy {
  mode: SecurityMode;
  configuredBackend: ExecutionBackend;
  backend: "host" | "box";
  routingPolicy: "direct";
  denyListBestEffort: true;
  commandDenyList: Set<string>;
  boundaryPolicy: ResolvedBoundaryPolicy;
  box: BoxConfig;
  boxPolicy?: ToolBoxPolicy;
}

export function resolveMisroutedToolName(primaryTokens: string[]): string | undefined {
  return primaryTokens.find((token) => TOOL_NAME_COMMAND_HINTS.has(token));
}

export function resolveExecutionPolicy(
  runtime: BrewvaBundledToolRuntime | undefined,
  boxPolicy: ToolBoxPolicy | undefined,
): ResolvedExecutionPolicy {
  const security = runtime?.config?.security ?? DEFAULT_BREWVA_CONFIG.security;
  const execution = security.execution;
  const boundaryPolicy = resolveBoundaryPolicy(security as BrewvaConfig["security"]);
  const configuredBackend = execution.backend;
  const backend = resolvePreferredBackend({
    mode: security.mode,
    configuredBackend,
  });

  return {
    mode: security.mode,
    configuredBackend,
    backend,
    routingPolicy: "direct",
    denyListBestEffort: true,
    commandDenyList: boundaryPolicy.commandDenyList,
    boundaryPolicy,
    box: applyToolBoxPolicy(cloneBoxConfig(execution.box as BoxConfig), boxPolicy),
    boxPolicy,
  };
}

export function applyToolBoxPolicy(
  box: BoxConfig,
  boxPolicy: ToolBoxPolicy | undefined,
): BoxConfig {
  if (!boxPolicy || boxPolicy.kind !== "box_required") return box;
  const networkAllowlist = boxPolicy.networkAllowlist
    ?.map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  const normalizedNetworkAllowlist = networkAllowlist
    ? [...new Set(networkAllowlist)].toSorted()
    : undefined;
  return {
    ...box,
    image: boxPolicy.imageOverride ?? box.image,
    scopeDefault: boxPolicy.scopeKind ?? box.scopeDefault,
    network:
      normalizedNetworkAllowlist && normalizedNetworkAllowlist.length > 0
        ? { mode: "allowlist", allow: normalizedNetworkAllowlist }
        : box.network,
  };
}

export function resolvePreferredBackend(input: {
  mode: SecurityMode;
  configuredBackend: ExecutionBackend;
}): "host" | "box" {
  if (input.mode === "strict") {
    return "box";
  }
  return input.configuredBackend;
}

export function shouldSnapshotBeforeBoxExec(input: {
  commandPolicy: ShellCommandAnalysis | undefined;
  boxPolicy: ToolBoxPolicy | undefined;
}): boolean {
  return (
    input.boxPolicy?.requiresSnapshotBefore === true ||
    input.commandPolicy?.effects.includes("workspace_write") === true
  );
}
