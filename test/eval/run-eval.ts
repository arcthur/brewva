#!/usr/bin/env bun
import { join } from "node:path";
import { parseArgs } from "node:util";
import { loadScenarios, FixtureExecutor, RuntimeExecutor, runEval } from "./executor.js";
import { buildReport, formatReport } from "./report.js";
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

const executor =
  mode === "runtime" ? new RuntimeExecutor(model, values.workspace) : new FixtureExecutor();

console.log(
  `Running ${scenarios.length} scenario(s) × ${runsPerScenario} runs on model "${model}" [${mode} mode]`,
);

const allResults = [];

for (const scenario of scenarios) {
  const outputContracts = scenario.output_contracts;

  if (!outputContracts) {
    console.warn(`Scenario ${scenario.id}: no output_contracts — skipping`);
    continue;
  }

  for (let i = 0; i < runsPerScenario; i++) {
    const result = await runEval(executor, scenario, outputContracts, model, i);
    allResults.push(result);
  }
}

const report = buildReport(allResults, model, runsPerScenario);
console.log(formatReport(report));

if (allResults.some((result) => result.error)) {
  process.exitCode = 1;
}
