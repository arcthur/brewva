#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  loadScenarios,
  FixtureExecutor,
  RuntimeExecutor,
  runEval,
  type SkillExecutor,
} from "./executor.js";
import { buildReport, formatReport } from "./report.js";
import type { EvalResult } from "./types.js";
import type { EvalScenario } from "./types.js";

const VALID_MODES = new Set(["runtime", "fixture"]);

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    skill: { type: "string" },
    model: { type: "string", default: "default" },
    runs: { type: "string", default: "3" },
    scenarios: { type: "string", default: join(import.meta.dir, "scenarios") },
    mode: { type: "string", default: "runtime" },
    workspace: { type: "string", default: process.cwd() },
    // Prompt-variant A/B for generic runtime scenarios: --appendix <file>
    // materializes the file as the temp workspace's AGENTS.md; --ab runs the
    // baseline AND the appendix variant and reports the pass-rate delta.
    appendix: { type: "string" },
    ab: { type: "boolean", default: false },
  },
});

const runsPerScenario = parseInt(values.runs, 10);
const model = values.model;
const scenariosDir = values.scenarios;
const mode = values.mode;

if (!VALID_MODES.has(mode)) {
  console.error(`Unsupported eval mode: ${mode}. Expected one of: runtime, fixture.`);
  process.exit(1);
}

let scenarios = loadScenarios(scenariosDir);

if (values.skill) {
  scenarios = scenarios.filter((s: EvalScenario) => s.skill === values.skill);
}

if (scenarios.length === 0) {
  console.error("No matching scenarios found.");
  process.exit(1);
}

if (mode === "fixture") {
  console.warn(
    "Fixture mode validates graders against curated outputs. It does not execute skills and does not measure real skill performance.",
  );
}

const appendixText =
  typeof values.appendix === "string" ? readFileSync(values.appendix, "utf8") : null;
if (values.ab && mode !== "runtime") {
  console.error("--ab requires runtime mode (fixture outputs carry no prompt variant).");
  process.exit(1);
}
if (values.ab && appendixText === null) {
  console.error("--ab requires --appendix <file> providing the candidate statements.");
  process.exit(1);
}

interface VariantPlan {
  readonly name: string;
  readonly executor: SkillExecutor;
}

const variants: VariantPlan[] =
  mode !== "runtime"
    ? [{ name: "fixture", executor: new FixtureExecutor() }]
    : values.ab
      ? [
          {
            name: "baseline",
            executor: new RuntimeExecutor(model, values.workspace, {
              variantText: null,
              variantName: "baseline",
            }),
          },
          {
            name: "candidate",
            executor: new RuntimeExecutor(model, values.workspace, {
              variantText: appendixText,
              variantName: "candidate",
            }),
          },
        ]
      : [
          {
            name: appendixText ? "candidate" : "baseline",
            executor: new RuntimeExecutor(model, values.workspace, {
              variantText: appendixText,
              variantName: appendixText ? "candidate" : "baseline",
            }),
          },
        ];

console.log(
  `Running ${scenarios.length} scenario(s) × ${runsPerScenario} runs on model "${model}" [${mode} mode]` +
    (variants.length > 1 ? ` — A/B variants: ${variants.map((v) => v.name).join(" vs ")}` : ""),
);

const resultsByVariant = new Map<string, EvalResult[]>();

for (const variant of variants) {
  const variantResults: EvalResult[] = [];
  for (const scenario of scenarios) {
    const outputContracts = scenario.output_contracts;
    if (!outputContracts) {
      console.warn(`Scenario ${scenario.id}: no output_contracts — skipping`);
      continue;
    }
    for (let i = 0; i < runsPerScenario; i++) {
      const result = await runEval(variant.executor, scenario, outputContracts, model, i);
      variantResults.push(result);
    }
  }
  resultsByVariant.set(variant.name, variantResults);
}

let anyError = false;
for (const [variantName, results] of resultsByVariant) {
  const report = buildReport(results, model, runsPerScenario);
  if (variants.length > 1) {
    console.log(`\n\n# Variant: ${variantName}`);
  }
  console.log(formatReport(report));
  anyError ||= results.some((result) => result.error);
}

if (variants.length > 1) {
  console.log(formatAbDelta(resultsByVariant));
}

if (anyError) {
  process.exitCode = 1;
}

interface VariantScenarioRate {
  readonly rate: number;
  readonly errored: number;
}

function passRate(results: EvalResult[], scenarioId: string): VariantScenarioRate | null {
  const runs = results.filter((result) => result.scenario_id === scenarioId);
  if (runs.length === 0) return null;
  const passed = runs.filter(
    (result) => result.shape_grade.pass && (result.rubric_grade?.pass ?? true) && !result.error,
  ).length;
  return {
    rate: passed / runs.length,
    errored: runs.filter((result) => Boolean(result.error)).length,
  };
}

function formatAbDelta(byVariant: Map<string, EvalResult[]>): string {
  const baseline = byVariant.get("baseline") ?? [];
  const candidate = byVariant.get("candidate") ?? [];
  const scenarioIds = [
    ...new Set([...baseline, ...candidate].map((r) => r.scenario_id)),
  ].toSorted();
  const lines = [
    "\n\n# A/B Delta (candidate − baseline; positive = statements help)",
    "| scenario | baseline | candidate | delta |",
    "| --- | --- | --- | --- |",
  ];
  for (const id of scenarioIds) {
    const base = passRate(baseline, id);
    const cand = passRate(candidate, id);
    const delta = base !== null && cand !== null ? cand.rate - base.rate : null;
    // Infra errors count as failures but must stay visible: a timed-out run
    // silently diluted into the rate would read as "the statements hurt".
    const fmt = (value: VariantScenarioRate | null) =>
      value === null
        ? "—"
        : `${(value.rate * 100).toFixed(0)}%${value.errored > 0 ? ` (${value.errored} err)` : ""}`;
    lines.push(
      `| ${id} | ${fmt(base)} | ${fmt(cand)} | ${delta === null ? "—" : `${delta >= 0 ? "+" : ""}${(delta * 100).toFixed(0)}pp`} |`,
    );
  }
  lines.push(
    "",
    "Gate (RFC R5): the statements land only on a positive delta that replicates",
    "across independent runs; a flat or negative delta means they are dropped.",
  );
  return lines.join("\n");
}
