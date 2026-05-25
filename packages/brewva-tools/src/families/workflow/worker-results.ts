import { existsSync, readFileSync } from "node:fs";
import type { BrewvaToolDefinition as ToolDefinition } from "@brewva/brewva-substrate/tools";
import type {
  WorkerApplyReport,
  WorkerMergeReport,
  WorkerResult,
} from "@brewva/brewva-vocabulary/delegation";
import type {
  PatchConflict,
  PatchFileChange,
  PatchSet,
  SourcePatchIntent,
} from "@brewva/brewva-vocabulary/workbench";
import { Type } from "@sinclair/typebox";
import type { BrewvaToolOptions } from "../../contracts/index.js";
import {
  applyStoredSourcePatchPlan,
  formatSourceAnchor,
  prepareAndStoreSourcePatchPlan,
  recordSourceSnapshot,
  toSourceFileResourceUri,
} from "../../internal/source-patch-gate.js";
import { createRuntimeBoundBrewvaToolFactory } from "../../registry/runtime-bound-tool.js";
import { resolveScopedPath, resolveToolTargetScope } from "../../runtime-port/target-scope.js";
import { mergeWorkerResults } from "../../runtime-port/worker-results.js";
import { failTextResult, inconclusiveTextResult, textResult } from "../../utils/result.js";
import { getSessionId } from "../../utils/session.js";

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
    for (const conflict of report.conflicts ?? []) {
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
    `Apply failed: ${report.reason}`,
    ...(report.failedPaths.length > 0
      ? ["Failed paths:", ...report.failedPaths.map((path) => `- ${path}`)]
      : []),
  ].join("\n");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function workerIdOf(result: WorkerResult, index: number): string {
  const record = asRecord(result);
  return typeof record?.workerId === "string" ? record.workerId : `worker_${index + 1}`;
}

function collectMergeFromWorkerResults(results: readonly WorkerResult[]): WorkerMergeReport {
  const patchEntries = results.flatMap((result, index) => {
    const patches = result.patches;
    return patches
      ? [
          {
            workerId: workerIdOf(result, index),
            patchSet: patches,
          },
        ]
      : [];
  });
  const workerIds = patchEntries.map((entry) => entry.workerId);
  if (patchEntries.length === 0) {
    return { status: "empty", workerIds };
  }

  const byPath = new Map<string, { workerIds: string[]; patchSetIds: string[] }>();
  for (const entry of patchEntries) {
    for (const change of entry.patchSet.changes) {
      const current = byPath.get(change.path) ?? { workerIds: [], patchSetIds: [] };
      current.workerIds.push(entry.workerId);
      current.patchSetIds.push(entry.patchSet.id);
      byPath.set(change.path, current);
    }
  }
  const conflicts: PatchConflict[] = [...byPath.entries()]
    .filter(([, value]) => new Set(value.patchSetIds).size > 1)
    .map(([path, value]) => ({
      path,
      workerIds: [...new Set(value.workerIds)],
      patchSetIds: [...new Set(value.patchSetIds)],
    }));
  if (conflicts.length > 0) {
    return { status: "conflicts", workerIds, conflicts };
  }

  const changes = patchEntries.flatMap((entry) => entry.patchSet.changes);
  const mergedPatchSet: PatchSet = {
    id: `worker_merge_${Date.now().toString(36)}`,
    createdAt: Date.now(),
    summary: `Merged ${patchEntries.length} worker patch set(s)`,
    changes,
  };
  return { status: "merged", workerIds, mergedPatchSet };
}

function readArtifactContent(
  artifactRef: string | undefined,
  scope: ReturnType<typeof resolveToolTargetScope>,
): { ok: true; content: string } | { ok: false; reason: string } {
  if (!artifactRef) {
    return { ok: false, reason: "missing_artifact_ref" };
  }
  const artifactPath = resolveScopedPath(artifactRef, scope);
  if (!artifactPath || !existsSync(artifactPath)) {
    return { ok: false, reason: "artifact_not_found" };
  }
  return { ok: true, content: readFileSync(artifactPath, "utf8") };
}

