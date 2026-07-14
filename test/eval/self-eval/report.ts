import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type {
  SelfEvalAggregate,
  SelfEvalCostObservation,
  SelfEvalReport,
  SelfEvalRunResult,
  SelfEvalFixture,
  SelfEvalEvaluationMode,
  SelfEvalModelTier,
  SelfEvalPilotSkill,
  SelfEvalSkillArm,
} from "./types.js";

const REPORT_SCHEMA = "brewva.self-eval.report.v4" as const;
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
  readonly requestedModel: string;
  readonly runsPerFixture: number;
  readonly generatedAt: string;
  readonly experimentId: string;
  readonly evaluationMode: SelfEvalEvaluationMode;
  readonly arm: SelfEvalSkillArm;
  readonly pilotSkill: SelfEvalPilotSkill;
  readonly modelTier: SelfEvalModelTier;
  readonly sourceRevision: string;
  readonly evaluatorCorpusDigest: string;
  readonly fixtureCorpusDigest: string;
}): SelfEvalReport {
  if (!Number.isInteger(input.runsPerFixture) || input.runsPerFixture < 1) {
    throw new Error("Self-eval report runsPerFixture must be a positive integer.");
  }
  const firstContext = input.runs[0]?.skillContext;
  if (!firstContext) throw new Error("Self-eval report requires at least one run.");
  if (firstContext.arm !== input.arm) {
    throw new Error(
      `Self-eval run arm ${firstContext.arm} does not match report arm ${input.arm}.`,
    );
  }
  for (const run of input.runs) {
    if (
      run.skillContext.arm !== firstContext.arm ||
      run.skillContext.skillCorpusDigest !== firstContext.skillCorpusDigest ||
      JSON.stringify(run.skillContext.loadedSkills) !== JSON.stringify(firstContext.loadedSkills)
    ) {
      throw new Error("Self-eval runs do not share one immutable skill corpus identity.");
    }
  }
  const runIndexesByFixture = new Map<string, number[]>();
  for (const run of input.runs) {
    const indexes = runIndexesByFixture.get(run.fixtureId) ?? [];
    indexes.push(run.runIndex);
    runIndexesByFixture.set(run.fixtureId, indexes);
  }
  const expectedIndexes = Array.from({ length: input.runsPerFixture }, (_, index) => index + 1);
  for (const [fixtureId, indexes] of runIndexesByFixture) {
    if (
      JSON.stringify(indexes.toSorted((left, right) => left - right)) !==
      JSON.stringify(expectedIndexes)
    ) {
      throw new Error(
        `Self-eval fixture ${fixtureId} must contain run indexes 1..${input.runsPerFixture}.`,
      );
    }
  }
  return {
    schema: REPORT_SCHEMA,
    generatedAt: input.generatedAt,
    requestedModel: input.requestedModel,
    observedModelRoutes: [
      ...new Set(input.runs.flatMap((run) => run.observedModelRoutes)),
    ].toSorted(),
    runsPerFixture: input.runsPerFixture,
    experiment: {
      id: input.experimentId,
      evaluationMode: input.evaluationMode,
      arm: input.arm,
      pilotSkill: input.pilotSkill,
      modelTier: input.modelTier,
      sourceRevision: input.sourceRevision,
      evaluatorCorpusDigest: input.evaluatorCorpusDigest,
      fixtureCorpusDigest: input.fixtureCorpusDigest,
      skillCorpusDigest: firstContext.skillCorpusDigest,
      loadedSkills: firstContext.loadedSkills,
    },
    runs: input.runs,
    aggregate: aggregateRuns(input.runs),
  };
}

// Code-unit ordering (never locale-sensitive `localeCompare`): this feeds
// `fixtureCorpusDigest`, which `compare.ts` recomputes and hard-compares across
// hosts, so the key order must be identical regardless of the host's ICU
// collation. Matches the code-unit `.toSorted()` in `digestSelfEvalEvaluator`.
function byCodeUnit(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .toSorted(([left], [right]) => byCodeUnit(left, right))
      .map(([key, entry]) => [key, stableValue(entry)]),
  );
}

export function digestSelfEvalFixtures(fixtures: readonly SelfEvalFixture[]): string {
  return createHash("sha256")
    .update(JSON.stringify(stableValue(fixtures)))
    .digest("hex");
}

