import type { BrewvaRuntimeRoot } from "@brewva/brewva-runtime";
import type {
  DelegationModelRouteRecord,
  DelegationIsolationStrategy,
  DelegationVisibility,
} from "@brewva/brewva-runtime/delegation";
import type { ToolExecutionBoundary } from "@brewva/brewva-runtime/governance";
import { deriveToolGovernanceDescriptor } from "@brewva/brewva-runtime/governance";
import type { ManagedToolMode } from "@brewva/brewva-runtime/session";
import { uniqueNonEmptyStrings as uniqueStrings } from "@brewva/brewva-std/collections";
import type {
  DelegationPacket,
  SubagentExecutionBoundary,
  SubagentExecutionShape,
} from "@brewva/brewva-tools/contracts";
import {
  resolveDelegationModelRoute,
  type DelegationModelRoutingContext,
} from "./model-routing.js";
import { getCanonicalSubagentPrompt } from "./protocol.js";
import type { HostedDelegationBuiltinToolName, HostedDelegationTarget } from "./targets.js";

const ALL_BUILTIN_SUBAGENT_TOOLS = ["read", "edit", "write"] as const;

const BOUNDARY_RANK: Record<ToolExecutionBoundary, number> = {
  safe: 0,
  effectful: 1,
};

function isBuiltinSubagentToolName(value: string): value is HostedDelegationBuiltinToolName {
  return value === "read" || value === "edit" || value === "write";
}

function mostRestrictiveBoundary(
  ...boundaries: Array<SubagentExecutionBoundary | undefined>
): SubagentExecutionBoundary {
  const defined = boundaries.filter((entry): entry is SubagentExecutionBoundary => Boolean(entry));
  if (defined.length === 0) {
    return "safe";
  }
  return defined.reduce((best, candidate) =>
    BOUNDARY_RANK[candidate] < BOUNDARY_RANK[best] ? candidate : best,
  );
}

function boundaryWithinCeiling(
  boundary: ToolExecutionBoundary | undefined,
  ceiling: SubagentExecutionBoundary,
): boolean {
  return BOUNDARY_RANK[boundary ?? "safe"] <= BOUNDARY_RANK[ceiling];
}

function resolveRuntimeToolBoundary(
  runtime: BrewvaRuntimeRoot,
  toolName: string,
): ToolExecutionBoundary | undefined {
  const policy = runtime.inspect.tools.access.getActionPolicy(toolName);
  return policy ? deriveToolGovernanceDescriptor(policy).boundary : undefined;
}

function hintedToolNames(packet: DelegationPacket | undefined): string[] {
  return uniqueStrings([
    ...(packet?.executionHints?.preferredTools ?? []),
    ...(packet?.executionHints?.fallbackTools ?? []),
  ]);
}

function mergeBuiltinToolNames(
  target: HostedDelegationTarget,
  packet: DelegationPacket | undefined,
  boundary: SubagentExecutionBoundary,
): HostedDelegationBuiltinToolName[] {
  const defaults =
    target.builtinToolNames ??
    (boundary === "effectful" ? [...ALL_BUILTIN_SUBAGENT_TOOLS] : ["read"]);
  const hinted = uniqueStrings([...hintedToolNames(packet)]).filter(
    (toolName): toolName is HostedDelegationBuiltinToolName => isBuiltinSubagentToolName(toolName),
  );
  if (hinted.length === 0) {
    return [...defaults];
  }
  const allowed = new Set(defaults);
  return [
    ...hinted.filter((toolName) => allowed.has(toolName)),
    ...defaults.filter((toolName) => !hinted.includes(toolName)),
  ];
}

function mergeManagedToolNames(
  target: HostedDelegationTarget,
  packet: DelegationPacket | undefined,
): string[] {
  const hinted = uniqueStrings([...hintedToolNames(packet)]).filter(
    (toolName) => !isBuiltinSubagentToolName(toolName),
  );
  const defaults = target.managedToolNames ?? [];
  if (hinted.length === 0) {
    return [...defaults];
  }
  const allowed = new Set(defaults);
  return [
    ...hinted.filter((toolName) => allowed.has(toolName)),
    ...defaults.filter((toolName) => !hinted.includes(toolName)),
  ];
}

function assertConsultPacketContract(
  target: HostedDelegationTarget,
  packet: DelegationPacket,
): void {
  if (target.resultMode !== "consult") {
    return;
  }
  if (!target.consultKind) {
    throw new Error("missing_consult_kind");
  }
  if (!packet.consultBrief) {
    throw new Error("missing_consult_brief");
  }
}

export interface ResolvedDelegationExecutionPlan {
  target: HostedDelegationTarget;
  delegate: string;
  packet: DelegationPacket;
  boundary: SubagentExecutionBoundary;
  model?: string;
  modelRoute?: DelegationModelRouteRecord;
  managedToolMode: ManagedToolMode;
  builtinToolNames: HostedDelegationBuiltinToolName[];
  managedToolNames: string[];
  producesPatches: boolean;
  visibility: DelegationVisibility;
  isolationStrategy: DelegationIsolationStrategy;
  prompt: string;
}

