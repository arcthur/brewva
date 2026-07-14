import type { SelfEvalReport, SelfEvalRunResult, SelfEvalTaskKind } from "./types.js";

/**
 * Paired comparison of two self-eval reports — the behavior gate for skill
 * wording changes (RFC skill-discipline-calibration): run `report:self-eval`
 * on the baseline revision and on the candidate revision, then compare the
 * two report JSONs here. Pairing is per fixture; the primary metric is oracle
 * task success. This is a descriptive comparison with a declared
 * non-inferiority margin, not a statistical test — with few paired runs the
 * verdict is `inconclusive` (inconclusive is honest governance), never a
 * silent pass.
 */

export type SelfEvalNonInferiorityVerdict = "non_inferior" | "inferior" | "inconclusive";

export interface SelfEvalPairedSide {
  readonly runs: number;
  readonly taskPassed: number;
  readonly taskFailed: number;
  readonly terminalIncomplete: number;
  /** Task-success rate over ALL paired runs (incomplete counts against). */
  readonly taskSuccessRate: number;
  /** Mean committed tool calls per run — the ritual-cost secondary metric. */
  readonly meanToolCalls: number;
}

export interface SelfEvalPairedFixtureDelta {
  readonly fixtureId: string;
  readonly kind: SelfEvalTaskKind;
  readonly baseline: SelfEvalPairedSide;
  readonly candidate: SelfEvalPairedSide;
  /** candidate.taskSuccessRate - baseline.taskSuccessRate */
  readonly taskSuccessDelta: number;
  /** candidate.meanToolCalls - baseline.meanToolCalls */
  readonly meanToolCallDelta: number;
}

export interface SelfEvalPairedComparison {
  readonly schema: "brewva.self-eval.compare.v1";
  readonly baselineLabel: string;
  readonly candidateLabel: string;
  readonly baselineModel: string;
  readonly candidateModel: string;
  /** Task-success rate drop tolerated before the verdict turns `inferior`. */
  readonly marginRate: number;
  /** Minimum paired runs per side required for any verdict at all. */
  readonly minRunsForVerdict: number;
  readonly fixtures: readonly SelfEvalPairedFixtureDelta[];
  /** Fixture ids present in only one report — excluded from the comparison. */
  readonly unpairedFixtureIds: readonly string[];
  readonly overall: {
    readonly pairedRuns: { readonly baseline: number; readonly candidate: number };
    readonly baselineTaskSuccessRate: number;
    readonly candidateTaskSuccessRate: number;
    readonly taskSuccessDelta: number;
    readonly meanToolCallDelta: number;
    readonly verdict: SelfEvalNonInferiorityVerdict;
    readonly reason: string;
  };
}

const DEFAULT_MARGIN_RATE = 0.1;
const DEFAULT_MIN_RUNS_FOR_VERDICT = 10;

function round(value: number): number {
  return Number.parseFloat(value.toFixed(4));
}

function summarizeSide(runs: readonly SelfEvalRunResult[]): SelfEvalPairedSide {
  const taskPassed = runs.filter((run) => run.taskOutcome === "task_passed").length;
  const taskFailed = runs.filter((run) => run.taskOutcome === "task_failed").length;
  const terminalIncomplete = runs.filter((run) => run.taskOutcome === "terminal_incomplete").length;
  const toolCalls = runs.reduce((sum, run) => sum + run.metrics.toolCallCount, 0);
  return {
    runs: runs.length,
    taskPassed,
    taskFailed,
    terminalIncomplete,
    taskSuccessRate: runs.length === 0 ? 0 : round(taskPassed / runs.length),
    meanToolCalls: runs.length === 0 ? 0 : round(toolCalls / runs.length),
  };
}

function groupByFixture(
  report: SelfEvalReport,
): Map<string, { kind: SelfEvalTaskKind; runs: SelfEvalRunResult[] }> {
  const groups = new Map<string, { kind: SelfEvalTaskKind; runs: SelfEvalRunResult[] }>();
  for (const run of report.runs) {
    const group = groups.get(run.fixtureId) ?? { kind: run.kind, runs: [] };
    group.runs.push(run);
    groups.set(run.fixtureId, group);
  }
  return groups;
}

