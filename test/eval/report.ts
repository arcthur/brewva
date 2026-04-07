import type {
  EvalReport,
  EvalResult,
  ScenarioReport,
  ShapeCheck,
  RubricCriterion,
} from "./types.js";

export function buildReport(
  results: EvalResult[],
  model: string,
  runsPerScenario: number,
): EvalReport {
  const grouped = new Map<string, EvalResult[]>();
  for (const r of results) {
    const existing = grouped.get(r.scenario_id) ?? [];
    existing.push(r);
    grouped.set(r.scenario_id, existing);
  }

  const scenarios: ScenarioReport[] = [];
  let totalPassAtK = 0;
  let totalAllRunsPass = 0;
  let totalPassingRuns = 0;
  let totalRuns = 0;

  for (const [scenarioId, runs] of grouped) {
    const passCount = runs.filter(
      (r) => r.shape_grade.pass && (r.rubric_grade?.pass ?? true),
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
    `| Single-run success rate (empirical) | ${(report.summary.empirical_pass_rate * 100).toFixed(1)}% |`,
    `| pass@${report.runs_per_scenario} (any success in k runs) | ${(report.summary.pass_at_k * 100).toFixed(1)}% |`,
    `| All ${report.runs_per_scenario} runs pass | ${(report.summary.all_runs_pass * 100).toFixed(1)}% |`,
    "",
    "## Per-Scenario",
    "",
    `| Scenario | Skill | Pass Rate | pass@${report.runs_per_scenario} | All Runs Pass |`,
    `|----------|-------|-----------|-------------------|---------------|`,
  ];

  for (const s of report.scenarios) {
    lines.push(
      `| ${s.scenario_id} | ${s.skill} | ${(s.pass_rate * 100).toFixed(0)}% | ${s.pass_at_k ? "yes" : "no"} | ${s.all_runs_pass ? "yes" : "no"} |`,
    );
  }

  lines.push("");

  for (const s of report.scenarios) {
    lines.push(`### ${s.scenario_id}`);
    lines.push("");
    for (const run of s.runs) {
      const shapeStatus = run.shape_grade.pass ? "PASS" : "FAIL";
      const rubricStatus = run.rubric_grade ? (run.rubric_grade.pass ? "PASS" : "FAIL") : "N/A";
      lines.push(
        `- Run ${run.run_index}: shape=${shapeStatus} rubric=${rubricStatus} (${run.duration_ms}ms)`,
      );
      if (run.error) {
        lines.push(`  - ERROR: ${run.error}`);
      }
      if (!run.shape_grade.pass) {
        for (const c of run.shape_grade.checks.filter((ch: ShapeCheck) => !ch.pass)) {
          lines.push(`  - FAIL: ${c.output_name} — ${c.rule} (${c.detail ?? ""})`);
        }
      }
      if (run.rubric_grade && !run.rubric_grade.pass) {
        for (const c of run.rubric_grade.criteria.filter((cr: RubricCriterion) => !cr.pass)) {
          lines.push(`  - FAIL: ${c.name} — ${c.evidence}`);
        }
      }
    }
    lines.push("");
  }

  return lines.join("\n");
}