export function assertDelegationShapeNarrowing(
  target: HostedDelegationTarget,
  executionShape: SubagentExecutionShape | undefined,
): void {
  if (!executionShape) {
    return;
  }
  const targetBoundary = target.boundary ?? "safe";
  if (
    executionShape.boundary &&
    BOUNDARY_RANK[executionShape.boundary] > BOUNDARY_RANK[targetBoundary]
  ) {
    throw new Error("subagent_effect_ceiling_widening_not_allowed");
  }
  if (target.managedToolMode === "direct" && executionShape.managedToolMode === "hosted") {
    throw new Error("subagent_managed_tool_mode_widening_not_allowed");
  }
}

export function resolveRequestedBoundary(input: {
  target: HostedDelegationTarget;
  executionShape?: SubagentExecutionShape;
  packet?: DelegationPacket;
  skillBoundaryCeiling?: SubagentExecutionBoundary;
}): SubagentExecutionBoundary {
  assertDelegationShapeNarrowing(input.target, input.executionShape);
  const targetBoundary = input.target.boundary ?? "safe";
  const shapeBoundary = input.executionShape?.boundary;
  const packetBoundary = input.packet?.effectCeiling?.boundary;
  const effectiveCeiling = mostRestrictiveBoundary(
    targetBoundary,
    shapeBoundary,
    input.skillBoundaryCeiling,
  );
  if (packetBoundary && BOUNDARY_RANK[packetBoundary] > BOUNDARY_RANK[effectiveCeiling]) {
    throw new Error("subagent_effect_ceiling_widening_not_allowed");
  }
  return mostRestrictiveBoundary(
    targetBoundary,
    shapeBoundary,
    packetBoundary,
    input.skillBoundaryCeiling,
  );
}

export function resolveBuiltinToolNamesForRun(
  runtime: BrewvaRuntimeRoot,
  target: HostedDelegationTarget,
  boundary: SubagentExecutionBoundary,
  packet?: DelegationPacket,
): HostedDelegationBuiltinToolName[] {
  const requested = mergeBuiltinToolNames(target, packet, boundary);
  return requested.filter((toolName) =>
    boundaryWithinCeiling(resolveRuntimeToolBoundary(runtime, toolName), boundary),
  );
}

export function resolveManagedToolNamesForRun(
  runtime: BrewvaRuntimeRoot,
  target: HostedDelegationTarget,
  boundary: SubagentExecutionBoundary,
  packet?: DelegationPacket,
): string[] {
  const requested = mergeManagedToolNames(target, packet);
  return requested.filter((toolName) => {
    if (
      toolName === "subagent_run" ||
      toolName === "subagent_fanout" ||
      toolName === "subagent_fork" ||
      toolName === "subagent_run_diagnostic" ||
      toolName === "subagent_status" ||
      toolName === "subagent_cancel"
    ) {
      return false;
    }
    return boundaryWithinCeiling(resolveRuntimeToolBoundary(runtime, toolName), boundary);
  });
}

export function resolveDelegationExecutionPlan(input: {
  runtime: BrewvaRuntimeRoot;
  target: HostedDelegationTarget;
  delegate?: string;
  packet: DelegationPacket;
  executionShape?: SubagentExecutionShape;
  modelRouting?: DelegationModelRoutingContext;
  preselectedModelRoute?: DelegationModelRouteRecord;
}): ResolvedDelegationExecutionPlan {
  assertConsultPacketContract(input.target, input.packet);
  const boundary = resolveRequestedBoundary({
    target: input.target,
    executionShape: input.executionShape,
    packet: input.packet,
  });
  const managedToolMode =
    input.executionShape?.managedToolMode ?? input.target.managedToolMode ?? "direct";
  const prompt =
    input.target.executorPreamble ??
    getCanonicalSubagentPrompt(input.target.resultMode, input.target.consultKind);
  const routedModel = resolveDelegationModelRoute({
    target: input.target,
    packet: input.packet,
    executionShape: input.executionShape,
    modelRouting: input.modelRouting,
    preselectedModelRoute: input.preselectedModelRoute,
  });
  return {
    target: input.target,
    delegate:
      input.delegate ??
      input.target.agentSpecName ??
      input.target.envelopeName ??
      input.target.name,
    packet: input.packet,
    boundary,
    model: routedModel.model,
    modelRoute: routedModel.modelRoute,
    managedToolMode,
    builtinToolNames: resolveBuiltinToolNamesForRun(
      input.runtime,
      input.target,
      boundary,
      input.packet,
    ),
    managedToolNames: resolveManagedToolNamesForRun(
      input.runtime,
      input.target,
      boundary,
      input.packet,
    ),
    producesPatches: input.target.producesPatches,
    visibility: input.target.visibility,
    isolationStrategy: input.target.isolationStrategy,
    prompt,
  };
}
