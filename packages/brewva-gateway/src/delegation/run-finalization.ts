import type { BrewvaRuntimeRoot } from "@brewva/brewva-runtime";
import type { SessionCostSummary } from "@brewva/brewva-runtime/cost";
import type { PatchSet, WorkerResult } from "@brewva/brewva-runtime/patch-history";
import type { SubagentOutcomeArtifactRef } from "@brewva/brewva-tools/contracts";

const PATCH_MANIFEST_FILE_NAME = "patchset.json";

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

export function aggregateChildCost(
  runtime: BrewvaRuntimeRoot,
  parentSessionId: string,
  childSummary: SessionCostSummary,
): void {
  for (const [model, totals] of Object.entries(childSummary.models)) {
    if (totals.totalTokens <= 0 && totals.totalCostUsd <= 0) {
      continue;
    }
    runtime.authority.cost.usage.recordAssistant({
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

  if (!input.patches) {
    return {
      workerId: input.workerId,
      status: "skipped",
      summary: input.summary,
    };
  }

  return {
    workerId: input.workerId,
    status: "ok",
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
