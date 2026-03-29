import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrewvaRuntime, buildScheduleIntentFiredEvent } from "@brewva/brewva-runtime";
import { createIterationFactTool } from "@brewva/brewva-tools";
import { requireNonEmptyString } from "../../helpers/assertions.js";
import { extractTextContent, mergeContext } from "./tools-flow.helpers.js";

describe("iteration_fact contract", () => {
  test("records evidence-backed metric and guard facts through the managed tool surface", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-tools-iteration-fact-"));
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "iteration-fact-contract-1";
    const tool = createIterationFactTool({ runtime });

    const metricResult = await tool.execute(
      "tc-iteration-metric",
      {
        action: "record_metric",
        metric_key: "latency_ms",
        value: 92,
        unit: "ms",
        aggregation: "p95",
        iteration_key: "iter-2",
        source: "goal-loop",
        evidence_refs: ["verification:latency"],
        summary: "Latency improved after the second change.",
      },
      undefined,
      undefined,
      mergeContext(sessionId, { cwd: workspace }),
    );

    const guardResult = await tool.execute(
      "tc-iteration-guard",
      {
        action: "record_guard",
        guard_key: "error_budget",
        status: "pass",
        iteration_key: "iter-2",
        source: "goal-loop",
        evidence_refs: ["slo:error-budget"],
        summary: "Error budget remained within threshold.",
      },
      undefined,
      undefined,
      mergeContext(sessionId, { cwd: workspace }),
    );

    const metricEventId = (metricResult.details as { eventId?: string } | undefined)?.eventId;
    const guardEventId = (guardResult.details as { eventId?: string } | undefined)?.eventId;

    expect(extractTextContent(metricResult)).toContain("Metric observation recorded");
    expect(extractTextContent(guardResult)).toContain("Guard result recorded");
    requireNonEmptyString(metricEventId, "missing metric event id");
    requireNonEmptyString(guardEventId, "missing guard event id");

    const listResult = await tool.execute(
      "tc-iteration-list",
      {
        action: "list",
        history_limit: 5,
        fact_kind: "all",
        iteration_key: "iter-2",
      },
      undefined,
      undefined,
      mergeContext(sessionId, { cwd: workspace }),
    );

    const text = extractTextContent(listResult);
    expect(text).toContain("[IterationFacts]");
    expect(text).toContain("metrics: 1");
    expect(text).toContain("guards: 1");
    expect(text).toContain("key=latency_ms");
    expect(text).toContain("key=error_budget");

    expect(
      runtime.events.listMetricObservations(sessionId, { iterationKey: "iter-2" }),
    ).toHaveLength(1);
    expect(runtime.events.listGuardResults(sessionId, { iterationKey: "iter-2" })).toHaveLength(1);
  });

  test("rejects metric and guard writes without evidence refs", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-tools-iteration-fact-evidence-"));
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "iteration-fact-contract-evidence";
    const tool = createIterationFactTool({ runtime });

    const metricResult = await tool.execute(
      "tc-iteration-metric-missing-evidence",
      {
        action: "record_metric",
        metric_key: "latency_ms",
        value: 92,
      },
      undefined,
      undefined,
      mergeContext(sessionId, { cwd: workspace }),
    );
    const guardResult = await tool.execute(
      "tc-iteration-guard-missing-evidence",
      {
        action: "record_guard",
        guard_key: "error_budget",
        status: "pass",
      },
      undefined,
      undefined,
      mergeContext(sessionId, { cwd: workspace }),
    );

    expect(extractTextContent(metricResult)).toContain("evidence_refs");
    expect(extractTextContent(guardResult)).toContain("evidence_refs");
    expect(runtime.events.listMetricObservations(sessionId)).toEqual([]);
    expect(runtime.events.listGuardResults(sessionId)).toEqual([]);
  });

  test("lists lineage-scoped facts through the managed tool surface", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-tools-iteration-lineage-"));
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const parentSessionId = "iteration-lineage-parent";
    const childSessionId = "iteration-lineage-child-a";
    const siblingSessionId = "iteration-lineage-child-b";
    const loopSource = "goal-loop:coverage-raise-2026-03-22";
    const tool = createIterationFactTool({ runtime });

    runtime.events.record({
      sessionId: parentSessionId,
      type: "schedule_intent",
      timestamp: 10,
      payload: {
        ...buildScheduleIntentFiredEvent({
          intentId: "lineage-intent-a",
          parentSessionId,
          reason: "continue bounded optimization",
          goalRef: loopSource,
          continuityMode: "inherit",
          maxRuns: 5,
          runIndex: 1,
          firedAt: 10,
          nextRunAt: 20,
          childSessionId,
        }),
      },
    });
    runtime.events.record({
      sessionId: parentSessionId,
      type: "schedule_intent",
      timestamp: 11,
      payload: {
        ...buildScheduleIntentFiredEvent({
          intentId: "lineage-intent-b",
          parentSessionId,
          reason: "continue bounded optimization",
          goalRef: loopSource,
          continuityMode: "inherit",
          maxRuns: 5,
          runIndex: 2,
          firedAt: 11,
          nextRunAt: 21,
          childSessionId: siblingSessionId,
        }),
      },
    });

    runtime.events.recordMetricObservation(parentSessionId, {
      metricKey: "coverage_pct",
      value: 72,
      unit: "%",
      aggregation: "last",
      iterationKey: "coverage-loop/run-0/iter-0",
      source: loopSource,
      timestamp: 100,
    });
    runtime.events.recordMetricObservation(childSessionId, {
      metricKey: "coverage_pct",
      value: 74,
      unit: "%",
      aggregation: "last",
      iterationKey: "coverage-loop/run-1/iter-1",
      source: loopSource,
      timestamp: 110,
    });
    runtime.events.recordMetricObservation(siblingSessionId, {
      metricKey: "coverage_pct",
      value: 76,
      unit: "%",
      aggregation: "last",
      iterationKey: "coverage-loop/run-2/iter-1",
      source: loopSource,
      timestamp: 120,
    });

    const listResult = await tool.execute(
      "tc-iteration-lineage-list",
      {
        action: "list",
        fact_kind: "metric",
        metric_key: "coverage_pct",
        source: loopSource,
        session_scope: "current_session",
        history_limit: 10,
      },
      undefined,
      undefined,
      mergeContext(childSessionId, { cwd: workspace }),
    );

    expect(extractTextContent(listResult)).toContain("session_scope: current_session");
    const details = listResult.details as { metrics?: Array<{ sessionId: string; value: number }> };
    expect(details.metrics).toEqual([
      expect.objectContaining({ sessionId: childSessionId, value: 74 }),
    ]);
  });
});
