import {
  OPTIMIZATION_LINEAGE_STATUS_VALUES,
  getOrCreateOptimizationContinuityPlane,
  type OptimizationLineageArtifact,
} from "@brewva/brewva-deliberation";
import type { BrewvaToolDefinition as ToolDefinition } from "@brewva/brewva-substrate";
import { Type } from "@sinclair/typebox";
import type { BrewvaToolOptions } from "./types.js";
import { buildStringEnumSchema } from "./utils/input-alias.js";
import { failTextResult, inconclusiveTextResult, textResult } from "./utils/result.js";
import { defineBrewvaTool } from "./utils/tool.js";

const ACTION_VALUES = ["list", "show", "attention"] as const;

const ActionSchema = buildStringEnumSchema(ACTION_VALUES, {});
const StatusSchema = buildStringEnumSchema(OPTIMIZATION_LINEAGE_STATUS_VALUES, {});

function readStatus(
  value: unknown,
): (typeof OPTIMIZATION_LINEAGE_STATUS_VALUES)[number] | undefined {
  return typeof value === "string" &&
    OPTIMIZATION_LINEAGE_STATUS_VALUES.includes(
      value as (typeof OPTIMIZATION_LINEAGE_STATUS_VALUES)[number],
    )
    ? (value as (typeof OPTIMIZATION_LINEAGE_STATUS_VALUES)[number])
    : undefined;
}

function readTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function formatLineageSummary(lineage: OptimizationLineageArtifact): string {
  const lines = [
    `- ${lineage.id}`,
    `  loop_key=${lineage.loopKey}`,
    `  status=${lineage.status}`,
    `  root_session=${lineage.rootSessionId}`,
    `  runs=${lineage.runCount}`,
  ];
  if (lineage.metric?.latestValue !== undefined) {
    const metricUnit = lineage.metric.unit ? ` ${lineage.metric.unit}` : "";
    lines.push(
      `  metric=${lineage.metric.metricKey}:${lineage.metric.latestValue}${metricUnit} (${lineage.metric.trend})`,
    );
  }
  if (lineage.continuation?.nextOwner || lineage.continuation?.nextTrigger) {
    const owner = lineage.continuation.nextOwner ?? "unknown";
    const trigger = lineage.continuation.nextTrigger ?? "unspecified";
    const timing = lineage.continuation.nextRunAt
      ? ` @ ${new Date(lineage.continuation.nextRunAt).toISOString()}`
      : lineage.continuation.nextTiming
        ? ` @ ${lineage.continuation.nextTiming}`
        : "";
    lines.push(`  next=${owner} via ${trigger}${timing}`);
  }
  lines.push(`  summary=${lineage.summary}`);
  return lines.join("\n");
}

