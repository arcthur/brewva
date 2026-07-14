import { describe, expect, test } from "bun:test";
import { compareSelfEvalReports, formatSelfEvalComparison } from "../../eval/self-eval/compare.js";
import type {
  SelfEvalReport,
  SelfEvalRunResult,
  SelfEvalTaskKind,
  SelfEvalTaskOutcome,
} from "../../eval/self-eval/types.js";

function run(input: {
  fixtureId: string;
  kind?: SelfEvalTaskKind;
  taskOutcome: SelfEvalTaskOutcome;
  toolCallCount?: number;
}): SelfEvalRunResult {
  return {
    fixtureId: input.fixtureId,
    kind: input.kind ?? "build",
    metrics: {
      distinctTools: ["read"],
      distinctToolCount: 1,
      perFamilyCounts: { host: input.toolCallCount ?? 3 },
      toolCallCount: input.toolCallCount ?? 3,
      turnCount: 1,
      terminalOutcome: input.taskOutcome === "terminal_incomplete" ? "incomplete" : "completed",
    },
    taskOutcome: input.taskOutcome,
    exitCode: 0,
    timedOut: false,
    tapePresent: true,
    workspace: "/tmp/unused",
  };
}

function report(runs: readonly SelfEvalRunResult[], model = "test-model"): SelfEvalReport {
  return {
    schema: "brewva.self-eval.report.v2",
    generatedAt: "2026-07-14T00:00:00.000Z",
    model,
    runsPerFixture: 1,
    runs,
    aggregate: {
      fixtureCount: new Set(runs.map((entry) => entry.fixtureId)).size,
      runCount: runs.length,
      taskPassedRuns: runs.filter((entry) => entry.taskOutcome === "task_passed").length,
      taskFailedRuns: runs.filter((entry) => entry.taskOutcome === "task_failed").length,
      terminalIncompleteRuns: runs.filter((entry) => entry.taskOutcome === "terminal_incomplete")
        .length,
      completedRuns: runs.length,
      suspendedRuns: 0,
      incompleteRuns: 0,
      timedOutRuns: 0,
      unknownRuns: 0,
      distinctToolsUnion: ["read"],
      perFamilyCounts: {},
    },
  };
}

function repeatedRuns(
  fixtureId: string,
  outcomes: readonly SelfEvalTaskOutcome[],
  toolCallCount?: number,
): SelfEvalRunResult[] {
  return outcomes.map((taskOutcome) =>
    run({ fixtureId, taskOutcome, ...(toolCallCount === undefined ? {} : { toolCallCount }) }),
  );
}

describe("compareSelfEvalReports", () => {
  test("non_inferior when the candidate holds task success within the margin", () => {
    const outcomes = Array.from({ length: 10 }, () => "task_passed" as const);
    const comparison = compareSelfEvalReports({
      baseline: report([...repeatedRuns("a", outcomes, 10), ...repeatedRuns("b", outcomes, 10)]),
      candidate: report([
        ...repeatedRuns("a", outcomes, 6),
        ...repeatedRuns("b", [...outcomes.slice(1), "task_failed"], 6),
      ]),
    });
    expect(comparison.overall.verdict).toBe("non_inferior");
    expect(comparison.overall.taskSuccessDelta).toBeCloseTo(-0.05, 5);
    // The secondary metric reports the ritual-cost saving alongside.
    expect(comparison.overall.meanToolCallDelta).toBeCloseTo(-4, 5);
  });

  test("inferior when the candidate drops task success beyond the margin", () => {
    const passed = Array.from({ length: 10 }, () => "task_passed" as const);
    const degraded: SelfEvalTaskOutcome[] = [
      ...Array.from({ length: 6 }, () => "task_passed" as const),
      ...Array.from({ length: 4 }, () => "task_failed" as const),
    ];
    const comparison = compareSelfEvalReports({
      baseline: report(repeatedRuns("a", passed)),
      candidate: report(repeatedRuns("a", degraded)),
    });
    expect(comparison.overall.verdict).toBe("inferior");
    expect(comparison.overall.reason).toContain("falls below the declared margin");
  });

  test("inconclusive on insufficient paired runs — never a silent pass", () => {
    const comparison = compareSelfEvalReports({
      baseline: report(repeatedRuns("a", ["task_passed", "task_passed"])),
      candidate: report(repeatedRuns("a", ["task_failed", "task_failed"])),
    });
    expect(comparison.overall.verdict).toBe("inconclusive");
    expect(comparison.overall.reason).toContain("insufficient paired runs");
  });

  test("terminal_incomplete counts against task success, not out of the denominator", () => {
    const passed = Array.from({ length: 10 }, () => "task_passed" as const);
    const stalled: SelfEvalTaskOutcome[] = [
      ...Array.from({ length: 8 }, () => "task_passed" as const),
      ...Array.from({ length: 2 }, () => "terminal_incomplete" as const),
    ];
    const comparison = compareSelfEvalReports({
      baseline: report(repeatedRuns("a", passed)),
      candidate: report(repeatedRuns("a", stalled)),
      marginRate: 0.2,
    });
    expect(comparison.overall.candidateTaskSuccessRate).toBeCloseTo(0.8, 5);
    expect(comparison.overall.verdict).toBe("non_inferior");
  });

  test("unpaired fixtures are excluded and reported, not silently mixed", () => {
    const outcomes = Array.from({ length: 10 }, () => "task_passed" as const);
    const comparison = compareSelfEvalReports({
      baseline: report([
        ...repeatedRuns("a", outcomes),
        ...repeatedRuns("only-baseline", outcomes),
      ]),
      candidate: report([
        ...repeatedRuns("a", outcomes),
        ...repeatedRuns("only-candidate", outcomes),
      ]),
    });
    expect(comparison.unpairedFixtureIds).toEqual(["only-baseline", "only-candidate"]);
    expect(comparison.fixtures.map((fixture) => fixture.fixtureId)).toEqual(["a"]);
  });

  test("formatSelfEvalComparison renders the verdict and the per-fixture table", () => {
    const outcomes = Array.from({ length: 10 }, () => "task_passed" as const);
    const text = formatSelfEvalComparison(
      compareSelfEvalReports({
        baseline: report(repeatedRuns("a", outcomes)),
        candidate: report(repeatedRuns("a", outcomes)),
        baselineLabel: "main",
        candidateLabel: "pilot-rewrite",
      }),
    );
    expect(text).toContain("## Verdict: non_inferior");
    expect(text).toContain("baseline: main");
    expect(text).toContain("| a | build | 10/10 | 10/10 |");
    expect(text).toContain("secondary; counts as improvement only at equal task success");
  });
});