function fullFileReplaceIntent(input: {
  readonly change: PatchFileChange;
  readonly content: string;
  readonly scope: ReturnType<typeof resolveToolTargetScope>;
  readonly runtime: BrewvaToolOptions["runtime"];
  readonly sessionId: string;
}): SourcePatchIntent | { readonly error: string; readonly path: string } {
  const path = resolveScopedPath(input.change.path, input.scope);
  if (!path || !existsSync(path)) {
    return { error: "target_not_found", path: input.change.path };
  }
  const before = readFileSync(path, "utf8");
  const snapshot = recordSourceSnapshot({
    uri: toSourceFileResourceUri(input.scope, path),
    path,
    sourceText: before,
    runtime: input.runtime,
    sessionId: input.sessionId,
  });
  const first = snapshot.anchors[0];
  const last = snapshot.anchors.at(-1);
  if (!first || !last) {
    return { error: "snapshot_empty", path: input.change.path };
  }
  return {
    kind: "replace_anchor",
    uri: snapshot.uri,
    snapshotId: snapshot.id,
    startAnchor: formatSourceAnchor(first),
    endAnchor: formatSourceAnchor(last),
    replacement: input.content,
  };
}

function sourcePatchIntentsFromPatchSet(input: {
  readonly patchSet: PatchSet;
  readonly scope: ReturnType<typeof resolveToolTargetScope>;
  readonly runtime: BrewvaToolOptions["runtime"];
  readonly sessionId: string;
}):
  | { readonly ok: true; readonly edits: SourcePatchIntent[] }
  | { readonly ok: false; readonly reason: string; readonly path?: string } {
  const edits: SourcePatchIntent[] = [];
  for (const change of input.patchSet.changes) {
    const path = resolveScopedPath(change.path, input.scope);
    if (!path) {
      return { ok: false, reason: "path_outside_target", path: change.path };
    }
    const uri = toSourceFileResourceUri(input.scope, path);
    if (change.action === "add") {
      const artifact = readArtifactContent(change.artifactRef, input.scope);
      if (!artifact.ok) {
        return { ok: false, reason: artifact.reason, path: change.path };
      }
      edits.push({ kind: "create_file", uri, content: artifact.content });
      continue;
    }
    if (change.action === "modify") {
      const artifact = readArtifactContent(change.artifactRef, input.scope);
      if (!artifact.ok) {
        return { ok: false, reason: artifact.reason, path: change.path };
      }
      const intent = fullFileReplaceIntent({
        change,
        content: artifact.content,
        scope: input.scope,
        runtime: input.runtime,
        sessionId: input.sessionId,
      });
      if ("error" in intent) {
        return { ok: false, reason: intent.error, path: intent.path };
      }
      edits.push(intent);
      continue;
    }
    if (change.action === "delete") {
      edits.push({ kind: "delete_file", uri });
      continue;
    }
    if (change.oldPath && change.newPath) {
      const oldPath = resolveScopedPath(change.oldPath, input.scope);
      const newPath = resolveScopedPath(change.newPath, input.scope);
      if (!oldPath || !newPath) {
        return { ok: false, reason: "path_outside_target", path: change.path };
      }
      edits.push({
        kind: "rename_file",
        uri: toSourceFileResourceUri(input.scope, oldPath),
        newUri: toSourceFileResourceUri(input.scope, newPath),
      });
      continue;
    }
    return { ok: false, reason: "unsupported_patch_action", path: change.path };
  }
  return { ok: true, edits };
}