function formatLineageDetail(lineage: OptimizationLineageArtifact): string {
  const lines = [
    "# Optimization Continuity",
    `id: ${lineage.id}`,
    `loop_key: ${lineage.loopKey}`,
    `goal_ref: ${lineage.goalRef}`,
    `root_session_id: ${lineage.rootSessionId}`,
    `status: ${lineage.status}`,
    `run_count: ${lineage.runCount}`,
    `first_observed_at: ${new Date(lineage.firstObservedAt).toISOString()}`,
    `last_observed_at: ${new Date(lineage.lastObservedAt).toISOString()}`,
  ];

  if (lineage.goal) {
    lines.push("", "## Goal", lineage.goal);
  }

  if (lineage.scope.length > 0) {
    lines.push("", "## Scope", lineage.scope.join(", "));
  }

  if (lineage.metric) {
    const metricUnit = lineage.metric.unit ? ` ${lineage.metric.unit}` : "";
    lines.push(
      "",
      "## Metric",
      `key: ${lineage.metric.metricKey}`,
      `trend: ${lineage.metric.trend}`,
      `latest: ${lineage.metric.latestValue ?? "none"}${metricUnit}`,
      `baseline: ${lineage.metric.baselineValue ?? "none"}${metricUnit}`,
      `best: ${lineage.metric.bestValue ?? "none"}${metricUnit}`,
      `observations: ${lineage.metric.observationCount}`,
    );
    if (lineage.metric.direction) {
      lines.push(`direction: ${lineage.metric.direction}`);
    }
    if (lineage.metric.aggregation) {
      lines.push(`aggregation: ${lineage.metric.aggregation}`);
    }
    if (lineage.metric.minDelta !== undefined) {
      lines.push(`min_delta: ${lineage.metric.minDelta}`);
    }
  }

  if (lineage.guard) {
    lines.push(
      "",
      "## Guard",
      `key: ${lineage.guard.guardKey}`,
      `last_status: ${lineage.guard.lastStatus ?? "none"}`,
      `observations: ${lineage.guard.observationCount}`,
      `status_counts: ${
        Object.entries(lineage.guard.statusCounts)
          .map(([status, count]) => `${status}=${count}`)
          .join(", ") || "none"
      }`,
    );
  }

  if (lineage.continuation) {
    lines.push(
      "",
      "## Continuation",
      `next_owner: ${lineage.continuation.nextOwner ?? "none"}`,
      `next_trigger: ${lineage.continuation.nextTrigger ?? "none"}`,
      `next_timing: ${lineage.continuation.nextTiming ?? "none"}`,
      `next_objective: ${lineage.continuation.nextObjective ?? "none"}`,
      `next_run_at: ${lineage.continuation.nextRunAt ? new Date(lineage.continuation.nextRunAt).toISOString() : "none"}`,
      `scheduled: ${lineage.continuation.scheduled ? "yes" : "no"}`,
      `schedule_intent_id: ${lineage.continuation.scheduleIntentId ?? "none"}`,
    );
  }

  if (lineage.convergence) {
    lines.push(
      "",
      "## Convergence",
      `status: ${lineage.convergence.status ?? "none"}`,
      `reason_code: ${lineage.convergence.reasonCode ?? "none"}`,
      `summary: ${lineage.convergence.summary ?? "none"}`,
      `should_continue: ${lineage.convergence.shouldContinue ? "yes" : "no"}`,
      `observed_at: ${lineage.convergence.observedAt ? new Date(lineage.convergence.observedAt).toISOString() : "none"}`,
    );
  }

  if (lineage.escalation) {
    lines.push(
      "",
      "## Escalation",
      `owner: ${lineage.escalation.owner ?? "none"}`,
      `trigger: ${lineage.escalation.trigger ?? "none"}`,
      `active: ${lineage.escalation.active ? "yes" : "no"}`,
    );
  }

  if (lineage.lineageSessionIds.length > 0) {
    lines.push("", "## Lineage Sessions", lineage.lineageSessionIds.join(", "));
  }

  if (lineage.sourceSkillNames.length > 0) {
    lines.push("", "## Source Skills", lineage.sourceSkillNames.join(", "));
  }

  lines.push("", "## Summary", lineage.summary);

  if (lineage.evidence.length > 0) {
    lines.push("", "## Evidence");
    for (const evidence of lineage.evidence.slice(0, 10)) {
      lines.push(
        `- session=${evidence.sessionId} event=${evidence.eventId} type=${evidence.eventType} at=${new Date(evidence.timestamp).toISOString()}`,
      );
    }
  }

  return `${lines.join("\n")}\n`;
}

interface OptimizationAttentionSummary {
  lineage: OptimizationLineageArtifact;
  severity: "medium" | "high";
  reasons: string[];
  ageDays: number;
  overdueDays?: number;
}

function evaluateAttention(input: {
  lineage: OptimizationLineageArtifact;
  now: number;
  staleAfterDays: number;
  runCountFloor: number;
}): OptimizationAttentionSummary | undefined {
  const { lineage, now, staleAfterDays, runCountFloor } = input;
  const reasons: string[] = [];
  let severity: OptimizationAttentionSummary["severity"] = "medium";
  const ageDays = Math.max(0, now - lineage.lastObservedAt) / (24 * 60 * 60 * 1000);
  let overdueDays: number | undefined;

  if (lineage.escalation?.active || lineage.status === "escalated") {
    reasons.push("lineage is already escalated");
    severity = "high";
  }
  if (lineage.status === "stuck") {
    reasons.push("lineage is marked stuck");
    severity = "high";
  }
  if (
    lineage.continuation?.scheduled &&
    typeof lineage.continuation.nextRunAt === "number" &&
    lineage.continuation.nextRunAt < now
  ) {
    overdueDays = Math.max(0, now - lineage.continuation.nextRunAt) / (24 * 60 * 60 * 1000);
    reasons.push(`scheduled continuation is overdue by ${overdueDays.toFixed(1)} day(s)`);
  }
  if (lineage.status !== "converged" && ageDays >= staleAfterDays) {
    reasons.push(`lineage has been quiet for ${ageDays.toFixed(1)} day(s)`);
  }
  if (lineage.status !== "converged" && lineage.runCount >= runCountFloor) {
    reasons.push(`lineage has already consumed ${lineage.runCount} run(s)`);
  }

  if (reasons.length === 0) {
    return undefined;
  }
  if (reasons.length >= 3 && severity !== "high") {
    severity = "high";
  }

  return {
    lineage,
    severity,
    reasons,
    ageDays,
    overdueDays,
  };
}

function formatAttentionSummary(summary: OptimizationAttentionSummary): string {
  const lines = [
    `- ${summary.lineage.id}`,
    `  severity=${summary.severity}`,
    `  loop_key=${summary.lineage.loopKey}`,
    `  status=${summary.lineage.status}`,
    `  runs=${summary.lineage.runCount}`,
    `  age_days=${summary.ageDays.toFixed(1)}`,
  ];
  if (summary.overdueDays !== undefined) {
    lines.push(`  overdue_days=${summary.overdueDays.toFixed(1)}`);
  }
  lines.push(`  reasons=${summary.reasons.join(" | ")}`);
  lines.push(`  summary=${summary.lineage.summary}`);
  return lines.join("\n");
}

