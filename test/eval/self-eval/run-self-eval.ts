import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { driveSelfEvalRun, requireUnattendedApprovalCarrier } from "./driver.js";
import { SELF_EVAL_FIXTURES } from "./fixtures.js";
import { buildSelfEvalReport, formatSelfEvalReport, persistSelfEvalReport } from "./report.js";
import type { SelfEvalFixture, SelfEvalRunResult } from "./types.js";

function printUsage(): void {
  console.error(
    [
      "Usage: bun run report:self-eval [--model <id>] [--runs <n>] [--fixture <id>]...",
      "                                [--workspace-root <dir>] [--list]",
      "",
      "  Drives the frozen self-eval fixtures through the embedded runtime, reads",
      "  per-run tape metrics, and writes a dated report under",
      "  .brewva/reports/self-eval/<YYYY-MM-DD>.{md,json}.",
      "",
      "  --model <id>            model for the print turns (default: workspace config)",
      "  --runs <n>              runs per fixture (default: 1)",
      "  --fixture <id>          restrict to the named fixture(s); repeatable",
      "  --workspace-root <dir>  where the report is written (default: cwd)",
      "  --list                  validate + list fixtures and exit (no runs, no provider)",
    ].join("\n"),
  );
}

function selectFixtures(filter: readonly string[] | undefined): readonly SelfEvalFixture[] {
  if (!filter || filter.length === 0) return SELF_EVAL_FIXTURES;
  const known = new Map(SELF_EVAL_FIXTURES.map((fixture) => [fixture.id, fixture]));
  const selected: SelfEvalFixture[] = [];
  for (const id of filter) {
    const fixture = known.get(id);
    if (!fixture) {
      throw new Error(`Unknown fixture "${id}". Known: ${[...known.keys()].join(", ")}.`);
    }
    selected.push(fixture);
  }
  return selected;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      model: { type: "string", default: "default" },
      runs: { type: "string", default: "1" },
      fixture: { type: "string", multiple: true },
      "workspace-root": { type: "string" },
      list: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });

  if (values.help) {
    printUsage();
    return;
  }

  const fixtures = selectFixtures(values.fixture);
  const runsPerFixture = Math.max(1, Math.trunc(Number(values.runs)) || 1);
  const workspaceRoot = resolve(values["workspace-root"] ?? process.cwd());

  if (values.list) {
    console.log(`Self-eval fixtures (${fixtures.length}):`);
    for (const fixture of fixtures) {
      // Actually validate (fail-closed) that each fixture carries the Phase-1
      // unattended envelope, so --list delivers on its "validate" promise
      // without a provider.
      requireUnattendedApprovalCarrier(fixture);
      console.log(`- ${fixture.id} [${fixture.kind}] — ${fixture.description}`);
    }
    return;
  }

  const results: SelfEvalRunResult[] = [];
  for (const fixture of fixtures) {
    for (let run = 1; run <= runsPerFixture; run += 1) {
      const result = await driveSelfEvalRun({ fixture, model: values.model });
      results.push(result);
      console.error(
        `[self-eval] ${fixture.id} ${run}/${runsPerFixture}: ${result.metrics.terminalOutcome} — ` +
          `tools=[${result.metrics.distinctTools.join(",") || "none"}] ` +
          `turns=${result.metrics.turnCount} calls=${result.metrics.toolCallCount}`,
      );
    }
  }

  const report = buildSelfEvalReport({
    runs: results,
    model: values.model,
    runsPerFixture,
    generatedAt: new Date().toISOString(),
  });
  const { markdownPath, jsonPath } = persistSelfEvalReport({ workspaceRoot, report });
  console.error(`[self-eval] wrote ${markdownPath}`);
  console.error(`[self-eval] wrote ${jsonPath}`);
  console.log(formatSelfEvalReport(report));
}

await main();
