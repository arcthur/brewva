import type {
  BrewvaRuntime,
  PatchSet,
  SessionCostSummary,
  ToolExecutionBoundary,
  WorkerResult,
} from "@brewva/brewva-runtime";
import type {
  DelegationPacket,
  SubagentExecutionBoundary,
  SubagentOutcomeArtifactRef,
} from "@brewva/brewva-tools";
import type { HostedSubagentBuiltinToolName, HostedSubagentProfile } from "./profiles.js";

const ALL_BUILTIN_SUBAGENT_TOOLS = ["read", "edit", "write"] as const;
const PATCH_MANIFEST_FILE_NAME = "patchset.json";

const BOUNDARY_RANK: Record<ToolExecutionBoundary, number> = {
  safe: 0,
  effectful: 1,
};

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

export function resolveRequestedBoundary(
  profile: HostedSubagentProfile,
  packet: DelegationPacket | undefined,
): SubagentExecutionBoundary {
  const profileBoundary = profile.boundary ?? "safe";
  const requestedBoundary = packet?.effectCeiling?.boundary ?? profileBoundary;
  if (profileBoundary === "safe" && requestedBoundary === "effectful") {
    throw new Error("subagent_effect_ceiling_widening_not_allowed");
  }
  return requestedBoundary;
}

export function resolveBuiltinToolNamesForRun(
  runtime: BrewvaRuntime,
  profile: HostedSubagentProfile,
  boundary: SubagentExecutionBoundary,
): HostedSubagentBuiltinToolName[] {
  const requested =
    profile.builtinToolNames ??
    (boundary === "effectful" ? [...ALL_BUILTIN_SUBAGENT_TOOLS] : ["read"]);

  return [...new Set(requested)].filter((toolName) =>
    boundaryWithinCeiling(runtime.tools.getGovernanceDescriptor(toolName)?.boundary, boundary),
  );
}

export function resolveManagedToolNamesForRun(
  runtime: BrewvaRuntime,
  profile: HostedSubagentProfile,
  boundary: SubagentExecutionBoundary,
): string[] {
  const requested = profile.managedToolNames ?? [];
  return [...new Set(requested)].filter((toolName) => {
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