export function createOptimizationContinuityTool(options: BrewvaToolOptions): ToolDefinition {
  return defineBrewvaTool({
    name: "optimization_continuity",
    label: "Optimization Continuity",
    description:
      "Inspect bounded optimization lineages derived from goal-loop outputs, schedule continuity, and iteration facts.",
    promptSnippet:
      "Use this to inspect continuation, convergence, and escalation helpers for existing goal-loop lineages without inventing planner state.",
    promptGuidelines: [
      "List the current lineages before asking for show when multiple branches may share the same loop_key.",
      "This tool is inspection-only. It does not schedule new work or mutate runtime authority.",
    ],
    parameters: Type.Object({
      action: ActionSchema,
      lineage_id: Type.Optional(Type.String({ minLength: 1 })),
      loop_key: Type.Optional(Type.String({ minLength: 1 })),
      status: Type.Optional(StatusSchema),
      stale_after_days: Type.Optional(Type.Integer({ minimum: 1, maximum: 365 })),
      run_count_floor: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
      as_of_ms: Type.Optional(Type.Integer({ minimum: 0 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
    }),
    async execute(_toolCallId, params) {
      const plane = getOrCreateOptimizationContinuityPlane(options.runtime);
      const status = readStatus(params.status);
      const loopKey = readTrimmedString(params.loop_key);
      const lineageId = readTrimmedString(params.lineage_id);
      const limit = Math.max(1, Math.min(20, params.limit ?? 10));
      const staleAfterDays = Math.max(1, Math.min(365, params.stale_after_days ?? 3));
      const runCountFloor = Math.max(1, Math.min(100, params.run_count_floor ?? 4));
      const now = params.as_of_ms ?? Date.now();

      if (params.action === "list") {
        const lineages = plane.list({
          status,
          loopKey,
          limit,
        });
        if (lineages.length === 0) {
          return inconclusiveTextResult(
            "No optimization continuity lineages match the current filter.",
            {
              ok: false,
              status: status ?? null,
              loopKey: loopKey ?? null,
              lineages: [],
            },
          );
        }
        return textResult(
          [
            "# Optimization Continuity Lineages",
            `count: ${lineages.length}`,
            ...lineages.map(formatLineageSummary),
          ].join("\n"),
          {
            ok: true,
            status: status ?? null,
            loopKey: loopKey ?? null,
            lineages,
          },
        );
      }

      if (params.action === "attention") {
        const attention = plane
          .list({
            status,
            loopKey,
            limit: Math.max(limit * 3, limit),
          })
          .map((lineage) =>
            evaluateAttention({
              lineage,
              now,
              staleAfterDays,
              runCountFloor,
            }),
          )
          .filter((entry): entry is OptimizationAttentionSummary => Boolean(entry))
          .slice(0, limit);
        if (attention.length === 0) {
          return inconclusiveTextResult(
            "No optimization lineages currently exceed the configured attention thresholds.",
            {
              ok: false,
              staleAfterDays,
              runCountFloor,
              attention: [],
            },
          );
        }
        return textResult(
          [
            "# Optimization Continuity Attention",
            `count: ${attention.length}`,
            `stale_after_days: ${staleAfterDays}`,
            `run_count_floor: ${runCountFloor}`,
            ...attention.map(formatAttentionSummary),
          ].join("\n"),
          {
            ok: true,
            staleAfterDays,
            runCountFloor,
            attention,
          },
        );
      }

      if (!lineageId && !loopKey) {
        return failTextResult("show requires lineage_id or loop_key.", {
          ok: false,
          error: "missing_identity",
        });
      }

      let lineage: OptimizationLineageArtifact | undefined;
      if (lineageId) {
        lineage = plane.getLineage(lineageId);
      } else if (loopKey) {
        const candidates = plane.getLineagesByLoopKey(loopKey);
        if (candidates.length === 0) {
          return failTextResult(`Optimization lineage not found for loop_key: ${loopKey}`, {
            ok: false,
            error: "lineage_not_found",
            loopKey,
          });
        }
        if (candidates.length > 1) {
          return failTextResult(
            `Multiple lineages share loop_key '${loopKey}'. Use lineage_id instead: ${candidates
              .map((entry) => entry.id)
              .join(", ")}`,
            {
              ok: false,
              error: "multiple_lineages_for_loop_key",
              loopKey,
              lineageIds: candidates.map((entry) => entry.id),
            },
          );
        }
        lineage = candidates[0];
      }

      if (!lineage) {
        return failTextResult(`Optimization lineage not found: ${lineageId ?? loopKey}`, {
          ok: false,
          error: "lineage_not_found",
          lineageId: lineageId ?? null,
          loopKey: loopKey ?? null,
        });
      }

      return textResult(formatLineageDetail(lineage), {
        ok: true,
        lineage,
      });
    },
  });
}
