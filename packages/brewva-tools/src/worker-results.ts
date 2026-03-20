import type { WorkerApplyReport, WorkerMergeReport } from "@brewva/brewva-runtime";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { BrewvaToolOptions } from "./types.js";
import { failTextResult, inconclusiveTextResult, textResult } from "./utils/result.js";
import { getSessionId } from "./utils/session.js";
import { defineBrewvaTool } from "./utils/tool.js";

function formatMergeReport(report: WorkerMergeReport): string {
  if (report.status === "empty") {
    return ["# Worker Results", "No worker results are currently recorded for this session."].join(
      "\n",
    );
  }

  if (report.status === "conflicts") {
    const lines = [
      "# Worker Results",
      "Merge status: conflicts",
      `Workers: ${report.workerIds.join(", ")}`,
    ];
    for (const conflict of report.conflicts) {
      lines.push(
        `- ${conflict.path} workers=${conflict.workerIds.join(", ")} patch_sets=${conflict.patchSetIds.join(", ")}`,
      );
    }
    return lines.join("\n");
  }

  const changeCount = report.mergedPatchSet?.changes.length ?? 0;
  return [
    "# Worker Results",
    "Merge status: merged",
    `Workers: ${report.workerIds.join(", ")}`,
    `Patch set: ${report.mergedPatchSet?.id ?? "unknown"}`,
    `Changes: ${changeCount}`,
    ...(report.mergedPatchSet?.changes ?? [])
      .slice(0, 24)
      .map((change) => `- ${change.action} ${change.path}`),
  ].join("\n");
}

function formatApplyReport(report: WorkerApplyReport): string {
  if (report.status === "applied") {
    return [
      "# Worker Results Applied",
      `Patch set: ${report.appliedPatchSetId ?? report.mergedPatchSet?.id ?? "unknown"}`,
      `Workers: ${report.workerIds.join(", ")}`,
      `Applied files: ${report.appliedPaths.length}`,
      ...report.appliedPaths.map((path) => `- ${path}`),
    ].join("\n");
  }

  if (report.status === "empty") {
    return [
      "# Worker Results Apply",
      "No worker results are available to merge and apply for this session.",
    ].join("\n");
  }

  if (report.status === "conflicts") {
    return formatMergeReport({
      status: "conflicts",
      workerIds: report.workerIds,
      conflicts: report.conflicts,
      mergedPatchSet: report.mergedPatchSet,
    });
  }

  return [
    "# Worker Results Apply",
    `Apply failed: ${report.reason ?? "unknown"}`,
    ...(report.failedPaths.length > 0
      ? ["Failed paths:", ...report.failedPaths.map((path) => `- ${path}`)]
      : []),
  ].join("\n");
}

export function createWorkerResultsMergeTool(options: BrewvaToolOptions): ToolDefinition {
  return defineBrewvaTool({
    name: "worker_results_merge",
    label: "Worker Results Merge",
    description: "Inspect the current session's recorded worker results and report merge status.",
    promptSnippet:
      "Inspect recorded worker results before deciding whether to adopt or rerun delegated patch work.",
    promptGuidelines: [
      "Use this after patch-producing subagents or workers finish and before applying their merged patch.",
      "Conflicts mean the parent should not apply yet.",
    ],
    parameters: Type.Object({}, { additionalProperties: false }),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const sessionId = getSessionId(ctx);
      const report = options.runtime.session.mergeWorkerResults(sessionId);
      if (report.status === "conflicts") {
        return failTextResult(formatMergeReport(report), {
          ok: false,
          status: report.status,
          workerIds: report.workerIds,
          conflicts: report.conflicts,
          mergedPatchSet: report.mergedPatchSet ?? null,
        });
      }
      if (report.status === "empty") {
        return inconclusiveTextResult(formatMergeReport(report), {
          ok: false,
          status: report.status,
          workerIds: report.workerIds,
          conflicts: [],
        });
      }
      return textResult(formatMergeReport(report), {
        ok: true,
        status: report.status,
        workerIds: report.workerIds,
        conflicts: [],
        mergedPatchSet: report.mergedPatchSet ?? null,
      });
    },
  });
}

export function createWorkerResultsApplyTool(options: BrewvaToolOptions): ToolDefinition {
  return defineBrewvaTool({
    name: "worker_results_apply",
    label: "Worker Results Apply",
    description:
      "Merge recorded worker results for the current session and apply the merged patch set to the parent workspace.",
    promptSnippet:
      "Apply a clean merged worker patch set only after inspecting that the current worker results are conflict-free.",
    promptGuidelines: [
      "Prefer calling worker_results_merge first when the current worker set may conflict.",
      "Use this only when the parent session is ready to adopt the merged worker patch into its own workspace.",
    ],
    parameters: Type.Object({}, { additionalProperties: false }),
    async execute(toolCallId, _params, _signal, _onUpdate, ctx) {
      const sessionId = getSessionId(ctx);
      const report = options.runtime.session.applyMergedWorkerResults(sessionId, {
        toolName: "worker_results_apply",
        toolCallId,
      });
      if (report.status === "applied") {
        return textResult(formatApplyReport(report), {
          ok: true,
          status: report.status,
          workerIds: report.workerIds,
          mergedPatchSet: report.mergedPatchSet ?? null,
          patchSet: report.mergedPatchSet ?? null,
          appliedPatchSetId: report.appliedPatchSetId ?? null,
          appliedPaths: report.appliedPaths,
        });
      }
      if (report.status === "empty") {
        return inconclusiveTextResult(formatApplyReport(report), {
          ok: false,
          status: report.status,
          workerIds: report.workerIds,
          reason: report.reason ?? null,
        });
      }
      return failTextResult(formatApplyReport(report), {
        ok: false,
        status: report.status,
        workerIds: report.workerIds,
        conflicts: report.conflicts,
        mergedPatchSet: report.mergedPatchSet ?? null,
        failedPaths: report.failedPaths,
        reason: report.reason ?? null,
      });
    },
  });
}
