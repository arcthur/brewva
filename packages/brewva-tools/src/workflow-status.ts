import {
  deriveWorkflowStatus,
  type WorkflowArtifact,
  type WorkflowLaneStatus,
} from "@brewva/brewva-runtime";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { BrewvaToolOptions } from "./types.js";
import { textResult, withVerdict } from "./utils/result.js";
import { getSessionId } from "./utils/session.js";
import { defineBrewvaTool } from "./utils/tool.js";

function formatTimestamp(timestamp: number): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    return "unknown";
  }
  return new Date(timestamp).toISOString();
}

function laneVerdict(status: WorkflowLaneStatus): "pass" | "fail" | "inconclusive" {
  if (status === "ready") return "pass";
  if (status === "blocked") return "fail";
  return "inconclusive";
}

function overallVerdict(input: {
  review: WorkflowLaneStatus;
  verification: WorkflowLaneStatus;
  release: "missing" | "ready" | "blocked";
}): "pass" | "fail" | "inconclusive" {
  if (input.release === "ready") return "pass";
  if (
    input.release === "blocked" ||
    laneVerdict(input.review) === "fail" ||
    laneVerdict(input.verification) === "fail"
  ) {
    return "fail";
  }
  return "inconclusive";
}

function renderArtifact(artifact: WorkflowArtifact): string {
  return [
    `- ${artifact.kind}`,
    `state=${artifact.state}`,
    `freshness=${artifact.freshness}`,
    `produced_at=${formatTimestamp(artifact.producedAt)}`,
    `summary=${artifact.summary}`,
  ].join(" | ");
}

function selectArtifactsForDisplay(
  artifacts: readonly WorkflowArtifact[],
  historyLimit: number,
): WorkflowArtifact[] {
  const coreArtifacts = artifacts.filter((artifact) => artifact.kind !== "release_readiness");
  const releaseArtifact = artifacts.find((artifact) => artifact.kind === "release_readiness");
  return [...coreArtifacts, ...(releaseArtifact ? [releaseArtifact] : [])].slice(0, historyLimit);
}

export function createWorkflowStatusTool(options: BrewvaToolOptions): ToolDefinition {
  return defineBrewvaTool({
    name: "workflow_status",
    label: "Workflow Status",
    description:
      "Inspect derived workflow artifacts and readiness without prescribing the next step.",
    promptSnippet:
      "Inspect workflow readiness, blockers, and the latest derived artifacts before deciding the next move.",
    promptGuidelines: [
      "Use this to understand whether planning is present, implementation is blocked, and whether review, verification, or release readiness is missing, stale, or blocked.",
      "Treat the result as advisory state; it does not force a workflow path.",
    ],
    parameters: Type.Object({
      include_artifacts: Type.Optional(Type.Boolean()),
      history_limit: Type.Optional(Type.Number({ minimum: 1, maximum: 20 })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const sessionId = getSessionId(ctx);
      const events = options.runtime.events.query(sessionId);
      const taskState = options.runtime.task.getState(sessionId);
      const pendingWorkerResults = options.runtime.session.listWorkerResults(sessionId);
      const snapshot = deriveWorkflowStatus({
        sessionId,
        events,
        blockers: (taskState.blockers ?? []).map((blocker) => ({
          id: blocker.id,
          message: blocker.message,
        })),
        pendingWorkerResults: pendingWorkerResults.length,
        workspaceRoot: options.runtime.workspaceRoot,
      });

      const readiness = snapshot.readiness;
      const verdict = overallVerdict({
        review: readiness.review,
        verification: readiness.verification,
        release: readiness.release,
      });
      const includeArtifacts = params.include_artifacts === true;
      const historyLimit = Math.max(1, Math.min(20, params.history_limit ?? 5));
      const displayArtifacts = selectArtifactsForDisplay(snapshot.artifacts, historyLimit);
      const lines = [
        "[WorkflowStatus]",
        `updated_at: ${formatTimestamp(snapshot.updatedAt)}`,
        `current_workspace_revision: ${snapshot.currentWorkspaceRevision ?? "unavailable"}`,
        `planning: ${readiness.planning}`,
        `implementation: ${readiness.implementation}`,
        `review: ${readiness.review}`,
        `verification: ${readiness.verification}`,
        `release: ${readiness.release}`,
        `pending_worker_results: ${snapshot.pendingWorkerResults}`,
      ];

      if (readiness.blockers.length > 0) {
        lines.push("blockers:");
        for (const blocker of readiness.blockers) {
          lines.push(`- ${blocker}`);
        }
      } else {
        lines.push("blockers:");
        lines.push("- none");
      }

      if (includeArtifacts) {
        lines.push(`artifacts (latest ${historyLimit}):`);
        if (displayArtifacts.length === 0) {
          lines.push("- none");
        } else {
          for (const artifact of displayArtifacts) {
            lines.push(renderArtifact(artifact));
          }
        }
      }

      return textResult(
        lines.join("\n"),
        withVerdict(
          {
            sessionId,
            currentWorkspaceRevision: snapshot.currentWorkspaceRevision ?? null,
            readiness,
            artifacts: includeArtifacts ? displayArtifacts : [],
            pendingWorkerResults: pendingWorkerResults.map((result) => ({
              workerId: result.workerId,
              status: result.status,
              summary: result.summary,
            })),
            updatedAt: snapshot.updatedAt,
          },
          verdict,
        ),
      );
    },
  });
}