function appendEvaluatorPath(
  hash: ReturnType<typeof createHash>,
  sourceRoot: string,
  path: string,
): void {
  if (statSync(path).isDirectory()) {
    for (const entry of readdirSync(path).toSorted()) {
      appendEvaluatorPath(hash, sourceRoot, join(path, entry));
    }
    return;
  }
  hash.update(path.slice(sourceRoot.length));
  hash.update("\0");
  hash.update(readFileSync(path));
  hash.update("\0");
}

/** Hash every implementation seam that can change how an arm is staged or scored. */
export function digestSelfEvalEvaluator(sourceRoot: string): string {
  const hash = createHash("sha256");
  for (const relativePath of [
    "test/eval/self-eval",
    "test/eval/print-turn.ts",
    "test/eval/workspace-staging.ts",
    "test/helpers/events.ts",
    "packages/brewva-gateway/src/hosted/internal/session/runtime-ops-builders/skills.ts",
  ]) {
    appendEvaluatorPath(hash, sourceRoot, resolve(sourceRoot, relativePath));
  }
  return hash.digest("hex");
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
    `# Self-Eval Report — ${report.experiment.id}`,
    `Generated: ${report.generatedAt}`,
    `Evaluation mode: ${report.experiment.evaluationMode}`,
    `Arm: ${report.experiment.arm}`,
    `Pilot skill: ${report.experiment.pilotSkill}`,
    `Model tier: ${report.experiment.modelTier}`,
    `Requested model: ${report.requestedModel}`,
    `Observed model routes: ${report.observedModelRoutes.join(", ") || "none"}`,
    `Source revision: ${report.experiment.sourceRevision}`,
    `Evaluator corpus: ${report.experiment.evaluatorCorpusDigest}`,
    `Fixture corpus: ${report.experiment.fixtureCorpusDigest}`,
    `Skill corpus: ${report.experiment.skillCorpusDigest}`,
    `Loaded skills: ${report.experiment.loadedSkills.map((skill) => skill.name).join(", ") || "none"}`,
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
    "| Fixture | Kind | Task | Turn | Treatment exposure | Turns | Tool calls | Distinct tools | Cost |",
    "|---------|------|------|------|--------------------|-------|------------|----------------|------|",
  ];
  for (const run of report.runs) {
    const metrics = run.metrics;
    const liveness = run.timedOut ? "timed_out" : metrics.terminalOutcome;
    const exposure = !run.treatmentExposure.targetRelevant
      ? "not_relevant"
      : [
          run.treatmentExposure.targetSkillOffered ? "offered" : "not_offered",
          run.treatmentExposure.targetSkillOpened ? "skill_opened" : "skill_not_opened",
          run.treatmentExposure.strictScaffoldOpened ? "scaffold_opened" : "scaffold_not_opened",
        ].join("+");
    lines.push(
      `| ${run.fixtureId} | ${run.kind} | ${run.taskOutcome} | ${liveness} | ${exposure} | ${metrics.turnCount} | ` +
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
 * `.brewva/reports/self-eval/<timestamp>--<experiment>--<skill>--<tier>--<arm>.{md,json}`.
 */
export function persistSelfEvalReport(input: {
  readonly workspaceRoot: string;
  readonly report: SelfEvalReport;
}): { readonly markdownPath: string; readonly jsonPath: string } {
  const slug = (value: string): string =>
    value
      .trim()
      .replace(/[^A-Za-z0-9._-]+/gu, "-")
      .replace(/^-+|-+$/gu, "");
  const timestamp = slug(input.report.generatedAt);
  const basename =
    `${timestamp}--${slug(input.report.experiment.id)}--${input.report.experiment.pilotSkill}` +
    `--${input.report.experiment.modelTier}--${input.report.experiment.arm}`;
  const dir = resolve(input.workspaceRoot, ...REPORTS_DIR_SEGMENTS);
  const markdownPath = join(dir, `${basename}.md`);
  const jsonPath = join(dir, `${basename}.json`);
  mkdirSync(dirname(markdownPath), { recursive: true });
  writeFileSync(jsonPath, `${JSON.stringify(input.report, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
  try {
    writeFileSync(markdownPath, `${formatSelfEvalReport(input.report)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
  } catch (error) {
    unlinkSync(jsonPath);
    throw error;
  }
  return { markdownPath, jsonPath };
}
