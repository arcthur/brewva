import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type {
  SelfEvalAggregate,
  SelfEvalCostObservation,
  SelfEvalReport,
  SelfEvalRunResult,
} from "./types.js";

const REPORT_SCHEMA = "brewva.self-eval.report.v1" as const;
// Sibling of the calibration report's `.brewva/reports/calibration/<date>.md`,
// so every report the calibration cycle ingests lives under one root.
const REPORTS_DIR_SEGMENTS = [".brewva", "reports", "self-eval"] as const;

function sumCost(runs: readonly SelfEvalRunResult[]): SelfEvalCostObservation | undefined {
  let totalTokens: number | undefined;
  let totalCostUsd: number | undefined;
  for (const run of runs) {
    const cost = run.metrics.cost;
    if (!cost) continue;
    if (typeof cost.totalTokens === "number") totalTokens = (totalTokens ?? 0) + cost.totalTokens;
    if (typeof cost.totalCostUsd === "number") {
      totalCostUsd = (totalCostUsd ?? 0) + cost.totalCostUsd;
    }
  }
  if (totalTokens === undefined && totalCostUsd === undefined) return undefined;
  return {
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    ...(totalCostUsd !== undefined ? { totalCostUsd } : {}),
  };
}

function aggregateRuns(runs: readonly SelfEvalRunResult[]): SelfEvalAggregate {
  const distinct = new Set<string>();
  const perFamily = new Map<string, number>();
  // Task-success headline (oracle): every run lands in exactly one of these.
  let taskPassedRuns = 0;
  let taskFailedRuns = 0;
  let terminalIncompleteRuns = 0;
  // Turn-liveness breakdown (diagnostic): every run lands in exactly one, with
  // timed_out taking precedence over the (partial) tape signal, and unknown its
  // own visible bucket rather than being silently dropped.
  let completedRuns = 0;
  let suspendedRuns = 0;
  let incompleteRuns = 0;
  let timedOutRuns = 0;
  let unknownRuns = 0;

  for (const run of runs) {
    for (const tool of run.metrics.distinctTools) distinct.add(tool);
    for (const [family, count] of Object.entries(run.metrics.perFamilyCounts)) {
      perFamily.set(family, (perFamily.get(family) ?? 0) + count);
    }
    switch (run.taskOutcome) {
      case "task_passed":
        taskPassedRuns += 1;
        break;
      case "task_failed":
        taskFailedRuns += 1;
        break;
      case "terminal_incomplete":
        terminalIncompleteRuns += 1;
        break;
    }
    if (run.timedOut) {
      timedOutRuns += 1;
      continue;
    }
    switch (run.metrics.terminalOutcome) {
      case "completed":
        completedRuns += 1;
        break;
      case "suspended_for_approval":
        suspendedRuns += 1;
        break;
      case "incomplete":
        incompleteRuns += 1;
        break;
      case "unknown":
        unknownRuns += 1;
        break;
    }
  }

  const cost = sumCost(runs);
  return {
    fixtureCount: new Set(runs.map((run) => run.fixtureId)).size,
    runCount: runs.length,
    taskPassedRuns,
    taskFailedRuns,
    terminalIncompleteRuns,
    completedRuns,
    suspendedRuns,
    incompleteRuns,
    timedOutRuns,
    unknownRuns,
    distinctToolsUnion: [...distinct].toSorted((left, right) => left.localeCompare(right)),
    perFamilyCounts: Object.fromEntries(
      [...perFamily.entries()].toSorted((left, right) => left[0].localeCompare(right[0])),
    ),
    ...(cost ? { cost } : {}),
  };
}

export function buildSelfEvalReport(input: {
  readonly runs: readonly SelfEvalRunResult[];
  readonly model: string;
  readonly runsPerFixture: number;
  readonly generatedAt: string;
}): SelfEvalReport {
  return {
    schema: REPORT_SCHEMA,
    generatedAt: input.generatedAt,
    model: input.model,
    runsPerFixture: input.runsPerFixture,
    runs: input.runs,
    aggregate: aggregateRuns(input.runs),
  };
}

