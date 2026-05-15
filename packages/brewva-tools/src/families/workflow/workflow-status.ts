import { type BrewvaEventRecord } from "@brewva/brewva-runtime/events";
import { TASK_STALL_ADJUDICATED_EVENT_TYPE } from "@brewva/brewva-runtime/events";
import { deriveWorkflowStatus } from "@brewva/brewva-runtime/projection";
import type {
  WorkflowArtifact,
  WorkflowFinishView,
  WorkflowLaneStatus,
} from "@brewva/brewva-runtime/projection";
import { coerceTaskStallAdjudicatedPayload } from "@brewva/brewva-runtime/task";
import type { BrewvaToolDefinition as ToolDefinition } from "@brewva/brewva-substrate/tools";
import { Type } from "@sinclair/typebox";
import type { BrewvaToolOptions } from "../../contracts/index.js";
import { createRuntimeBoundBrewvaToolFactory } from "../../registry/runtime-bound-tool.js";
import { textResult, withVerdict } from "../../utils/result.js";
import { getSessionId } from "../../utils/session.js";

async function listPendingDelegationOutcomes(
  runtime: BrewvaToolOptions["runtime"],
  sessionId: string,
) {
  const readModelResults = runtime.delegation?.listPendingOutcomes?.(sessionId, {
    limit: 6,
  });
  if (readModelResults) {
    return readModelResults;
  }
  const adapter = runtime.orchestration?.subagents;
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

function readMetadataStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function readMetadataBoolean(value: unknown): string {
  return typeof value === "boolean" ? String(value) : "unknown";
}

function readMetadataString(value: unknown, fallback = "none"): string {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}

function renderNormalizationLine(label: string, artifact: WorkflowArtifact | undefined): string {
  const unresolved = readMetadataStringArray(artifact?.metadata?.unresolved);
  const rawPresent = readMetadataBoolean(artifact?.metadata?.raw_present);
  const normalizedPresent = readMetadataBoolean(artifact?.metadata?.normalized_present);
  const partial = readMetadataBoolean(artifact?.metadata?.partial);
  const blockingConsumer = readMetadataString(artifact?.metadata?.blockingConsumer);
  return `${label}: raw_present=${rawPresent} normalized_present=${normalizedPresent} partial=${partial} unresolved=${
    unresolved.length > 0 ? unresolved.join(", ") : "none"
  } blocking_consumer=${blockingConsumer}`;
}

function laneVerdict(status: WorkflowLaneStatus): "pass" | "fail" | "inconclusive" {
  if (status === "ready") return "pass";
  if (status === "blocked") return "fail";
  return "inconclusive";
}

function overallVerdict(input: {
  review: WorkflowLaneStatus;
  verifier: WorkflowLaneStatus;
  verification: WorkflowLaneStatus;
  ship: WorkflowLaneStatus;
  acceptance: "not_required" | WorkflowLaneStatus;
}): "pass" | "fail" | "inconclusive" {
  if (input.ship === "ready") return "pass";
  if (
    input.ship === "blocked" ||
    input.acceptance === "blocked" ||
    laneVerdict(input.review) === "fail" ||
    laneVerdict(input.verifier) === "fail" ||
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

function renderFinishView(finish: WorkflowFinishView): string[] {
  return [
    "[Finish]",
    `state: ${finish.state}`,
    `summary: ${finish.summary}`,
    `completed: ${finish.completed}`,
    `verified: ${finish.verified}`,
    `acceptance: ${finish.acceptance}`,
    `ship: ${finish.ship}`,
    `deliverable: ${finish.deliverable}`,
    `missing_evidence: ${
      finish.missingEvidence.length > 0 ? finish.missingEvidence.join(", ") : "none"
    }`,
    `blockers: ${finish.blockers.length > 0 ? finish.blockers.length : "none"}`,
  ];
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

function readLatestStallAdjudication(events: BrewvaEventRecord[]) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!event || event.type !== TASK_STALL_ADJUDICATED_EVENT_TYPE) {
      continue;
    }
    const payload = coerceTaskStallAdjudicatedPayload(event.payload);
    if (payload) {
      return payload;
    }
  }
  return null;
}

function findLatestArtifactByKind(
  artifacts: readonly WorkflowArtifact[],
  kind: WorkflowArtifact["kind"],
): WorkflowArtifact | undefined {
  return artifacts.find((artifact) => artifact.kind === kind);
}

export function createWorkflowStatusTool(options: BrewvaToolOptions): ToolDefinition {
  const workflowStatusTool = createRuntimeBoundBrewvaToolFactory(
    options.runtime,
    "workflow_status",
  );
  return workflowStatusTool.define({
    name: "workflow_status",
    label: "Workflow Status",
    description:
      "Inspect derived workflow artifacts and posture without prescribing the next step.",
    promptSnippet:
      "Inspect workflow posture, blockers, and the latest derived artifacts before deciding the next move.",
    promptGuidelines: [
      "Use this to understand whether discovery and strategy are present, whether implementation is blocked or pending, and whether review, Verifier, verification, ship, or retro state needs attention.",
      "Treat the result as advisory state; it does not force a workflow path.",
    ],
    parameters: Type.Object({
      include_artifacts: Type.Optional(Type.Boolean()),
      history_limit: Type.Optional(Type.Number({ minimum: 1, maximum: 20 })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const sessionId = getSessionId(ctx);
      const events = workflowStatusTool.runtime.inspect.events.records.query(sessionId);
      const taskState = workflowStatusTool.runtime.inspect.task.state.get(sessionId);
      const openToolCalls =
        workflowStatusTool.runtime.inspect.session.lifecycle.getOpenToolCalls(sessionId);
      const uncleanShutdownDiagnostic =
        workflowStatusTool.runtime.inspect.session.lifecycle.getUncleanShutdownDiagnostic(
          sessionId,
        );
      const pendingWorkerResults =
        workflowStatusTool.runtime.inspect.session.workerResults.list(sessionId);
      const pendingDelegationOutcomes = await listPendingDelegationOutcomes(
        workflowStatusTool.runtime,
        sessionId,
      );
      const stallAdjudication = readLatestStallAdjudication(events);
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
        pendingDelegationOutcomes: pendingDelegationOutcomes.length,
        workspaceRoot: workflowStatusTool.runtime.identity.workspaceRoot,
      });

      const posture = snapshot.posture;
      const latestDesignArtifact = findLatestArtifactByKind(snapshot.artifacts, "design");
      const latestImplementationArtifact = findLatestArtifactByKind(
        snapshot.artifacts,
        "implementation",
      );
      const latestReviewArtifact = findLatestArtifactByKind(snapshot.artifacts, "review");
      const latestVerifierArtifact = findLatestArtifactByKind(snapshot.artifacts, "verifier");
      const verdict = overallVerdict({
        review: posture.review,
        verifier: posture.verifier,
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
        "",
        ...renderFinishView(snapshot.finish),
        "",
        `discovery: ${posture.discovery}`,
        `strategy: ${posture.strategy}`,
        `planning: ${posture.planning}`,
        `plan_complete: ${posture.plan_complete}`,
        `plan_fresh: ${posture.plan_fresh}`,
        renderNormalizationLine("planning_normalization", latestDesignArtifact),
        `implementation: ${posture.implementation}`,
        renderNormalizationLine("implementation_normalization", latestImplementationArtifact),
        `review_required: ${posture.review_required}`,
        `review: ${posture.review}`,
        renderNormalizationLine("review_normalization", latestReviewArtifact),
        `verifier_required: ${posture.verifier_required}`,
        `verifier: ${posture.verifier}`,
        renderNormalizationLine("verifier_normalization", latestVerifierArtifact),
        `unsatisfied_required_evidence: ${
          posture.unsatisfied_required_evidence.length > 0
            ? posture.unsatisfied_required_evidence.join(", ")
            : "none"
        }`,
        `retro: ${posture.retro}`,
        `pending_worker_results: ${snapshot.pendingWorkerResults}`,
        `pending_delegation_outcomes: ${snapshot.pendingDelegationOutcomes}`,
        `open_tool_calls: ${openToolCalls.length}`,
      ];

      if (uncleanShutdownDiagnostic) {
        lines.push(
          `unclean_shutdown: detected_at=${formatTimestamp(uncleanShutdownDiagnostic.detectedAt)} reasons=${uncleanShutdownDiagnostic.reasons.join(",")} open_tool_calls=${uncleanShutdownDiagnostic.openToolCalls.length} open_turns=${uncleanShutdownDiagnostic.openTurns?.map((record) => record.turn).join(",") ?? "none"} latest_event=${uncleanShutdownDiagnostic.latestEventType ?? "unknown"}`,
        );
      } else {
        lines.push("unclean_shutdown: none");
      }

      if (stallAdjudication) {
        lines.push(
          `stall_adjudication: ${stallAdjudication.decision} source=${stallAdjudication.source} detected_at=${formatTimestamp(
            stallAdjudication.detectedAt,
          )} :: ${stallAdjudication.rationale}`,
        );
      } else {
        lines.push("stall_adjudication: none");
      }

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

      if (openToolCalls.length > 0) {
        lines.push("open_tool_call_details:");
        for (const openToolCall of openToolCalls) {
          lines.push(
            `- ${openToolCall.toolName} id=${openToolCall.toolCallId} opened_at=${formatTimestamp(
              openToolCall.openedAt,
            )}${typeof openToolCall.turn === "number" ? ` turn=${openToolCall.turn}` : ""}`,
          );
        }
      }

      if ((uncleanShutdownDiagnostic?.openTurns?.length ?? 0) > 0) {
        lines.push("open_turn_details:");
        for (const openTurn of uncleanShutdownDiagnostic?.openTurns ?? []) {
          lines.push(`- turn=${openTurn.turn} started_at=${formatTimestamp(openTurn.startedAt)}`);
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
            finish: snapshot.finish,
            artifacts: includeArtifacts ? displayArtifacts : [],
            pendingWorkerResults: pendingWorkerResults.map((result) => ({
              workerId: result.workerId,
              status: result.status,
              summary: result.summary,
            })),
            pendingDelegationOutcomesCount: snapshot.pendingDelegationOutcomes,
            pendingDelegationOutcomes: pendingDelegationOutcomes.map((run) => ({
              runId: run.runId,
              delegate: run.delegate,
              label: run.label,
              status: run.status,
              summary: run.summary,
              handoffState: run.delivery?.handoffState ?? null,
            })),
            openToolCalls,
            uncleanShutdownDiagnostic,
            stallAdjudication,
            updatedAt: snapshot.updatedAt,
          },
          verdict,
        ),
      );
    },
  });
}
