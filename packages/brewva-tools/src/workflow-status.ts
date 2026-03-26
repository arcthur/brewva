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

async function listPendingDelegationOutcomes(options: BrewvaToolOptions, sessionId: string) {
  const readModelResults = options.runtime.delegation?.listPendingOutcomes?.(sessionId, {
    limit: 6,
  });
  if (readModelResults) {
    return readModelResults;
  }
  const adapter = options.runtime.orchestration?.subagents;
  if (!adapter?.status) {
    return [];
  }
  const result = await adapter.status({
    fromSessionId: sessionId,
    query: {
      statuses: ["completed", "failed", "timeout", "cancelled"],
      includeTerminal: true,
      limit: 6,
    },
  });
  if (!result.ok) {
    return [];
  }
  return result.runs.filter((run) => run.delivery?.handoffState === "pending_parent_turn");
}

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
  qa: WorkflowLaneStatus;
  verification: WorkflowLaneStatus;
  ship: WorkflowLaneStatus;
  acceptance: "not_required" | WorkflowLaneStatus;
}): "pass" | "fail" | "inconclusive" {
  if (input.ship === "ready") return "pass";
  if (
    input.ship === "blocked" ||
    input.acceptance === "blocked" ||
    laneVerdict(input.review) === "fail" ||
    laneVerdict(input.qa) === "fail" ||
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
  const coreArtifacts = artifacts.filter((artifact) => artifact.kind !== "ship_posture");
  const shipPostureArtifact = artifacts.find((artifact) => artifact.kind === "ship_posture");
  return [...coreArtifacts, ...(shipPostureArtifact ? [shipPostureArtifact] : [])].slice(
    0,
    historyLimit,
  );
}

export function createWorkflowStatusTool(options: BrewvaToolOptions): ToolDefinition {
  return defineBrewvaTool({
    name: "workflow_status",
    label: "Workflow Status",
    description:
      "Inspect derived workflow artifacts and posture without prescribing the next step.",
    promptSnippet:
      "Inspect workflow posture, blockers, and the latest derived artifacts before deciding the next move.",
    promptGuidelines: [
      "Use this to understand whether discovery and strategy are present, whether implementation is blocked or pending, and whether review, QA, verification, ship, or retro state needs attention.",
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
      const pendingDelegationOutcomes = await listPendingDelegationOutcomes(options, sessionId);
      const snapshot = deriveWorkflowStatus({
        sessionId,
        events,
        blockers: (taskState.blockers ?? []).map((blocker) => ({
          id: blocker.id,
          message: blocker.message,
        })),
        taskState: {
          spec: taskState.spec,
          status: taskState.status,
          acceptance: taskState.acceptance,
        },
        pendingWorkerResults: pendingWorkerResults.length,
        workspaceRoot: options.runtime.workspaceRoot,
      });

      const posture = snapshot.posture;
      const verdict = overallVerdict({
        review: posture.review,
        qa: posture.qa,
        verification: posture.verification,
        acceptance: posture.acceptance,
        ship: posture.ship,
      });
      const includeArtifacts = params.include_artifacts === true;
      const historyLimit = Math.max(1, Math.min(20, params.history_limit ?? 5));
      const displayArtifacts = selectArtifactsForDisplay(snapshot.artifacts, historyLimit);
      const lines = [
        "[WorkflowStatus]",
        `updated_at: ${formatTimestamp(snapshot.updatedAt)}`,
        `current_workspace_revision: ${snapshot.currentWorkspaceRevision ?? "unavailable"}`,
        `discovery: ${posture.discovery}`,
        `strategy: ${posture.strategy}`,
        `planning: ${posture.planning}`,
        `implementation: ${posture.implementation}`,
        `review: ${posture.review}`,
        `qa: ${posture.qa}`,
        `verification: ${posture.verification}`,
        `acceptance: ${posture.acceptance}`,
        `ship: ${posture.ship}`,
        `retro: ${posture.retro}`,
        `pending_worker_results: ${snapshot.pendingWorkerResults}`,
        `pending_delegation_outcomes: ${pendingDelegationOutcomes.length}`,
      ];

      if (posture.blockers.length > 0) {
        lines.push("blockers:");
        for (const blocker of posture.blockers) {
          lines.push(`- ${blocker}`);
        }
      } else {
        lines.push("blockers:");
        lines.push("- none");
      }

      if (pendingDelegationOutcomes.length > 0) {
        lines.push("pending_delegation_outcome_runs:");
        for (const run of pendingDelegationOutcomes) {
          lines.push(
            `- ${run.delegate}/${run.label ?? run.runId}: ${run.status}${run.summary ? ` :: ${run.summary}` : ""}`,
          );
        }
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
            posture,
            artifacts: includeArtifacts ? displayArtifacts : [],
            pendingWorkerResults: pendingWorkerResults.map((result) => ({
              workerId: result.workerId,
              status: result.status,
              summary: result.summary,
            })),
            pendingDelegationOutcomes: pendingDelegationOutcomes.map((run) => ({
              runId: run.runId,
              delegate: run.delegate,
              label: run.label,
              status: run.status,
              summary: run.summary,
              handoffState: run.delivery?.handoffState ?? null,
            })),
            updatedAt: snapshot.updatedAt,
          },
          verdict,
        ),
      );
    },
  });
}