export function createWorkerResultsMergeTool(options: BrewvaToolOptions): ToolDefinition {
  const { runtime, define } = createRuntimeBoundBrewvaToolFactory(
    options.runtime,
    "worker_results_merge",
  );
  return define({
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
      const report = mergeWorkerResults(runtime, sessionId);
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
  const { runtime, define } = createRuntimeBoundBrewvaToolFactory(
    options.runtime,
    "worker_results_apply",
  );
  return define(
    {
      name: "worker_results_apply",
      label: "Worker Results Apply",
      description:
        "Prepare or apply recorded worker results through SourcePatchPlan. Without plan_id this only prepares a plan.",
      promptSnippet:
        "Prepare a clean merged worker patch set, review the SourcePatchPlan, then apply it by plan_id.",
      promptGuidelines: [
        "Prefer calling worker_results_merge first when the current worker set may conflict.",
        "Call without plan_id to prepare a SourcePatchPlan; call with plan_id to apply through the source patch gate.",
      ],
      parameters: Type.Object(
        {
          plan_id: Type.Optional(Type.String({ minLength: 1 })),
        },
        { additionalProperties: false },
      ),
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const sessionId = getSessionId(ctx);
        if (typeof params.plan_id === "string") {
          const scope = resolveToolTargetScope(runtime, ctx);
          const receipt = applyStoredSourcePatchPlan({
            planId: params.plan_id,
            sessionId,
            runtime,
            scope,
          });
          const report: WorkerApplyReport = {
            status: receipt.ok ? "applied" : "apply_failed",
            workerIds: [],
            mergedPatchSet: receipt.patchSet,
            appliedPatchSetId: receipt.patchSet?.id,
            appliedPaths: receipt.result.appliedPaths,
            failedPaths: receipt.result.failedPaths,
            reason: receipt.result.reason,
          };
          if (!receipt.ok) {
            return failTextResult(formatApplyReport(report), {
              ok: false,
              status: report.status,
              workerIds: report.workerIds,
              failedPaths: report.failedPaths,
              reason: report.reason ?? null,
            });
          }
          return textResult(formatApplyReport(report), {
            ok: true,
            status: report.status,
            workerIds: report.workerIds,
            mergedPatchSet: receipt.patchSet ?? null,
            patchSet: receipt.patchSet ?? null,
            appliedPatchSetId: report.appliedPatchSetId ?? null,
            appliedPaths: report.appliedPaths,
          });
        }

        const report = collectMergeFromWorkerResults(
          runtime.capabilities.session.workerResults.list(sessionId),
        );
        if (report.status === "empty") {
          return inconclusiveTextResult(formatMergeReport(report), {
            ok: false,
            status: report.status,
            workerIds: report.workerIds,
            conflicts: [],
          });
        }
        if (report.status === "conflicts") {
          return failTextResult(formatMergeReport(report), {
            ok: false,
            status: report.status,
            workerIds: report.workerIds,
            conflicts: report.conflicts,
          });
        }
        if (!report.mergedPatchSet) {
          return inconclusiveTextResult(
            "# Worker Results Apply\nNo merged patch set was produced.",
            {
              ok: false,
              status: "empty",
              workerIds: report.workerIds,
            },
          );
        }
        const scope = resolveToolTargetScope(runtime, ctx);
        const converted = sourcePatchIntentsFromPatchSet({
          patchSet: report.mergedPatchSet,
          scope,
          runtime,
          sessionId,
        });
        if (!converted.ok) {
          return failTextResult(
            [
              "# Worker Results Apply",
              "Prepare failed",
              `reason: ${converted.reason}`,
              converted.path ? `path: ${converted.path}` : null,
            ]
              .filter(Boolean)
              .join("\n"),
            {
              ok: false,
              status: "prepare_failed",
              reason: converted.reason,
              path: converted.path ?? null,
            },
          );
        }
        const prepared = prepareAndStoreSourcePatchPlan({
          edits: converted.edits,
          scope,
          runtime,
          sessionId,
          summary: report.mergedPatchSet.summary,
        });
        if (!prepared.plan.preflight.ok) {
          return failTextResult(
            [
              "# Worker Results Apply",
              "Prepare failed",
              `Plan: ${prepared.plan.id}`,
              `Reason: ${prepared.plan.preflight.reason ?? "plan_conflict"}`,
              ...prepared.plan.conflicts.map(
                (conflict) => `- ${conflict.reason}: ${conflict.message ?? conflict.uri}`,
              ),
              "",
              prepared.plan.preview,
            ].join("\n"),
            {
              ok: false,
              status: "conflict",
              workerIds: report.workerIds,
              planId: prepared.plan.id,
              plan: prepared.plan,
              conflicts: prepared.plan.conflicts,
              mergedPatchSet: report.mergedPatchSet,
            },
          );
        }
        return textResult(
          [
            "# Worker Results Apply",
            "Prepared SourcePatchPlan",
            `Plan: ${prepared.plan.id}`,
            `Workers: ${report.workerIds.join(", ")}`,
            `Changes: ${prepared.plan.changes.length}`,
            "",
            prepared.plan.preview,
          ].join("\n"),
          {
            ok: true,
            status: "prepared",
            workerIds: report.workerIds,
            planId: prepared.plan.id,
            plan: prepared.plan,
            mergedPatchSet: report.mergedPatchSet,
          },
        );
      },
    },
    {},
  );
}
