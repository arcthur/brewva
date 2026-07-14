import { describe, expect, test } from "bun:test";
import {
  compareSelfEvalReports,
  compareSelfEvalRetirementMatrix,
  formatSelfEvalComparison,
} from "../../eval/self-eval/compare.js";
import { SELF_EVAL_FIXTURES } from "../../eval/self-eval/fixtures.js";
import { digestSelfEvalFixtures } from "../../eval/self-eval/report.js";
import type {
  SelfEvalReport,
  SelfEvalRunResult,
  SelfEvalSkillArm,
  SelfEvalTaskOutcome,
} from "../../eval/self-eval/types.js";

function run(input: {
  fixtureId: string;
  runIndex: number;
  taskOutcome: SelfEvalTaskOutcome;
  toolCallCount?: number;
  modelRoute?: string;
  skillCorpusDigest?: string;
  gateClass?: "utility" | "safety_honesty";
}): SelfEvalRunResult {
  return {
    fixtureId: input.fixtureId,
    runIndex: input.runIndex,
    kind: "build",
    gateClass: input.gateClass ?? "utility",
    observedModelRoutes: [input.modelRoute ?? "provider/test-model"],
    treatmentExposure: {
      targetRelevant: false,
      targetSkillOffered: false,
      targetSkillOpened: false,
      strictScaffoldOpened: false,
    },
    skillContext: {
      arm: "kernel_scaffold",
      skillCorpusDigest: input.skillCorpusDigest ?? "a".repeat(64),
      loadedSkills: [{ name: "debugging", contentDigest: "b".repeat(64) }],
    },
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

function repeatedRuns(
  fixtureId: string,
  outcomes: readonly SelfEvalTaskOutcome[],
  toolCallCount?: number,
): SelfEvalRunResult[] {
  return outcomes.map((taskOutcome, index) =>
    run({
      fixtureId,
      runIndex: index + 1,
      taskOutcome,
      ...(toolCallCount === undefined ? {} : { toolCallCount }),
    }),
  );
}

function canonicalRuns(input: {
  arm: "kernel_only" | "kernel_scaffold";
  modelRoute: string;
  runsPerFixture?: number;
}): SelfEvalRunResult[] {
  const runsPerFixture = input.runsPerFixture ?? 30;
  return SELF_EVAL_FIXTURES.flatMap((fixture) =>
    Array.from({ length: runsPerFixture }, (_, index) => {
      const targetRelevant = fixture.targetPilotSkill === "debugging";
      return Object.assign(
        run({
          fixtureId: fixture.id,
          runIndex: index + 1,
          taskOutcome: "task_passed",
          modelRoute: input.modelRoute,
          gateClass: fixture.gateClass,
        }),
        {
          kind: fixture.kind,
          treatmentExposure: {
            targetRelevant,
            targetSkillOffered: targetRelevant,
            targetSkillOpened: targetRelevant,
            strictScaffoldOpened: targetRelevant && input.arm === "kernel_scaffold",
          },
        },
      );
    }),
  );
}

function report(input: {
  runs: readonly SelfEvalRunResult[];
  experimentId?: string;
  arm?: SelfEvalSkillArm;
  requestedModel?: string;
  fixtureCorpusDigest?: string;
  modelTier?: "strong" | "weak";
  sourceRevision?: string;
  evaluationMode?: "retirement" | "diagnostic";
  runsPerFixture?: number;
}): SelfEvalReport {
  const arm = input.arm ?? "kernel_scaffold";
  const skillCorpusDigest =
    arm === "kernel_scaffold"
      ? "a".repeat(64)
      : arm === "kernel_only"
        ? "d".repeat(64)
        : "0".repeat(64);
  const runs = input.runs.map((entry) =>
    Object.assign({}, entry, {
      skillContext: Object.assign({}, entry.skillContext, { arm, skillCorpusDigest }),
    }),
  );
  return {
    schema: "brewva.self-eval.report.v4",
    generatedAt: "2026-07-14T00:00:00.000Z",
    requestedModel: input.requestedModel ?? "provider/test-model",
    observedModelRoutes: [
      ...new Set(runs.flatMap((entry) => entry.observedModelRoutes)),
    ].toSorted(),
    runsPerFixture: input.runsPerFixture ?? Math.max(0, ...runs.map((entry) => entry.runIndex)),
    experiment: {
      id: input.experimentId ?? "pilot-2026-07-14",
      evaluationMode: input.evaluationMode ?? "diagnostic",
      arm,
      pilotSkill: "debugging",
      modelTier: input.modelTier ?? "strong",
      sourceRevision: input.sourceRevision ?? "deadbeef",
      evaluatorCorpusDigest: "e".repeat(64),
      fixtureCorpusDigest: input.fixtureCorpusDigest ?? "c".repeat(64),
      skillCorpusDigest,
      loadedSkills: runs[0]?.skillContext.loadedSkills ?? [],
    },
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

function retirementReport(input: {
  arm: "kernel_only" | "kernel_scaffold";
  modelTier: "strong" | "weak";
  requestedModel: string;
  modelRoute?: string;
  runs?: readonly SelfEvalRunResult[];
}): SelfEvalReport {
  return report({
    runs:
      input.runs ??
      canonicalRuns({
        arm: input.arm,
        modelRoute: input.modelRoute ?? input.requestedModel,
      }),
    arm: input.arm,
    modelTier: input.modelTier,
    requestedModel: input.requestedModel,
    fixtureCorpusDigest: digestSelfEvalFixtures(SELF_EVAL_FIXTURES),
    evaluationMode: "retirement",
    runsPerFixture: 30,
  });
}

describe("compareSelfEvalReports", () => {
  test("pairs exact fixture/run ordinals and reports a non-inferior candidate", () => {
    const passed = Array.from({ length: 30 }, () => "task_passed" as const);
    const comparison = compareSelfEvalReports({
      baseline: report({ runs: repeatedRuns("a", passed, 10), arm: "kernel_scaffold" }),
      candidate: report({
        runs: repeatedRuns("a", passed, 6),
        arm: "kernel_only",
      }),
    });

    expect(comparison.overall.verdict).toBe("non_inferior");
    expect(comparison.overall.taskSuccessDelta).toBe(0);
    expect(comparison.overall.degradationRateUpperBound).toBeLessThan(0.1);
    expect(comparison.overall.meanToolCallDelta).toBeCloseTo(-4, 5);
    expect(comparison.baselineArm).toBe("kernel_scaffold");
    expect(comparison.candidateArm).toBe("kernel_only");
  });

  test("refuses reports from different experiments, models, or fixture corpora", () => {
    const runs = repeatedRuns(
      "a",
      Array.from({ length: 10 }, () => "task_passed" as const),
    );
    expect(() =>
      compareSelfEvalReports({
        baseline: report({ runs, experimentId: "experiment-a", arm: "kernel_scaffold" }),
        candidate: report({ runs, experimentId: "experiment-b", arm: "kernel_only" }),
      }),
    ).toThrow("experiment id");
    expect(() =>
      compareSelfEvalReports({
        baseline: report({ runs, requestedModel: "provider/model-a", arm: "kernel_scaffold" }),
        candidate: report({ runs, requestedModel: "provider/model-b", arm: "kernel_only" }),
      }),
    ).toThrow("requested model");
    expect(() =>
      compareSelfEvalReports({
        baseline: report({ runs, fixtureCorpusDigest: "1".repeat(64), arm: "kernel_scaffold" }),
        candidate: report({ runs, fixtureCorpusDigest: "2".repeat(64), arm: "kernel_only" }),
      }),
    ).toThrow("fixture corpus");
    expect(() =>
      compareSelfEvalReports({
        baseline: report({ runs, sourceRevision: "revision-a", arm: "kernel_scaffold" }),
        candidate: report({ runs, sourceRevision: "revision-b", arm: "kernel_only" }),
      }),
    ).toThrow("source revisions");
  });

  test("refuses missing, duplicate, and differently routed run pairs", () => {
    const outcomes = Array.from({ length: 10 }, () => "task_passed" as const);
    const baselineRuns = repeatedRuns("a", outcomes);
    expect(() =>
      compareSelfEvalReports({
        baseline: report({ runs: baselineRuns, arm: "kernel_scaffold" }),
        candidate: report({ runs: baselineRuns.slice(1), arm: "kernel_only" }),
      }),
    ).toThrow("run cohort");
    expect(() =>
      compareSelfEvalReports({
        baseline: report({ runs: [...baselineRuns, baselineRuns[0]!], arm: "kernel_scaffold" }),
        candidate: report({ runs: baselineRuns, arm: "kernel_only" }),
      }),
    ).toThrow("duplicate run identity");
    expect(() =>
      compareSelfEvalReports({
        baseline: report({ runs: baselineRuns, arm: "kernel_scaffold" }),
        candidate: report({
          runs: baselineRuns.map((entry, index) =>
            index === 0
              ? Object.assign({}, entry, { observedModelRoutes: ["provider/fallback-model"] })
              : entry,
          ),
          arm: "kernel_only",
        }),
      }),
    ).toThrow("observed model route");
    expect(() =>
      compareSelfEvalReports({
        baseline: report({ runs: baselineRuns, arm: "kernel_scaffold" }),
        candidate: report({
          runs: baselineRuns.map((entry, index) =>
            index === 0
              ? Object.assign({}, entry, {
                  observedModelRoutes: ["provider/test-model", "fallback/model"],
                })
              : entry,
          ),
          arm: "kernel_only",
        }),
      }),
    ).toThrow("exactly one observed model route");
  });

  test("requires the minimum paired runs for every fixture", () => {
    const passed = Array.from({ length: 10 }, () => "task_passed" as const);
    const sparse = ["task_passed"] as const;
    const baseline = [...repeatedRuns("a", passed), ...repeatedRuns("b", sparse)];
    const comparison = compareSelfEvalReports({
      baseline: report({ runs: baseline, arm: "kernel_scaffold" }),
      candidate: report({ runs: baseline, arm: "kernel_only" }),
    });
    expect(comparison.overall.verdict).toBe("inconclusive");
    expect(comparison.overall.reason).toContain("fixture b");
  });

  test("validates margin and minimum run boundaries", () => {
    const runs = repeatedRuns(
      "a",
      Array.from({ length: 10 }, () => "task_passed" as const),
    );
    expect(() =>
      compareSelfEvalReports({
        baseline: report({ runs, arm: "kernel_scaffold" }),
        candidate: report({ runs, arm: "kernel_only" }),
        marginRate: -0.1,
      }),
    ).toThrow("marginRate");
    expect(() =>
      compareSelfEvalReports({
        baseline: report({ runs, arm: "kernel_scaffold" }),
        candidate: report({ runs, arm: "kernel_only" }),
        minRunsForVerdict: 1.5,
      }),
    ).toThrow("minRunsForVerdict");
  });

  test("keeps point-estimate passes inconclusive until the confidence bound clears", () => {
    const passed = Array.from({ length: 10 }, () => "task_passed" as const);
    const comparison = compareSelfEvalReports({
      baseline: report({ runs: repeatedRuns("a", passed), arm: "kernel_scaffold" }),
      candidate: report({ runs: repeatedRuns("a", passed), arm: "kernel_only" }),
    });
    expect(comparison.overall.taskSuccessDelta).toBe(0);
    expect(comparison.overall.verdict).toBe("inconclusive");
    expect(comparison.overall.reason).toContain("upper bound");
  });

  test("fails retirement when safety or honesty failures increase", () => {
    const passed = Array.from({ length: 30 }, () => "task_passed" as const);
    const baselineRuns = repeatedRuns("safety", passed).map((entry) =>
      Object.assign({}, entry, { gateClass: "safety_honesty" as const }),
    );
    const candidateRuns = baselineRuns.map((entry, index) =>
      index === 0
        ? Object.assign({}, entry, {
            taskOutcome: "task_failed" as const,
            metrics: Object.assign({}, entry.metrics, { terminalOutcome: "completed" as const }),
          })
        : entry,
    );
    const comparison = compareSelfEvalReports({
      baseline: report({ runs: baselineRuns, arm: "kernel_scaffold" }),
      candidate: report({ runs: candidateRuns, arm: "kernel_only" }),
    });
    expect(comparison.overall.verdict).toBe("inferior");
    expect(comparison.overall.reason).toContain("safety/honesty failures increased");
  });

  test("rejects same-arm comparisons and requires both tiers for global retirement", () => {
    const passed = Array.from({ length: 30 }, () => "task_passed" as const);
    const runs = repeatedRuns("a", passed);
    expect(() =>
      compareSelfEvalReports({
        baseline: report({ runs, arm: "kernel_scaffold" }),
        candidate: report({ runs, arm: "kernel_scaffold" }),
      }),
    ).toThrow("different skill arms");

    const canonicalDigest = digestSelfEvalFixtures(SELF_EVAL_FIXTURES);
    const strongScaffold = canonicalRuns({
      arm: "kernel_scaffold",
      modelRoute: "provider/strong-model",
    });
    const strongKernel = canonicalRuns({ arm: "kernel_only", modelRoute: "provider/strong-model" });
    const weakScaffold = canonicalRuns({
      arm: "kernel_scaffold",
      modelRoute: "provider/weak-model",
    });
    const weakKernel = canonicalRuns({ arm: "kernel_only", modelRoute: "provider/weak-model" });
    const matrix = compareSelfEvalRetirementMatrix({
      strongBaseline: report({
        runs: strongScaffold,
        arm: "kernel_scaffold",
        modelTier: "strong",
        requestedModel: "provider/strong-model",
        fixtureCorpusDigest: canonicalDigest,
        evaluationMode: "retirement",
        runsPerFixture: 30,
      }),
      strongCandidate: report({
        runs: strongKernel,
        arm: "kernel_only",
        modelTier: "strong",
        requestedModel: "provider/strong-model",
        fixtureCorpusDigest: canonicalDigest,
        evaluationMode: "retirement",
        runsPerFixture: 30,
      }),
      weakBaseline: report({
        runs: weakScaffold,
        arm: "kernel_scaffold",
        modelTier: "weak",
        requestedModel: "provider/weak-model",
        fixtureCorpusDigest: canonicalDigest,
        evaluationMode: "retirement",
        runsPerFixture: 30,
      }),
      weakCandidate: report({
        runs: weakKernel,
        arm: "kernel_only",
        modelTier: "weak",
        requestedModel: "provider/weak-model",
        fixtureCorpusDigest: canonicalDigest,
        evaluationMode: "retirement",
        runsPerFixture: 30,
      }),
    });
    expect(matrix.verdict).toBe("non_inferior");
  });

  test("keeps retirement policy fixed while diagnostics remain non-decision-bearing", () => {
    const passed = Array.from({ length: 30 }, () => "task_passed" as const);
    const baseline = report({ runs: repeatedRuns("a", passed), arm: "kernel_scaffold" });
    const candidate = report({ runs: repeatedRuns("a", passed), arm: "kernel_only" });
    const diagnostic = compareSelfEvalReports({
      baseline,
      candidate,
      mode: "diagnostic",
      marginRate: 0.99,
      confidenceLevel: 0.5,
      minRunsForVerdict: 1,
    });
    expect(diagnostic.decisionBearing).toBe(false);
    expect(formatSelfEvalComparison(diagnostic)).toContain("decision bearing: no");
    expect(() =>
      compareSelfEvalReports({
        baseline,
        candidate,
        mode: "retirement",
        marginRate: 0.99,
      }),
    ).toThrow("fixed at 0.1");
  });

  test("rejects partial retirement cohorts and mixed routes", () => {
    const partial = repeatedRuns(
      SELF_EVAL_FIXTURES[0]!.id,
      Array.from({ length: 30 }, () => "task_passed" as const),
    );
    expect(() =>
      compareSelfEvalReports({
        baseline: report({
          runs: partial,
          arm: "kernel_scaffold",
          evaluationMode: "retirement",
          runsPerFixture: 30,
          fixtureCorpusDigest: digestSelfEvalFixtures(SELF_EVAL_FIXTURES),
        }),
        candidate: report({
          runs: partial,
          arm: "kernel_only",
          evaluationMode: "retirement",
          runsPerFixture: 30,
          fixtureCorpusDigest: digestSelfEvalFixtures(SELF_EVAL_FIXTURES),
        }),
        mode: "retirement",
      }),
    ).toThrow("complete canonical cohort");

    const mixedRouteRuns = canonicalRuns({
      arm: "kernel_scaffold",
      modelRoute: "provider/strong-model",
    }).map((entry, index) =>
      index === 0
        ? Object.assign({}, entry, { observedModelRoutes: ["provider/fallback-model"] })
        : entry,
    );
    expect(() =>
      compareSelfEvalReports({
        baseline: retirementReport({
          arm: "kernel_scaffold",
          modelTier: "strong",
          requestedModel: "provider/strong-model",
          runs: mixedRouteRuns,
        }),
        candidate: retirementReport({
          arm: "kernel_only",
          modelTier: "strong",
          requestedModel: "provider/strong-model",
        }),
        mode: "retirement",
      }),
    ).toThrow("exactly one observed model route");
  });

  test("requires distinct strong/weak models and receipt-backed treatment exposure", () => {
    const sameModel = "provider/shared-model";
    expect(() =>
      compareSelfEvalRetirementMatrix({
        strongBaseline: retirementReport({
          arm: "kernel_scaffold",
          modelTier: "strong",
          requestedModel: sameModel,
        }),
        strongCandidate: retirementReport({
          arm: "kernel_only",
          modelTier: "strong",
          requestedModel: sameModel,
        }),
        weakBaseline: retirementReport({
          arm: "kernel_scaffold",
          modelTier: "weak",
          requestedModel: sameModel,
        }),
        weakCandidate: retirementReport({
          arm: "kernel_only",
          modelTier: "weak",
          requestedModel: sameModel,
        }),
      }),
    ).toThrow("different requested models");

    const missingScaffoldExposure = canonicalRuns({
      arm: "kernel_scaffold",
      modelRoute: "provider/strong-model",
    }).map((entry) =>
      entry.treatmentExposure.targetRelevant
        ? Object.assign({}, entry, {
            treatmentExposure: Object.assign({}, entry.treatmentExposure, {
              strictScaffoldOpened: false,
            }),
          })
        : entry,
    );
    const comparison = compareSelfEvalReports({
      baseline: retirementReport({
        arm: "kernel_scaffold",
        modelTier: "strong",
        requestedModel: "provider/strong-model",
        runs: missingScaffoldExposure,
      }),
      candidate: retirementReport({
        arm: "kernel_only",
        modelTier: "strong",
        requestedModel: "provider/strong-model",
      }),
      mode: "retirement",
    });
    expect(comparison.overall.verdict).toBe("inconclusive");
    expect(comparison.overall.reason).toContain("receipt-backed");
  });

  test("uses the unrounded exact bound for the decision", () => {
    const baselineOutcomes = Array.from({ length: 390 }, () => "task_passed" as const);
    const candidateOutcomes = baselineOutcomes.map((outcome, index) =>
      index < 29 ? ("task_failed" as const) : outcome,
    );
    const comparison = compareSelfEvalReports({
      baseline: report({
        runs: repeatedRuns("boundary", baselineOutcomes),
        arm: "kernel_scaffold",
      }),
      candidate: report({ runs: repeatedRuns("boundary", candidateOutcomes), arm: "kernel_only" }),
      mode: "diagnostic",
      minRunsForVerdict: 1,
      marginRate: 0.1,
      confidenceLevel: 0.95,
    });
    expect(comparison.overall.degradationRateUpperBound).toBeGreaterThan(0.1);
    expect(comparison.overall.verdict).toBe("inconclusive");
  });

  test("formats immutable experiment and arm identity", () => {
    const runs = repeatedRuns(
      "a",
      Array.from({ length: 10 }, () => "task_passed" as const),
    );
    const text = formatSelfEvalComparison(
      compareSelfEvalReports({
        baseline: report({ runs, arm: "no_skill" }),
        candidate: report({ runs, arm: "kernel_scaffold" }),
        mode: "diagnostic",
      }),
    );
    expect(text).toContain("experiment: pilot-2026-07-14");
    expect(text).toContain("baseline arm: no_skill");
    expect(text).toContain("candidate arm: kernel_scaffold");
  });
});
