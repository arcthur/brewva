import {
  ITERATION_FACT_SESSION_SCOPE_VALUES,
  ITERATION_GUARD_STATUS_VALUES,
  ITERATION_METRIC_AGGREGATION_VALUES,
} from "@brewva/brewva-runtime";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { BrewvaToolOptions } from "./types.js";
import { buildStringEnumSchema } from "./utils/input-alias.js";
import { failTextResult, textResult } from "./utils/result.js";
import { getSessionId } from "./utils/session.js";
import { defineBrewvaTool } from "./utils/tool.js";

const ITERATION_ACTION_VALUES = ["record_metric", "record_guard", "list"] as const;

const IterationActionSchema = buildStringEnumSchema(ITERATION_ACTION_VALUES, {}, {});
const MetricAggregationSchema = buildStringEnumSchema(ITERATION_METRIC_AGGREGATION_VALUES, {}, {});
const GuardStatusSchema = buildStringEnumSchema(ITERATION_GUARD_STATUS_VALUES, {}, {});
const SessionScopeSchema = buildStringEnumSchema(ITERATION_FACT_SESSION_SCOPE_VALUES, {}, {});

function readMetricAggregation(
  value: unknown,
): (typeof ITERATION_METRIC_AGGREGATION_VALUES)[number] | undefined {
  return typeof value === "string" &&
    ITERATION_METRIC_AGGREGATION_VALUES.includes(
      value as (typeof ITERATION_METRIC_AGGREGATION_VALUES)[number],
    )
    ? (value as (typeof ITERATION_METRIC_AGGREGATION_VALUES)[number])
    : undefined;
}

function readGuardStatus(
  value: unknown,
): (typeof ITERATION_GUARD_STATUS_VALUES)[number] | undefined {
  return typeof value === "string" &&
    ITERATION_GUARD_STATUS_VALUES.includes(value as (typeof ITERATION_GUARD_STATUS_VALUES)[number])
    ? (value as (typeof ITERATION_GUARD_STATUS_VALUES)[number])
    : undefined;
}

function readSessionScope(
  value: unknown,
): (typeof ITERATION_FACT_SESSION_SCOPE_VALUES)[number] | undefined {
  return typeof value === "string" &&
    ITERATION_FACT_SESSION_SCOPE_VALUES.includes(
      value as (typeof ITERATION_FACT_SESSION_SCOPE_VALUES)[number],
    )
    ? (value as (typeof ITERATION_FACT_SESSION_SCOPE_VALUES)[number])
    : undefined;
}

function formatMetricRecord(record: {
  eventId: string;
  metricKey: string;
  value: number;
  unit?: string;
  aggregation?: string;
  iterationKey?: string;
  source: string;
}): string {
  const valueText = record.unit ? `${record.value} ${record.unit}` : String(record.value);
  const aggregation = record.aggregation ? ` aggregation=${record.aggregation}` : "";
  const iteration = record.iterationKey ? ` iteration=${record.iterationKey}` : "";
  return `- metric event=${record.eventId} key=${record.metricKey} value=${valueText}${aggregation}${iteration} source=${record.source}`;
}

function formatGuardRecord(record: {
  eventId: string;
  guardKey: string;
  status: string;
  iterationKey?: string;
  source: string;
}): string {
  const iteration = record.iterationKey ? ` iteration=${record.iterationKey}` : "";
  return `- guard event=${record.eventId} key=${record.guardKey} status=${record.status}${iteration} source=${record.source}`;
}

