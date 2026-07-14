import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildSelfEvalReport,
  formatSelfEvalReport,
  persistSelfEvalReport,
} from "../../eval/self-eval/report.js";
import type { SelfEvalRunResult } from "../../eval/self-eval/types.js";

const runs: SelfEvalRunResult[] = [
  {
    fixtureId: "fix-arithmetic-bug",
    runIndex: 1,
    kind: "build",
    gateClass: "utility",
    observedModelRoutes: ["provider/glm5.2"],
    treatmentExposure: {
      targetRelevant: false,
      targetSkillOffered: false,
      targetSkillOpened: false,
      strictScaffoldOpened: false,
    },
    skillContext: {
      arm: "kernel_scaffold",
      skillCorpusDigest: "a".repeat(64),
      loadedSkills: [{ name: "debugging", contentDigest: "b".repeat(64) }],
    },
    taskOutcome: "task_passed",
    exitCode: 0,
    timedOut: false,
    tapePresent: true,
    workspace: "/tmp/a",
    metrics: {
      distinctTools: ["exec", "read"],
      distinctToolCount: 2,
      perFamilyCounts: { exec: 1, read: 2 },
      toolCallCount: 3,
      turnCount: 1,
      terminalOutcome: "completed",
      cost: { totalTokens: 100, totalCostUsd: 0.01 },
    },
  },
  {
    fixtureId: "debug-regex",
    runIndex: 1,
    kind: "debug",
    gateClass: "utility",
    observedModelRoutes: ["provider/glm5.2"],
    treatmentExposure: {
      targetRelevant: false,
      targetSkillOffered: false,
      targetSkillOpened: false,
      strictScaffoldOpened: false,
    },
    skillContext: {
      arm: "kernel_scaffold",
      skillCorpusDigest: "a".repeat(64),
      loadedSkills: [{ name: "debugging", contentDigest: "b".repeat(64) }],
    },
    taskOutcome: "terminal_incomplete",
    exitCode: 1,
    timedOut: false,
    tapePresent: true,
    workspace: "/tmp/b",
    metrics: {
      distinctTools: ["edit", "read"],
      distinctToolCount: 2,
      perFamilyCounts: { edit: 1, read: 1 },
      toolCallCount: 2,
      turnCount: 1,
      terminalOutcome: "suspended_for_approval",
      cost: { totalTokens: 50 },
    },
  },
  {
    // A timed-out run: terminal_incomplete task outcome, and its liveness lands
    // in the timed_out bucket (never silently folded into unknown).
    fixtureId: "implement-chunk",
    runIndex: 1,
    kind: "build",
    gateClass: "utility",
    observedModelRoutes: [],
    treatmentExposure: {
      targetRelevant: false,
      targetSkillOffered: false,
      targetSkillOpened: false,
      strictScaffoldOpened: false,
    },
    skillContext: {
      arm: "kernel_scaffold",
      skillCorpusDigest: "a".repeat(64),
      loadedSkills: [{ name: "debugging", contentDigest: "b".repeat(64) }],
    },
    taskOutcome: "terminal_incomplete",
    exitCode: null,
    timedOut: true,
    tapePresent: false,
    workspace: "/tmp/c",
    metrics: {
      distinctTools: [],
      distinctToolCount: 0,
      perFamilyCounts: {},
      toolCallCount: 0,
      turnCount: 0,
      terminalOutcome: "unknown",
    },
  },
];

const GENERATED_AT = "2026-07-11T12:00:00.000Z";

const REPORT_IDENTITY = {
  experimentId: "pilot-2026-07-11",
  evaluationMode: "diagnostic" as const,
  arm: "kernel_scaffold" as const,
  pilotSkill: "debugging" as const,
  modelTier: "strong" as const,
  sourceRevision: "deadbeef",
  evaluatorCorpusDigest: "e".repeat(64),
  fixtureCorpusDigest: "c".repeat(64),
  requestedModel: "provider/glm5.2",
};