function formatCost(cost: SelfEvalCostObservation | undefined): string {
  if (!cost) return "not reported";
  const parts: string[] = [];
  if (cost.totalTokens !== undefined) parts.push(`${cost.totalTokens} tokens`);
  if (cost.totalCostUsd !== undefined) parts.push(`$${cost.totalCostUsd.toFixed(4)}`);
  return parts.length > 0 ? parts.join(", ") : "not reported";
}

function formatFamilyTable(perFamily: Readonly<Record<string, number>>): string[] {
  const entries = Object.entries(perFamily);
  if (entries.length === 0) {
    return ["_No committed tools across the corpus._", ""];
  }
  const lines = ["| Family | Committed calls |", "|--------|-----------------|"];
  for (const [family, count] of entries) {
    lines.push(`| ${family} | ${count} |`);
  }
  lines.push("");
  return lines;
}

export function formatSelfEvalReport(report: SelfEvalReport): string {
  const agg = report.aggregate;
  const lines: string[] = [
    `# Self-Eval Report — ${report.model}`,
    `Generated: ${report.generatedAt}`,
    `Runs per fixture: ${report.runsPerFixture}`,
    "",
    "## Task Outcome (post-run oracle — the utility signal)",
    "",
    "| Outcome | Runs |",
    "|---------|------|",
    `| Task passed | ${agg.taskPassedRuns} |`,
    `| Task failed | ${agg.taskFailedRuns} |`,
    `| Terminal incomplete (turn never completed) | ${agg.terminalIncompleteRuns} |`,
    `| Total runs | ${agg.runCount} (${agg.fixtureCount} fixtures) |`,
    "",
    "## Turn Liveness (diagnostic — how the turn ended, not task success)",
    "",
    "| Liveness | Runs |",
    "|----------|------|",
    `| Completed | ${agg.completedRuns} |`,
    `| Suspended (fail-closed) | ${agg.suspendedRuns} |`,
    `| Incomplete | ${agg.incompleteRuns} |`,
    `| Timed out | ${agg.timedOutRuns} |`,
    `| Unknown (no tape signal) | ${agg.unknownRuns} |`,
    "",
    "## Tool-Surface Exercise Profile (per family, committed)",
    "",
    `Distinct tools exercised: ${agg.distinctToolsUnion.length} (${agg.distinctToolsUnion.join(", ") || "none"}). ` +
      `Cost (aggregate): ${formatCost(agg.cost)}.`,
    "",
    ...formatFamilyTable(agg.perFamilyCounts),
    "## Per-Fixture",
    "",
    "| Fixture | Kind | Task | Turn | Turns | Tool calls | Distinct tools | Cost |",
    "|---------|------|------|------|-------|------------|----------------|------|",
  ];
  for (const run of report.runs) {
    const metrics = run.metrics;
    const liveness = run.timedOut ? "timed_out" : metrics.terminalOutcome;
    lines.push(
      `| ${run.fixtureId} | ${run.kind} | ${run.taskOutcome} | ${liveness} | ${metrics.turnCount} | ` +
        `${metrics.toolCallCount} | ${metrics.distinctTools.join(", ") || "none"} | ` +
        `${formatCost(metrics.cost)} |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

/**
 * Persist the report as a dated markdown file (the calibration cycle's ingest
 * shape) plus a sibling JSON for machine delta-tracking, under
 * `.brewva/reports/self-eval/<YYYY-MM-DD>.{md,json}`.
 */
export function persistSelfEvalReport(input: {
  readonly workspaceRoot: string;
  readonly report: SelfEvalReport;
}): { readonly markdownPath: string; readonly jsonPath: string } {
  const date = input.report.generatedAt.slice(0, 10);
  const dir = resolve(input.workspaceRoot, ...REPORTS_DIR_SEGMENTS);
  const markdownPath = join(dir, `${date}.md`);
  const jsonPath = join(dir, `${date}.json`);
  mkdirSync(dirname(markdownPath), { recursive: true });
  writeFileSync(markdownPath, `${formatSelfEvalReport(input.report)}\n`, "utf8");
  writeFileSync(jsonPath, `${JSON.stringify(input.report, null, 2)}\n`, "utf8");
  return { markdownPath, jsonPath };
}
