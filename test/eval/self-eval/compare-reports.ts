import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { compareSelfEvalReports, formatSelfEvalComparison } from "./compare.js";
import type { SelfEvalReport } from "./types.js";

function printUsage(): void {
  console.error(
    [
      "Usage: bun run report:self-eval:compare -- --baseline <report.json> --candidate <report.json>",
      "                                          [--baseline-label <name>] [--candidate-label <name>]",
      "                                          [--margin <rate>] [--min-runs <n>] [--json]",
      "",
      "  Paired comparison of two self-eval report JSONs (the wording-change",
      "  behavior gate). Primary metric: oracle task success, judged against a",
      "  declared non-inferiority margin; tool-call cost is secondary. Few",
      "  paired runs yield an 'inconclusive' verdict, never a silent pass.",
    ].join("\n"),
  );
}

function loadReport(path: string): SelfEvalReport {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    (parsed as { schema?: unknown }).schema !== "brewva.self-eval.report.v2"
  ) {
    throw new Error(`${path} is not a brewva.self-eval.report.v2 JSON`);
  }
  return parsed as SelfEvalReport;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      baseline: { type: "string" },
      candidate: { type: "string" },
      "baseline-label": { type: "string" },
      "candidate-label": { type: "string" },
      margin: { type: "string" },
      "min-runs": { type: "string" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });

  if (values.help || !values.baseline || !values.candidate) {
    printUsage();
    if (!values.help) process.exitCode = 1;
    return;
  }

  const comparison = compareSelfEvalReports({
    baseline: loadReport(values.baseline),
    candidate: loadReport(values.candidate),
    ...(values["baseline-label"] ? { baselineLabel: values["baseline-label"] } : {}),
    ...(values["candidate-label"] ? { candidateLabel: values["candidate-label"] } : {}),
    ...(values.margin ? { marginRate: Number(values.margin) } : {}),
    ...(values["min-runs"] ? { minRunsForVerdict: Number(values["min-runs"]) } : {}),
  });

  console.log(
    values.json ? JSON.stringify(comparison, null, 2) : formatSelfEvalComparison(comparison),
  );
}

await main();
