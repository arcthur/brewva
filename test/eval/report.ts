import type {
  EvalReport,
  EvalResult,
  RecallEvalMetrics,
  RecallEvalMetricsAggregate,
  ScenarioReport,
  ShapeCheck,
  RubricCriterion,
} from "./types.js";

function average(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function aggregateRecallMetrics(
  results: readonly EvalResult[],
): RecallEvalMetricsAggregate | undefined {
  const recallResults = results.filter(
    (
      result,
    ): result is EvalResult & { telemetry: { kind: "recall"; metrics: RecallEvalMetrics } } =>
      result.telemetry?.kind === "recall",
  );
  if (recallResults.length === 0) {
    return undefined;
  }

  const metricKeys = [
    "baseline_precision_at_k",
    "broker_precision_at_k",
    "precision_gain_at_k",
    "baseline_useful_recall_rate",
    "broker_useful_recall_rate",
    "useful_recall_gain",
    "baseline_harmful_recall_rate",
    "broker_harmful_recall_rate",
    "baseline_contradiction_rate",
    "broker_contradiction_rate",
    "baseline_latency_ms",
    "broker_latency_ms",
    "added_latency_ms",
    "baseline_token_cost",
    "broker_token_cost",
    "added_token_cost",
  ] as const satisfies readonly (keyof RecallEvalMetrics)[];

  const averages = new Map(
    metricKeys.map((key) => [
      key,
      average(recallResults.map((result) => result.telemetry.metrics[key])),
    ]),
  );
  const averageOptional = (key: keyof RecallEvalMetrics): number | undefined => {
    const values = recallResults
      .map((result) => result.telemetry.metrics[key])
      .filter((value): value is number => typeof value === "number");
    return values.length > 0 ? average(values) : undefined;
  };
  const brokerWithoutIntentTop1 = averageOptional("broker_without_intent_top_1_hit_rate");
  const brokerWithIntentTop1 = averageOptional("broker_with_intent_top_1_hit_rate");
  const intentTop1Gain = averageOptional("intent_top_1_gain");

  return {
    scenario_count: new Set(recallResults.map((result) => result.scenario_id)).size,
    run_count: recallResults.length,
    baseline_precision_at_k: averages.get("baseline_precision_at_k")!,
    broker_precision_at_k: averages.get("broker_precision_at_k")!,
    precision_gain_at_k: averages.get("precision_gain_at_k")!,
    ...(brokerWithoutIntentTop1 !== undefined
      ? { broker_without_intent_top_1_hit_rate: brokerWithoutIntentTop1 }
      : {}),
    ...(brokerWithIntentTop1 !== undefined
      ? { broker_with_intent_top_1_hit_rate: brokerWithIntentTop1 }
      : {}),
    ...(intentTop1Gain !== undefined ? { intent_top_1_gain: intentTop1Gain } : {}),
    baseline_useful_recall_rate: averages.get("baseline_useful_recall_rate")!,
    broker_useful_recall_rate: averages.get("broker_useful_recall_rate")!,
    useful_recall_gain: averages.get("useful_recall_gain")!,
    baseline_harmful_recall_rate: averages.get("baseline_harmful_recall_rate")!,
    broker_harmful_recall_rate: averages.get("broker_harmful_recall_rate")!,
    baseline_contradiction_rate: averages.get("baseline_contradiction_rate")!,
    broker_contradiction_rate: averages.get("broker_contradiction_rate")!,
    baseline_latency_ms: averages.get("baseline_latency_ms")!,
    broker_latency_ms: averages.get("broker_latency_ms")!,
    added_latency_ms: averages.get("added_latency_ms")!,
    baseline_token_cost: averages.get("baseline_token_cost")!,
    broker_token_cost: averages.get("broker_token_cost")!,
    added_token_cost: averages.get("added_token_cost")!,
  };
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

export function buildReport(
  results: EvalResult[],
  model: string,
  runsPerScenario: number,
): EvalReport {
  const grouped = new Map<string, EvalResult[]>();
  for (const result of results) {
    const existing = grouped.get(result.scenario_id) ?? [];
    existing.push(result);
    grouped.set(result.scenario_id, existing);
  }

  const scenarios: ScenarioReport[] = [];
  let totalPassAtK = 0;
  let totalAllRunsPass = 0;
  let totalPassingRuns = 0;
  let totalRuns = 0;

  for (const [scenarioId, runs] of grouped) {
    const passCount = runs.filter(
      (result) => result.shape_grade.pass && (result.rubric_grade?.pass ?? true),
    ).length;

    const passRate = passCount / runs.length;
    const passAtK = passCount > 0;
    const allRunsPass = passCount === runs.length;

    totalPassingRuns += passCount;
    totalRuns += runs.length;
    if (passAtK) totalPassAtK++;
    if (allRunsPass) totalAllRunsPass++;

    scenarios.push({
      scenario_id: scenarioId,
      skill: runs[0]!.skill,
      runs,
      pass_at_k: passAtK,
      all_runs_pass: allRunsPass,
      pass_rate: passRate,
      recall_metrics: aggregateRecallMetrics(runs),
    });
  }

  const totalScenarios = scenarios.length;

  return {
    generated_at: new Date().toISOString(),
    model,
    runs_per_scenario: runsPerScenario,
    scenarios,
    summary: {
      total_scenarios: totalScenarios,
      empirical_pass_rate: totalRuns > 0 ? totalPassingRuns / totalRuns : 0,
      pass_at_k: totalScenarios > 0 ? totalPassAtK / totalScenarios : 0,
      all_runs_pass: totalScenarios > 0 ? totalAllRunsPass / totalScenarios : 0,
      k: runsPerScenario,
      total_runs: totalRuns,
      recall_metrics: aggregateRecallMetrics(results),
    },
  };
}

export function formatReport(report: EvalReport): string {
  const lines: string[] = [
    `# Eval Report — ${report.model}`,
    `Generated: ${report.generated_at}`,
    `Runs per scenario: ${report.runs_per_scenario}`,
    "",
    "## Summary",
    "",
    `| Metric | Value |`,
    `|--------|-------|`,
    `| Scenarios | ${report.summary.total_scenarios} |`,
    `| Total runs | ${report.summary.total_runs} |`,
    `| Single-run success rate (empirical) | ${formatPercent(report.summary.empirical_pass_rate)} |`,
    `| pass@${report.runs_per_scenario} (any success in k runs) | ${formatPercent(report.summary.pass_at_k)} |`,
    `| All ${report.runs_per_scenario} runs pass | ${formatPercent(report.summary.all_runs_pass)} |`,
    "",
    "## Per-Scenario",
    "",
    `| Scenario | Skill | Pass Rate | pass@${report.runs_per_scenario} | All Runs Pass |`,
    `|----------|-------|-----------|-------------------|---------------|`,
  ];

  for (const scenario of report.scenarios) {
    lines.push(
      `| ${scenario.scenario_id} | ${scenario.skill} | ${formatPercent(scenario.pass_rate)} | ${scenario.pass_at_k ? "yes" : "no"} | ${scenario.all_runs_pass ? "yes" : "no"} |`,
    );
  }

  lines.push("");

  if (report.summary.recall_metrics) {
    const metrics = report.summary.recall_metrics;
    lines.push("## Recall Metrics");
    lines.push("");
    lines.push(`Recall runs: ${metrics.run_count} across ${metrics.scenario_count} scenario(s)`);
    lines.push("");
    lines.push(`| Metric | Baseline | Broker | Delta |`);
    lines.push(`|--------|----------|--------|-------|`);
    lines.push(
      `| Broker precision@k | ${formatPercent(metrics.baseline_precision_at_k)} | ${formatPercent(metrics.broker_precision_at_k)} | ${formatPercent(metrics.precision_gain_at_k)} |`,
    );
    lines.push(
      `| Useful recall rate | ${formatPercent(metrics.baseline_useful_recall_rate)} | ${formatPercent(metrics.broker_useful_recall_rate)} | ${formatPercent(metrics.useful_recall_gain)} |`,
    );
    if (
      metrics.broker_without_intent_top_1_hit_rate !== undefined &&
      metrics.broker_with_intent_top_1_hit_rate !== undefined &&
      metrics.intent_top_1_gain !== undefined
    ) {
      lines.push(
        `| Intent top-1 hit rate | ${formatPercent(metrics.broker_without_intent_top_1_hit_rate)} | ${formatPercent(metrics.broker_with_intent_top_1_hit_rate)} | ${formatPercent(metrics.intent_top_1_gain)} |`,
      );
    }
    lines.push(
      `| Harmful recall rate | ${formatPercent(metrics.baseline_harmful_recall_rate)} | ${formatPercent(metrics.broker_harmful_recall_rate)} | ${formatPercent(metrics.broker_harmful_recall_rate - metrics.baseline_harmful_recall_rate)} |`,
    );
    lines.push(
      `| Contradiction rate | ${formatPercent(metrics.baseline_contradiction_rate)} | ${formatPercent(metrics.broker_contradiction_rate)} | ${formatPercent(metrics.broker_contradiction_rate - metrics.baseline_contradiction_rate)} |`,
    );
    lines.push(
      `| Startup latency (ms) | ${metrics.baseline_latency_ms.toFixed(2)} | ${metrics.broker_latency_ms.toFixed(2)} | ${metrics.added_latency_ms.toFixed(2)} |`,
    );
    lines.push(
      `| Added token cost | ${metrics.baseline_token_cost.toFixed(1)} | ${metrics.broker_token_cost.toFixed(1)} | ${metrics.added_token_cost.toFixed(1)} |`,
    );
    lines.push("");
  }

  for (const scenario of report.scenarios) {
    lines.push(`### ${scenario.scenario_id}`);
    lines.push("");
    if (scenario.recall_metrics) {
      const intentMetrics =
        scenario.recall_metrics.intent_top_1_gain !== undefined
          ? ` intent_top1_gain=${scenario.recall_metrics.intent_top_1_gain.toFixed(2)}`
          : "";
      lines.push(
        `- Recall metrics: baseline_precision@k=${scenario.recall_metrics.baseline_precision_at_k.toFixed(2)} broker_precision@k=${scenario.recall_metrics.broker_precision_at_k.toFixed(2)} useful_rate=${scenario.recall_metrics.broker_useful_recall_rate.toFixed(2)} harmful_rate=${scenario.recall_metrics.broker_harmful_recall_rate.toFixed(2)} contradiction_rate=${scenario.recall_metrics.broker_contradiction_rate.toFixed(2)} added_latency_ms=${scenario.recall_metrics.added_latency_ms.toFixed(2)} added_token_cost=${scenario.recall_metrics.added_token_cost.toFixed(1)}${intentMetrics}`,
      );
    }
    for (const run of scenario.runs) {
      const shapeStatus = run.shape_grade.pass ? "PASS" : "FAIL";
      const rubricStatus = run.rubric_grade ? (run.rubric_grade.pass ? "PASS" : "FAIL") : "N/A";
      lines.push(
        `- Run ${run.run_index}: shape=${shapeStatus} rubric=${rubricStatus} (${run.duration_ms}ms)`,
      );
      if (run.telemetry?.kind === "recall") {
        lines.push(
          `  - Broker precision@k=${run.telemetry.metrics.broker_precision_at_k.toFixed(2)} useful=${run.telemetry.metrics.broker_useful_recall_rate.toFixed(2)} harmful=${run.telemetry.metrics.broker_harmful_recall_rate.toFixed(2)} contradiction=${run.telemetry.metrics.broker_contradiction_rate.toFixed(2)}`,
        );
      }
      if (run.error) {
        lines.push(`  - ERROR: ${run.error}`);
      }
      if (!run.shape_grade.pass) {
        for (const check of run.shape_grade.checks.filter((entry: ShapeCheck) => !entry.pass)) {
          lines.push(`  - FAIL: ${check.output_name} — ${check.rule} (${check.detail ?? ""})`);
        }
      }
      if (run.rubric_grade && !run.rubric_grade.pass) {
        for (const criterion of run.rubric_grade.criteria.filter(
          (entry: RubricCriterion) => !entry.pass,
        )) {
          lines.push(`  - FAIL: ${criterion.name} — ${criterion.evidence}`);
        }
      }
    }
    lines.push("");
  }

  return lines.join("\n");
}