export function compareSelfEvalReports(input: {
  readonly baseline: SelfEvalReport;
  readonly candidate: SelfEvalReport;
  readonly baselineLabel?: string;
  readonly candidateLabel?: string;
  readonly marginRate?: number;
  readonly minRunsForVerdict?: number;
}): SelfEvalPairedComparison {
  const marginRate = input.marginRate ?? DEFAULT_MARGIN_RATE;
  const minRunsForVerdict = input.minRunsForVerdict ?? DEFAULT_MIN_RUNS_FOR_VERDICT;
  const baselineGroups = groupByFixture(input.baseline);
  const candidateGroups = groupByFixture(input.candidate);

  const pairedIds = [...baselineGroups.keys()]
    .filter((fixtureId) => candidateGroups.has(fixtureId))
    .toSorted((left, right) => left.localeCompare(right));
  const unpairedFixtureIds = [
    ...[...baselineGroups.keys()].filter((fixtureId) => !candidateGroups.has(fixtureId)),
    ...[...candidateGroups.keys()].filter((fixtureId) => !baselineGroups.has(fixtureId)),
  ].toSorted((left, right) => left.localeCompare(right));

  const fixtures: SelfEvalPairedFixtureDelta[] = pairedIds.map((fixtureId) => {
    const baselineGroup = baselineGroups.get(fixtureId) as NonNullable<
      ReturnType<typeof baselineGroups.get>
    >;
    const candidateGroup = candidateGroups.get(fixtureId) as NonNullable<
      ReturnType<typeof candidateGroups.get>
    >;
    const baseline = summarizeSide(baselineGroup.runs);
    const candidate = summarizeSide(candidateGroup.runs);
    return {
      fixtureId,
      kind: baselineGroup.kind,
      baseline,
      candidate,
      taskSuccessDelta: round(candidate.taskSuccessRate - baseline.taskSuccessRate),
      meanToolCallDelta: round(candidate.meanToolCalls - baseline.meanToolCalls),
    };
  });

  const baselinePairedRuns = fixtures.reduce((sum, entry) => sum + entry.baseline.runs, 0);
  const candidatePairedRuns = fixtures.reduce((sum, entry) => sum + entry.candidate.runs, 0);
  const baselinePassed = fixtures.reduce((sum, entry) => sum + entry.baseline.taskPassed, 0);
  const candidatePassed = fixtures.reduce((sum, entry) => sum + entry.candidate.taskPassed, 0);
  const baselineRate = baselinePairedRuns === 0 ? 0 : round(baselinePassed / baselinePairedRuns);
  const candidateRate =
    candidatePairedRuns === 0 ? 0 : round(candidatePassed / candidatePairedRuns);
  const taskSuccessDelta = round(candidateRate - baselineRate);
  const baselineMeanCalls =
    baselinePairedRuns === 0
      ? 0
      : fixtures.reduce(
          (sum, entry) => sum + entry.baseline.meanToolCalls * entry.baseline.runs,
          0,
        ) / baselinePairedRuns;
  const candidateMeanCalls =
    candidatePairedRuns === 0
      ? 0
      : fixtures.reduce(
          (sum, entry) => sum + entry.candidate.meanToolCalls * entry.candidate.runs,
          0,
        ) / candidatePairedRuns;

  let verdict: SelfEvalNonInferiorityVerdict;
  let reason: string;
  if (fixtures.length === 0) {
    verdict = "inconclusive";
    reason = "no paired fixtures between the two reports";
  } else if (baselinePairedRuns < minRunsForVerdict || candidatePairedRuns < minRunsForVerdict) {
    verdict = "inconclusive";
    reason =
      `insufficient paired runs for a verdict (baseline ${baselinePairedRuns}, ` +
      `candidate ${candidatePairedRuns}, need ${minRunsForVerdict} per side)`;
  } else if (taskSuccessDelta >= -marginRate) {
    verdict = "non_inferior";
    reason =
      `candidate task-success delta ${taskSuccessDelta} is within the ` +
      `declared margin -${marginRate}`;
  } else {
    verdict = "inferior";
    reason =
      `candidate task-success delta ${taskSuccessDelta} falls below the ` +
      `declared margin -${marginRate}`;
  }

  return {
    schema: "brewva.self-eval.compare.v1",
    baselineLabel: input.baselineLabel ?? "baseline",
    candidateLabel: input.candidateLabel ?? "candidate",
    baselineModel: input.baseline.model,
    candidateModel: input.candidate.model,
    marginRate,
    minRunsForVerdict,
    fixtures,
    unpairedFixtureIds,
    overall: {
      pairedRuns: { baseline: baselinePairedRuns, candidate: candidatePairedRuns },
      baselineTaskSuccessRate: baselineRate,
      candidateTaskSuccessRate: candidateRate,
      taskSuccessDelta,
      meanToolCallDelta: round(candidateMeanCalls - baselineMeanCalls),
      verdict,
      reason,
    },
  };
}

export function formatSelfEvalComparison(comparison: SelfEvalPairedComparison): string {
  const lines: string[] = [
    "# Self-eval paired comparison",
    "",
    `- baseline: ${comparison.baselineLabel} (model ${comparison.baselineModel})`,
    `- candidate: ${comparison.candidateLabel} (model ${comparison.candidateModel})`,
    `- non-inferiority margin: ${comparison.marginRate} task-success rate`,
    `- minimum paired runs per side: ${comparison.minRunsForVerdict}`,
    "",
    `## Verdict: ${comparison.overall.verdict}`,
    "",
    comparison.overall.reason,
    "",
    `- paired runs: baseline ${comparison.overall.pairedRuns.baseline}, candidate ${comparison.overall.pairedRuns.candidate}`,
    `- task success: baseline ${comparison.overall.baselineTaskSuccessRate} -> candidate ${comparison.overall.candidateTaskSuccessRate} (delta ${comparison.overall.taskSuccessDelta})`,
    `- mean tool calls per run delta: ${comparison.overall.meanToolCallDelta} (secondary; counts as improvement only at equal task success)`,
    "",
    "## Per fixture",
    "",
    "| fixture | kind | baseline pass | candidate pass | success delta | tool-call delta |",
    "| --- | --- | --- | --- | --- | --- |",
  ];
  for (const fixture of comparison.fixtures) {
    lines.push(
      `| ${fixture.fixtureId} | ${fixture.kind} | ${fixture.baseline.taskPassed}/${fixture.baseline.runs} | ${fixture.candidate.taskPassed}/${fixture.candidate.runs} | ${fixture.taskSuccessDelta} | ${fixture.meanToolCallDelta} |`,
    );
  }
  if (comparison.unpairedFixtureIds.length > 0) {
    lines.push("", `Unpaired fixtures (excluded): ${comparison.unpairedFixtureIds.join(", ")}`);
  }
  return lines.join("\n");
}
