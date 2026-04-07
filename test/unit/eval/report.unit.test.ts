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
});
