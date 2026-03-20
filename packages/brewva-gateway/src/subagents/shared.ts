import type {
  BrewvaRuntime,
  PatchSet,
  SessionCostSummary,
  ToolInvocationPosture,
  WorkerResult,
} from "@brewva/brewva-runtime";
import type {
  DelegationPacket,
  SubagentExecutionPosture,
  SubagentOutcomeArtifactRef,
} from "@brewva/brewva-tools";
import type { HostedSubagentBuiltinToolName, HostedSubagentProfile } from "./profiles.js";

const ALL_BUILTIN_SUBAGENT_TOOLS = ["read", "edit", "write"] as const;
const PATCH_MANIFEST_FILE_NAME = "patchset.json";

const POSTURE_RANK: Record<ToolInvocationPosture, number> = {
  observe: 0,
  reversible_mutate: 1,
  commitment: 2,
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

function postureWithinCeiling(
  posture: ToolInvocationPosture | undefined,
  ceiling: SubagentExecutionPosture,
): boolean {
  return POSTURE_RANK[posture ?? "observe"] <= POSTURE_RANK[ceiling];
}

export function resolveRequestedPosture(
  profile: HostedSubagentProfile,
  packet: DelegationPacket | undefined,
): SubagentExecutionPosture {
  const profilePosture = profile.posture ?? "observe";
  const requestedPosture = packet?.effectCeiling?.posture ?? profilePosture;
  if (profilePosture === "observe" && requestedPosture === "reversible_mutate") {
    throw new Error("subagent_effect_ceiling_widening_not_allowed");
  }
  return requestedPosture;
}

export function resolveBuiltinToolNamesForRun(
  runtime: BrewvaRuntime,
  profile: HostedSubagentProfile,
  posture: SubagentExecutionPosture,
): HostedSubagentBuiltinToolName[] {
  const requested =
    profile.builtinToolNames ??
    (posture === "reversible_mutate" ? [...ALL_BUILTIN_SUBAGENT_TOOLS] : ["read"]);

  return [...new Set(requested)].filter((toolName) =>
    postureWithinCeiling(runtime.tools.getGovernanceDescriptor(toolName)?.posture, posture),
  );
}

export function resolveManagedToolNamesForRun(
  runtime: BrewvaRuntime,
  profile: HostedSubagentProfile,
  posture: SubagentExecutionPosture,
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
    return postureWithinCeiling(runtime.tools.getGovernanceDescriptor(toolName)?.posture, posture);
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