export function createIterationFactTool(options: BrewvaToolOptions): ToolDefinition {
  return defineBrewvaTool({
    name: "iteration_fact",
    label: "Iteration Fact",
    description:
      "Record or inspect durable iteration facts such as metric observations and guard results.",
    promptSnippet:
      "Use this to persist evidence-backed iteration facts or inspect recent fact history without inventing planner state.",
    promptGuidelines: [
      "Record only objective facts backed by concrete evidence refs.",
      "Do not use this tool to encode planning state, next-step prescriptions, or hidden chain-of-thought.",
    ],
    parameters: Type.Object({
      action: IterationActionSchema,
      metric_key: Type.Optional(Type.String()),
      value: Type.Optional(Type.Number()),
      unit: Type.Optional(Type.String()),
      aggregation: Type.Optional(MetricAggregationSchema),
      sample_count: Type.Optional(Type.Integer({ minimum: 1 })),
      guard_key: Type.Optional(Type.String()),
      status: Type.Optional(GuardStatusSchema),
      iteration_key: Type.Optional(Type.String()),
      source: Type.Optional(Type.String()),
      evidence_refs: Type.Optional(Type.Array(Type.String())),
      summary: Type.Optional(Type.String()),
      history_limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
      session_scope: Type.Optional(SessionScopeSchema),
      fact_kind: Type.Optional(
        buildStringEnumSchema(["metric", "guard", "all"] as const, {}, { recommendedValue: "all" }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const sessionId = getSessionId(ctx);
      const source = params.source?.trim() || "iteration_fact";
      const aggregation = readMetricAggregation(params.aggregation);
      const guardStatus = readGuardStatus(params.status);
      const sessionScope = readSessionScope(params.session_scope);
      const evidenceRefs = (params.evidence_refs ?? []).filter(
        (value): value is string => typeof value === "string" && value.trim().length > 0,
      );

      if (params.action === "record_metric") {
        if (
          !params.metric_key?.trim() ||
          typeof params.value !== "number" ||
          evidenceRefs.length === 0
        ) {
          return failTextResult("Metric recording requires metric_key, value, and evidence_refs.", {
            ok: false,
            error: "missing_metric_fields",
          });
        }
        const event = options.runtime.events.recordMetricObservation(sessionId, {
          metricKey: params.metric_key,
          value: params.value,
          unit: params.unit,
          aggregation,
          sampleCount: params.sample_count,
          iterationKey: params.iteration_key,
          evidenceRefs,
          source,
          summary: params.summary,
        });
        if (!event) {
          return failTextResult("Metric observation was not recorded.", {
            ok: false,
            error: "record_failed",
          });
        }
        const record = options.runtime.events.listMetricObservations(sessionId, {
          last: 1,
          metricKey: params.metric_key,
          source,
        })[0];
        return textResult(`Metric observation recorded (${event.id}).`, {
          ok: true,
          eventId: event.id,
          record: record ?? null,
        });
      }

      if (params.action === "record_guard") {
        if (!params.guard_key?.trim() || !guardStatus || evidenceRefs.length === 0) {
          return failTextResult("Guard recording requires guard_key, status, and evidence_refs.", {
            ok: false,
            error: "missing_guard_fields",
          });
        }
        const event = options.runtime.events.recordGuardResult(sessionId, {
          guardKey: params.guard_key,
          status: guardStatus,
          iterationKey: params.iteration_key,
          evidenceRefs,
          source,
          summary: params.summary,
        });
        if (!event) {
          return failTextResult("Guard result was not recorded.", {
            ok: false,
            error: "record_failed",
          });
        }
        const record = options.runtime.events.listGuardResults(sessionId, {
          last: 1,
          guardKey: params.guard_key,
          source,
        })[0];
        return textResult(`Guard result recorded (${event.id}).`, {
          ok: true,
          eventId: event.id,
          record: record ?? null,
        });
      }

      const historyLimit = Math.max(1, Math.min(50, params.history_limit ?? 10));
      const factKind = params.fact_kind ?? "all";
      const lines = ["[IterationFacts]"];
      const details: Record<string, unknown> = {};

      if (factKind === "metric" || factKind === "all") {
        const metrics = options.runtime.events.listMetricObservations(sessionId, {
          last: historyLimit,
          iterationKey: params.iteration_key,
          metricKey: params.metric_key,
          source: params.source,
          sessionScope,
        });
        lines.push(`metrics: ${metrics.length}`);
        for (const record of metrics) {
          lines.push(formatMetricRecord(record));
        }
        details.metrics = metrics;
      }

      if (factKind === "guard" || factKind === "all") {
        const guards = options.runtime.events.listGuardResults(sessionId, {
          last: historyLimit,
          iterationKey: params.iteration_key,
          guardKey: params.guard_key,
          status: guardStatus,
          source: params.source,
          sessionScope,
        });
        lines.push(`guards: ${guards.length}`);
        for (const record of guards) {
          lines.push(formatGuardRecord(record));
        }
        details.guards = guards;
      }
      if (sessionScope) {
        lines.push(`session_scope: ${sessionScope}`);
      }

      return textResult(lines.join("\n"), {
        ok: true,
        ...details,
      });
    },
  });
}
