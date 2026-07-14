import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import {
  compareSelfEvalReports,
  compareSelfEvalRetirementMatrix,
  formatSelfEvalComparison,
  formatSelfEvalRetirementMatrix,
} from "./compare.js";
import type { SelfEvalNonInferiorityVerdict } from "./compare.js";
import { parseSelfEvalReportJson } from "./report-schema.js";
import type { SelfEvalReport } from "./types.js";

function printUsage(): void {
  console.error(
    [
      "Usage: bun run report:self-eval:compare -- --baseline <report.json> --candidate <report.json>",
      "                                          [--baseline-label <name>] [--candidate-label <name>]",
      "                                          [--mode retirement|diagnostic] [--json]",
      "                                          [--margin <rate>] [--min-runs <n>] [--confidence <rate>]",
      "       bun run report:self-eval:compare -- --strong-baseline <json> --strong-candidate <json>",
      "                                          --weak-baseline <json> --weak-candidate <json>",
      "",
      "  Paired comparison of two self-eval report JSONs (the wording-change",
      "  behavior gate). Primary metric: oracle task success, judged against a",
      "  declared non-inferiority margin; tool-call cost is secondary. Few",
      "  paired runs yield an 'inconclusive' verdict, never a silent pass.",
      "  Pair mode defaults to the directional scaffold-retirement gate; use",
      "  --mode diagnostic for a non-decision-bearing comparison. Four-report",
      "  matrix mode is the only command that can declare global demotion eligibility.",
      "  Retirement policy is fixed at margin=0.10, confidence=0.95, and 30",
      "  paired runs per canonical fixture. Numeric overrides are diagnostic-only.",
      "  Exit codes: 0 non-inferior, 2 inferior, 3 inconclusive, 1 invalid input.",
    ].join("\n"),
  );
}

function loadReport(path: string): SelfEvalReport {
  return parseSelfEvalReportJson(JSON.parse(readFileSync(path, "utf8")), path);
}

export function exitCodeForSelfEvalVerdict(verdict: SelfEvalNonInferiorityVerdict): number {
  if (verdict === "non_inferior") return 0;
  if (verdict === "inferior") return 2;
  return 3;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      baseline: { type: "string" },
      candidate: { type: "string" },
      "strong-baseline": { type: "string" },
      "strong-candidate": { type: "string" },
      "weak-baseline": { type: "string" },
      "weak-candidate": { type: "string" },
      "baseline-label": { type: "string" },
      "candidate-label": { type: "string" },
      margin: { type: "string" },
      "min-runs": { type: "string" },
      confidence: { type: "string" },
      mode: { type: "string", default: "retirement" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });

  const matrixPaths = [
    values["strong-baseline"],
    values["strong-candidate"],
    values["weak-baseline"],
    values["weak-candidate"],
  ];
  const isMatrix = matrixPaths.some((path) => path !== undefined);
  if (values.help) {
    printUsage();
    return;
  }
  const numericOptions = {
    ...(values.margin ? { marginRate: Number(values.margin) } : {}),
    ...(values["min-runs"] ? { minRunsForVerdict: Number(values["min-runs"]) } : {}),
    ...(values.confidence ? { confidenceLevel: Number(values.confidence) } : {}),
  };
  if (isMatrix) {
    if (matrixPaths.some((path) => path === undefined)) {
      throw new Error("Matrix mode requires all strong/weak baseline/candidate report paths.");
    }
    if (values.mode !== "retirement") {
      throw new Error("Matrix mode is retirement-only; diagnostics cannot declare eligibility.");
    }
    const matrix = compareSelfEvalRetirementMatrix({
      strongBaseline: loadReport(values["strong-baseline"]!),
      strongCandidate: loadReport(values["strong-candidate"]!),
      weakBaseline: loadReport(values["weak-baseline"]!),
      weakCandidate: loadReport(values["weak-candidate"]!),
      ...numericOptions,
    });
    console.log(
      values.json ? JSON.stringify(matrix, null, 2) : formatSelfEvalRetirementMatrix(matrix),
    );
    process.exitCode = exitCodeForSelfEvalVerdict(matrix.verdict);
    return;
  }
  if (!values.baseline || !values.candidate) {
    printUsage();
    process.exitCode = 1;
    return;
  }
  if (values.mode !== "retirement" && values.mode !== "diagnostic") {
    throw new Error("--mode must be retirement or diagnostic.");
  }
  if (values.mode === "retirement" && Object.keys(numericOptions).length > 0) {
    throw new Error("Retirement policy is fixed; numeric overrides require --mode diagnostic.");
  }

  const comparison = compareSelfEvalReports({
    baseline: loadReport(values.baseline),
    candidate: loadReport(values.candidate),
    ...(values["baseline-label"] ? { baselineLabel: values["baseline-label"] } : {}),
    ...(values["candidate-label"] ? { candidateLabel: values["candidate-label"] } : {}),
    mode: values.mode,
    ...numericOptions,
  });

  console.log(
    values.json ? JSON.stringify(comparison, null, 2) : formatSelfEvalComparison(comparison),
  );
  process.exitCode = exitCodeForSelfEvalVerdict(comparison.overall.verdict);
}

if (import.meta.main) await main();
