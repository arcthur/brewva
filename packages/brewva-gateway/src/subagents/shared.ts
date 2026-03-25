import type {
  BrewvaRuntime,
  ManagedToolMode,
  PatchSet,
  SessionCostSummary,
  ToolExecutionBoundary,
  WorkerResult,
} from "@brewva/brewva-runtime";
import type {
  DelegationPacket,
  SubagentExecutionBoundary,
  SubagentExecutionShape,
  SubagentOutcomeArtifactRef,
  SubagentRunRequest,
} from "@brewva/brewva-tools";
import type { HostedSubagentBuiltinToolName, HostedSubagentProfile } from "./profiles.js";
import { getCanonicalSubagentPrompt, getDefaultProfileNameForResultMode } from "./protocol.js";

const ALL_BUILTIN_SUBAGENT_TOOLS = ["read", "edit", "write"] as const;
const PATCH_MANIFEST_FILE_NAME = "patchset.json";

const BOUNDARY_RANK: Record<ToolExecutionBoundary, number> = {
  safe: 0,
  effectful: 1,
};

function isBuiltinSubagentToolName(value: string): value is HostedSubagentBuiltinToolName {
  return value === "read" || value === "edit" || value === "write";
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
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

export interface ResolvedDelegationProfile {
  profile: HostedSubagentProfile;
  profileName: string;
}

export interface ResolvedDelegationExecutionPlan {
  profile: HostedSubagentProfile;
  profileName: string;
  packet: DelegationPacket;
  boundary: SubagentExecutionBoundary;
  model?: string;
  managedToolMode: ManagedToolMode;
  builtinToolNames: HostedSubagentBuiltinToolName[];
  managedToolNames: string[];
  prompt: string;
}

export function sanitizeFragment(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "");
}

function summarizeAssistantText(text: string): string {
  const normalized = text.replaceAll(/\s+/g, " ").trim();
  if (normalized.length <= 360) {
    return normalized;
  }
  return `${normalized.slice(0, 357)}...`;
}

export function resolveRunSummary(text: string, fallback: string): string {
  const summary = summarizeAssistantText(text);
  return summary || fallback;
}

function boundaryWithinCeiling(
  boundary: ToolExecutionBoundary | undefined,
  ceiling: SubagentExecutionBoundary,
): boolean {
  return BOUNDARY_RANK[boundary ?? "safe"] <= BOUNDARY_RANK[ceiling];
}

function hintedToolNames(packet: DelegationPacket | undefined): string[] {
  return uniqueStrings([
    ...(packet?.executionHints?.preferredTools ?? []),
    ...(packet?.executionHints?.fallbackTools ?? []),
  ]);
}

function mergeBuiltinToolNames(
  profile: HostedSubagentProfile,
  packet: DelegationPacket | undefined,
  boundary: SubagentExecutionBoundary,
): HostedSubagentBuiltinToolName[] {
  const defaults =
    profile.builtinToolNames ??
    (boundary === "effectful" ? [...ALL_BUILTIN_SUBAGENT_TOOLS] : ["read"]);
  const hinted = hintedToolNames(packet).filter(
    (toolName): toolName is HostedSubagentBuiltinToolName => isBuiltinSubagentToolName(toolName),
  );
  return [...new Set([...defaults, ...hinted])];
}

function mergeManagedToolNames(
  profile: HostedSubagentProfile,
  packet: DelegationPacket | undefined,
): string[] {
  const hinted = hintedToolNames(packet).filter((toolName) => !isBuiltinSubagentToolName(toolName));
  return uniqueStrings([...(profile.managedToolNames ?? []), ...hinted]);
}

export function assertDelegationShapeNarrowing(
  profile: HostedSubagentProfile,
  executionShape: SubagentExecutionShape | undefined,
): void {
  if (!executionShape) {
    return;
  }
  if (executionShape.resultMode && executionShape.resultMode !== profile.resultMode) {
    throw new Error("subagent_result_mode_override_not_allowed");
  }
  const profileBoundary = profile.boundary ?? "safe";
  if (
    executionShape.boundary &&
    BOUNDARY_RANK[executionShape.boundary] > BOUNDARY_RANK[profileBoundary]
  ) {
    throw new Error("subagent_effect_ceiling_widening_not_allowed");
  }
  if (profile.managedToolMode === "direct" && executionShape.managedToolMode === "extension") {
    throw new Error("subagent_managed_tool_mode_widening_not_allowed");
  }
}

export function resolveRequestedBoundary(input: {
  profile: HostedSubagentProfile;
  executionShape?: SubagentExecutionShape;
  packet?: DelegationPacket;
}): SubagentExecutionBoundary {
  assertDelegationShapeNarrowing(input.profile, input.executionShape);
  const profileBoundary = input.profile.boundary ?? "safe";
  const shapeBoundary = input.executionShape?.boundary;
  const packetBoundary = input.packet?.effectCeiling?.boundary;
  const effectiveCeiling = mostRestrictiveBoundary(profileBoundary, shapeBoundary);
  if (packetBoundary && BOUNDARY_RANK[packetBoundary] > BOUNDARY_RANK[effectiveCeiling]) {
    throw new Error("subagent_effect_ceiling_widening_not_allowed");
  }
  return mostRestrictiveBoundary(profileBoundary, shapeBoundary, packetBoundary);
}

