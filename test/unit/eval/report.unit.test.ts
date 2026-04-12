import { describe, expect, test } from "bun:test";
import { buildReport, formatReport } from "../../eval/report.js";
import type { EvalResult } from "../../eval/types.js";

function buildResult(input: { scenarioId: string; runIndex: number; pass: boolean }): EvalResult {
  return {
    scenario_id: input.scenarioId,
    skill: "review",
    model: "test-model",
    run_index: input.runIndex,
    outputs: {},
    shape_grade: {
      pass: input.pass,
      checks: [],
    },
    rubric_grade: {
      pass: input.pass,
      score: input.pass ? 1 : 0,
      max_score: 1,
      criteria: [],
    },
    duration_ms: 5,
  };
}

describe("eval report semantics", () => {
  test("separates empirical pass rate, pass@k, and all-runs-pass", () => {
    const report = buildReport(
      [
        buildResult({ scenarioId: "scenario-a", runIndex: 0, pass: true }),
        buildResult({ scenarioId: "scenario-a", runIndex: 1, pass: false }),
        buildResult({ scenarioId: "scenario-a", runIndex: 2, pass: true }),
        buildResult({ scenarioId: "scenario-b", runIndex: 0, pass: true }),
        buildResult({ scenarioId: "scenario-b", runIndex: 1, pass: true }),
        buildResult({ scenarioId: "scenario-b", runIndex: 2, pass: true }),
        buildResult({ scenarioId: "scenario-c", runIndex: 0, pass: false }),
        buildResult({ scenarioId: "scenario-c", runIndex: 1, pass: false }),
        buildResult({ scenarioId: "scenario-c", runIndex: 2, pass: false }),
      ],
      "test-model",
      3,
    );

    expect(report.summary.total_scenarios).toBe(3);
    expect(report.summary.total_runs).toBe(9);
    expect(report.summary.empirical_pass_rate).toBeCloseTo(5 / 9, 5);
    expect(report.summary.pass_at_k).toBeCloseTo(2 / 3, 5);
    expect(report.summary.all_runs_pass).toBeCloseTo(1 / 3, 5);

    expect(report.scenarios).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scenario_id: "scenario-a",
          pass_rate: 2 / 3,
          pass_at_k: true,
          all_runs_pass: false,
        }),
        expect.objectContaining({
          scenario_id: "scenario-b",
          pass_rate: 1,
          pass_at_k: true,
          all_runs_pass: true,
        }),
        expect.objectContaining({
          scenario_id: "scenario-c",
          pass_rate: 0,
          pass_at_k: false,
          all_runs_pass: false,
        }),
      ]),
    );
  });

  test("labels pass metrics explicitly in formatted output", () => {
    const report = buildReport(
      [buildResult({ scenarioId: "scenario-a", runIndex: 0, pass: true })],
      "test-model",
      1,
    );

    const text = formatReport(report);
    expect(text).toContain("Single-run success rate (empirical)");
    expect(text).toContain("pass@1 (any success in k runs)");
    expect(text).toContain("All 1 runs pass");
  });

  test("aggregates recall metrics separately from generic pass-rate reporting", () => {
    const recallRunA = {
      ...buildResult({ scenarioId: "recall-a", runIndex: 0, pass: true }),
      outputs: {
        summary: "broker found the prior fix while the session-local baseline missed it",
      },
      telemetry: {
        kind: "recall",
        metrics: {
          baseline_precision_at_k: 0,
          broker_precision_at_k: 1,
          precision_gain_at_k: 1,
          baseline_useful_recall_rate: 0,
          broker_useful_recall_rate: 1,
          useful_recall_gain: 1,
          baseline_harmful_recall_rate: 0,
          broker_harmful_recall_rate: 0,
          baseline_contradiction_rate: 0,
          broker_contradiction_rate: 0,
          baseline_latency_ms: 1,
          broker_latency_ms: 4,
          added_latency_ms: 3,
          baseline_token_cost: 8,
          broker_token_cost: 28,
          added_token_cost: 20,
        },
      },
    } as EvalResult;
    const recallRunB = {
      ...buildResult({ scenarioId: "recall-b", runIndex: 0, pass: true }),
      outputs: {
        summary: "broker preferred the repository precedent over weaker tape evidence",
      },
      telemetry: {
        kind: "recall",
        metrics: {
          baseline_precision_at_k: 0.5,
          broker_precision_at_k: 1,
          precision_gain_at_k: 0.5,
          baseline_useful_recall_rate: 1,
          broker_useful_recall_rate: 1,
          useful_recall_gain: 0,
          baseline_harmful_recall_rate: 0.5,
          broker_harmful_recall_rate: 0,
          baseline_contradiction_rate: 0.5,
          broker_contradiction_rate: 0,
          baseline_latency_ms: 2,
          broker_latency_ms: 5,
          added_latency_ms: 3,
          baseline_token_cost: 12,
          broker_token_cost: 24,
          added_token_cost: 12,
        },
      },
    } as EvalResult;

    const report = buildReport(
      [buildResult({ scenarioId: "generic", runIndex: 0, pass: true }), recallRunA, recallRunB],
      "test-model",
      1,
    );

    expect(report.summary.recall_metrics).toEqual(
      expect.objectContaining({
        run_count: 2,
        baseline_precision_at_k: 0.25,
        broker_precision_at_k: 1,
        precision_gain_at_k: 0.75,
        baseline_harmful_recall_rate: 0.25,
        broker_harmful_recall_rate: 0,
        added_latency_ms: 3,
        added_token_cost: 16,
      }),
    );

    const text = formatReport(report);
    expect(text).toContain("## Recall Metrics");
    expect(text).toContain("Broker precision@k");
    expect(text).toContain("Useful recall rate");
    expect(text).toContain("Added token cost");
  });
});