describe("self-eval report", () => {
  test("aggregates task outcomes, liveness, tools, per-family sums, and cost deterministically", () => {
    const first = buildSelfEvalReport({
      runs,
      ...REPORT_IDENTITY,
      runsPerFixture: 1,
      generatedAt: GENERATED_AT,
    });
    const second = buildSelfEvalReport({
      runs,
      ...REPORT_IDENTITY,
      runsPerFixture: 1,
      generatedAt: GENERATED_AT,
    });
    expect(first).toEqual(second);

    const agg = first.aggregate;
    expect(agg.fixtureCount).toBe(3);
    expect(agg.runCount).toBe(3);
    // Task-success headline sums to runCount.
    expect(agg.taskPassedRuns).toBe(1);
    expect(agg.taskFailedRuns).toBe(0);
    expect(agg.terminalIncompleteRuns).toBe(2);
    expect(agg.taskPassedRuns + agg.taskFailedRuns + agg.terminalIncompleteRuns).toBe(agg.runCount);
    // Liveness breakdown sums to runCount, with the timed-out run in its own
    // bucket rather than dropped.
    expect(agg.completedRuns).toBe(1);
    expect(agg.suspendedRuns).toBe(1);
    expect(agg.incompleteRuns).toBe(0);
    expect(agg.timedOutRuns).toBe(1);
    expect(agg.unknownRuns).toBe(0);
    expect(
      agg.completedRuns +
        agg.suspendedRuns +
        agg.incompleteRuns +
        agg.timedOutRuns +
        agg.unknownRuns,
    ).toBe(agg.runCount);
    expect(agg.distinctToolsUnion).toEqual(["edit", "exec", "read"]);
    expect(agg.perFamilyCounts).toEqual({ edit: 1, exec: 1, read: 3 });
    expect(agg.cost).toEqual({ totalTokens: 150, totalCostUsd: 0.01 });
  });

  test("formats markdown with the task-outcome headline, liveness, and per-fixture rows", () => {
    const report = buildSelfEvalReport({
      runs,
      ...REPORT_IDENTITY,
      runsPerFixture: 1,
      generatedAt: GENERATED_AT,
    });
    const markdown = formatSelfEvalReport(report);
    expect(markdown).toContain("# Self-Eval Report — pilot-2026-07-11");
    expect(markdown).toContain("Arm: kernel_scaffold");
    expect(markdown).toContain("Requested model: provider/glm5.2");
    expect(markdown).toContain("## Task Outcome (post-run oracle — the utility signal)");
    expect(markdown).toContain("| Task passed | 1 |");
    expect(markdown).toContain("| Timed out | 1 |");
    expect(markdown).toContain("## Tool-Surface Exercise Profile (per family, committed)");
    expect(markdown).toContain("| read | 3 |");
    // Per-fixture rows carry both task outcome and turn liveness.
    expect(markdown).toContain("task_passed");
    expect(markdown).toContain("timed_out");
  });

  test("persists immutable arm-specific report paths without same-day overwrite", () => {
    const workspace = mkdtempSync(join(tmpdir(), "self-eval-report-"));
    const report = buildSelfEvalReport({
      runs,
      ...REPORT_IDENTITY,
      runsPerFixture: 1,
      generatedAt: GENERATED_AT,
    });
    const { markdownPath, jsonPath } = persistSelfEvalReport({ workspaceRoot: workspace, report });

    expect(markdownPath).toContain("pilot-2026-07-11--debugging--strong--kernel_scaffold.md");
    expect(jsonPath).toContain("pilot-2026-07-11--debugging--strong--kernel_scaffold.json");
    expect(existsSync(markdownPath)).toBe(true);
    expect(existsSync(jsonPath)).toBe(true);
    const persisted = JSON.parse(readFileSync(jsonPath, "utf8")) as { schema: string };
    expect(persisted.schema).toBe("brewva.self-eval.report.v4");
    expect(() => persistSelfEvalReport({ workspaceRoot: workspace, report })).toThrow("EEXIST");

    const otherArm = buildSelfEvalReport({
      runs: runs.map((run) =>
        Object.assign({}, run, {
          skillContext: {
            arm: "kernel_only" as const,
            skillCorpusDigest: "d".repeat(64),
            loadedSkills: [],
          },
        }),
      ),
      ...REPORT_IDENTITY,
      arm: "kernel_only",
      runsPerFixture: 1,
      generatedAt: GENERATED_AT,
    });
    const otherPaths = persistSelfEvalReport({ workspaceRoot: workspace, report: otherArm });
    expect(otherPaths.jsonPath).not.toBe(jsonPath);
  });
});