export function resolveBuiltinToolNamesForRun(
  runtime: BrewvaRuntime,
  profile: HostedSubagentProfile,
  boundary: SubagentExecutionBoundary,
  packet?: DelegationPacket,
): HostedSubagentBuiltinToolName[] {
  const requested = mergeBuiltinToolNames(profile, packet, boundary);
  return requested.filter((toolName) =>
    boundaryWithinCeiling(runtime.tools.getGovernanceDescriptor(toolName)?.boundary, boundary),
  );
}

export function resolveManagedToolNamesForRun(
  runtime: BrewvaRuntime,
  profile: HostedSubagentProfile,
  boundary: SubagentExecutionBoundary,
  packet?: DelegationPacket,
): string[] {
  const requested = mergeManagedToolNames(profile, packet);
  return requested.filter((toolName) => {
    if (
      toolName === "subagent_run" ||
      toolName === "subagent_fanout" ||
      toolName === "subagent_status" ||
      toolName === "subagent_cancel"
    ) {
      return false;
    }
    return boundaryWithinCeiling(
      runtime.tools.getGovernanceDescriptor(toolName)?.boundary,
      boundary,
    );
  });
}

export function resolveDelegationProfile(input: {
  profiles: ReadonlyMap<string, HostedSubagentProfile>;
  request: Pick<SubagentRunRequest, "profile" | "executionShape">;
}): ResolvedDelegationProfile {
  if (input.request.profile) {
    const profile = input.profiles.get(input.request.profile);
    if (!profile) {
      throw new Error(`unknown_profile:${input.request.profile}`);
    }
    assertDelegationShapeNarrowing(profile, input.request.executionShape);
    return {
      profile,
      profileName: profile.name,
    };
  }

  const resultMode = input.request.executionShape?.resultMode;
  if (!resultMode) {
    throw new Error("missing_profile_or_execution_shape_result_mode");
  }
  const defaultProfileName = getDefaultProfileNameForResultMode(resultMode);
  const profile = input.profiles.get(defaultProfileName);
  if (!profile) {
    throw new Error(`unknown_default_profile:${defaultProfileName}`);
  }
  assertDelegationShapeNarrowing(profile, {
    ...input.request.executionShape,
    resultMode,
  });
  return {
    profile,
    profileName: profile.name,
  };
}

export function resolveDelegationExecutionPlan(input: {
  runtime: BrewvaRuntime;
  profile: HostedSubagentProfile;
  profileName?: string;
  packet: DelegationPacket;
  executionShape?: SubagentExecutionShape;
}): ResolvedDelegationExecutionPlan {
  const boundary = resolveRequestedBoundary({
    profile: input.profile,
    executionShape: input.executionShape,
    packet: input.packet,
  });
  const managedToolMode =
    input.executionShape?.managedToolMode ?? input.profile.managedToolMode ?? "direct";
  const prompt = input.profile.prompt ?? getCanonicalSubagentPrompt(input.profile.resultMode);
  return {
    profile: input.profile,
    profileName: input.profileName ?? input.profile.name,
    packet: input.packet,
    boundary,
    model: input.executionShape?.model ?? input.profile.model,
    managedToolMode,
    builtinToolNames: resolveBuiltinToolNamesForRun(
      input.runtime,
      input.profile,
      boundary,
      input.packet,
    ),
    managedToolNames: resolveManagedToolNamesForRun(
      input.runtime,
      input.profile,
      boundary,
      input.packet,
    ),
    prompt,
  };
}

export function aggregateChildCost(
  runtime: BrewvaRuntime,
  parentSessionId: string,
  childSummary: SessionCostSummary,
): void {
  for (const [model, totals] of Object.entries(childSummary.models)) {
    if (totals.totalTokens <= 0 && totals.totalCostUsd <= 0) {
      continue;
    }
    runtime.cost.recordAssistantUsage({
      sessionId: parentSessionId,
      model,
      inputTokens: totals.inputTokens,
      outputTokens: totals.outputTokens,
      cacheReadTokens: totals.cacheReadTokens,
      cacheWriteTokens: totals.cacheWriteTokens,
      totalTokens: totals.totalTokens,
      costUsd: totals.totalCostUsd,
      stopReason: "subagent_run",
    });
  }
}

export function buildWorkerResult(input: {
  workerId: string;
  summary: string;
  patches?: PatchSet;
  errorMessage?: string;
}): WorkerResult {
  if (input.errorMessage) {
    return {
      workerId: input.workerId,
      status: "error",
      summary: input.summary,
      patches: input.patches,
      errorMessage: input.errorMessage,
    };
  }

  return {
    workerId: input.workerId,
    status: input.patches ? "ok" : "skipped",
    summary: input.summary,
    patches: input.patches,
  };
}

export function buildPatchArtifactRefs(
  patches: PatchSet | undefined,
): SubagentOutcomeArtifactRef[] | undefined {
  if (!patches) {
    return undefined;
  }
  const refs: SubagentOutcomeArtifactRef[] = [
    {
      kind: "patch_manifest",
      path: `.orchestrator/subagent-patch-artifacts/${patches.id}/${PATCH_MANIFEST_FILE_NAME}`,
      summary: `Patch manifest for ${patches.id}`,
    },
    ...patches.changes
      .filter((change) => typeof change.artifactRef === "string" && change.artifactRef.length > 0)
      .map((change) => ({
        kind: "patch_file",
        path: change.artifactRef!,
        summary: `${change.action} ${change.path}`,
      })),
  ];
  return refs;
}
