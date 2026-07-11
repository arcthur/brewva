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
    kind: "build",
    exitCode: 0,
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
    kind: "debug",
    exitCode: 1,
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
];

const GENERATED_AT = "2026-07-11T12:00:00.000Z";

describe("self-eval report", () => {
  test("aggregates union tools, per-family sums, outcome counts, and cost deterministically", () => {
    const first = buildSelfEvalReport({
      runs,
      model: "glm5.2",
      runsPerFixture: 1,
      generatedAt: GENERATED_AT,
    });
    const second = buildSelfEvalReport({
      runs,
      model: "glm5.2",
      runsPerFixture: 1,
      generatedAt: GENERATED_AT,
    });
    expect(first).toEqual(second);

    expect(first.aggregate.fixtureCount).toBe(2);
    expect(first.aggregate.runCount).toBe(2);
    expect(first.aggregate.completedRuns).toBe(1);
    expect(first.aggregate.suspendedRuns).toBe(1);
    expect(first.aggregate.incompleteRuns).toBe(0);
    expect(first.aggregate.distinctToolsUnion).toEqual(["edit", "exec", "read"]);
    expect(first.aggregate.perFamilyCounts).toEqual({ edit: 1, exec: 1, read: 3 });
    expect(first.aggregate.cost).toEqual({ totalTokens: 150, totalCostUsd: 0.01 });
  });

  test("formats markdown with the tool-surface profile and per-fixture rows", () => {
    const report = buildSelfEvalReport({
      runs,
      model: "glm5.2",
      runsPerFixture: 1,
      generatedAt: GENERATED_AT,
    });
    const markdown = formatSelfEvalReport(report);
    expect(markdown).toContain("# Self-Eval Report — glm5.2");
    expect(markdown).toContain("## Tool-Surface Exercise Profile (per family, committed)");
    expect(markdown).toContain("| read | 3 |");
    expect(markdown).toContain("suspended_for_approval");
  });

  test("persists a dated markdown + json under .brewva/reports/self-eval", () => {
    const workspace = mkdtempSync(join(tmpdir(), "self-eval-report-"));
    const report = buildSelfEvalReport({
      runs,
      model: "glm5.2",
      runsPerFixture: 1,
      generatedAt: GENERATED_AT,
    });
    const { markdownPath, jsonPath } = persistSelfEvalReport({ workspaceRoot: workspace, report });

    expect(markdownPath).toContain(join(".brewva", "reports", "self-eval", "2026-07-11.md"));
    expect(jsonPath).toContain(join(".brewva", "reports", "self-eval", "2026-07-11.json"));
    expect(existsSync(markdownPath)).toBe(true);
    expect(existsSync(jsonPath)).toBe(true);
    const persisted = JSON.parse(readFileSync(jsonPath, "utf8")) as { schema: string };
    expect(persisted.schema).toBe("brewva.self-eval.report.v1");
  });
});
