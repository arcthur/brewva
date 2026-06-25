import { resolve } from "node:path";
import {
  buildContextEvidenceReport,
  createHostedRuntimeAdapter,
  deriveContextEvidenceRecommendation,
  persistContextEvidenceReport,
} from "@brewva/brewva-gateway/hosted";

interface CliOptions {
  workspaceRoot: string;
  sessionIds: string[];
  longSessionUsefulTurnThreshold?: number;
  baselineUncachedInputTokensPerUsefulTurn?: number;
  promptCacheHitStopLossFloor?: number;
  inputCostRegressionLimit?: number;
  recommend: boolean;
}

function printUsage(): void {
  console.error(
    [
      "Usage: bun run script/report-context-evidence.ts [workspace-root] [--session <session-id>...]",
      "       [--long-session-turns <n>] [--baseline-uncached-input-per-turn <tokens>]",
      "       [--cache-hit-floor <ratio>] [--input-cost-regression-limit <ratio>]",
      "       [--recommend]  emit an evidence-fit ratio recommendation instead of the report",
    ].join("\n"),
  );
}

function parsePositiveNumber(flag: string, value: string | undefined): number {
  if (!value) {
    throw new Error(`Missing value for ${flag}.`);
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid positive numeric value for ${flag}: '${value}'.`);
  }
  return parsed;
}

function readFlagValue(
  argument: string,
  flag: string,
  argv: readonly string[],
  index: number,
): {
  value: string;
  consumedNext: boolean;
} | null {
  if (argument === flag) {
    return {
      value: argv[index + 1] ?? "",
      consumedNext: true,
    };
  }
  const prefix = `${flag}=`;
  if (argument.startsWith(prefix)) {
    return {
      value: argument.slice(prefix.length),
      consumedNext: false,
    };
  }
  return null;
}

function parseArgs(argv: readonly string[]): CliOptions | null {
  const sessionIds: string[] = [];
  let workspaceRoot: string | null = null;
  let longSessionUsefulTurnThreshold: number | undefined;
  let baselineUncachedInputTokensPerUsefulTurn: number | undefined;
  let promptCacheHitStopLossFloor: number | undefined;
  let inputCostRegressionLimit: number | undefined;
  let recommend = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (typeof argument !== "string") {
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      printUsage();
      return null;
    }
    if (argument === "--recommend") {
      recommend = true;
      continue;
    }
    if (argument === "--session") {
      const sessionId = argv[index + 1]?.trim();
      if (!sessionId) {
        throw new Error("Missing value for --session.");
      }
      sessionIds.push(sessionId);
      index += 1;
      continue;
    }
    if (argument.startsWith("--session=")) {
      const sessionId = argument.slice("--session=".length).trim();
      if (!sessionId) {
        throw new Error("Missing value for --session.");
      }
      sessionIds.push(sessionId);
      continue;
    }
    const numericFlags = [
      ["--long-session-turns", (value: number) => (longSessionUsefulTurnThreshold = value)],
      [
        "--baseline-uncached-input-per-turn",
        (value: number) => (baselineUncachedInputTokensPerUsefulTurn = value),
      ],
      ["--cache-hit-floor", (value: number) => (promptCacheHitStopLossFloor = value)],
      ["--input-cost-regression-limit", (value: number) => (inputCostRegressionLimit = value)],
    ] as const;
    let parsedNumericFlag = false;
    for (const [flag, assign] of numericFlags) {
      const value = readFlagValue(argument, flag, argv, index);
      if (!value) {
        continue;
      }
      assign(parsePositiveNumber(flag, value.value));
      if (value.consumedNext) {
        index += 1;
      }
      parsedNumericFlag = true;
      break;
    }
    if (parsedNumericFlag) {
      continue;
    }
    if (argument.startsWith("-")) {
      throw new Error(`Unknown option '${argument}'.`);
    }
    if (workspaceRoot !== null) {
      throw new Error("Only one workspace root may be provided.");
    }
    workspaceRoot = argument;
  }

  return {
    workspaceRoot: resolve(workspaceRoot ?? process.cwd()),
    sessionIds: [...new Set(sessionIds)],
    longSessionUsefulTurnThreshold,
    baselineUncachedInputTokensPerUsefulTurn,
    promptCacheHitStopLossFloor,
    inputCostRegressionLimit,
    recommend,
  };
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  if (!options) {
    process.exit(0);
  }

  const runtime = createHostedRuntimeAdapter({
    cwd: options.workspaceRoot,
  });
  const report = buildContextEvidenceReport(runtime, {
    sessionIds: options.sessionIds.length > 0 ? options.sessionIds : undefined,
    longSessionUsefulTurnThreshold: options.longSessionUsefulTurnThreshold,
    baselineUncachedInputTokensPerUsefulTurn: options.baselineUncachedInputTokensPerUsefulTurn,
    promptCacheHitStopLossFloor: options.promptCacheHitStopLossFloor,
    inputCostRegressionLimit: options.inputCostRegressionLimit,
  });
  persistContextEvidenceReport({
    workspaceRoot: options.workspaceRoot,
    report,
  });

  if (options.recommend) {
    const contextBudget = runtime.config.infrastructure.contextBudget;
    const recommendation = deriveContextEvidenceRecommendation({
      warm: report.aggregate.totalPostCompactionCacheWarmObservations,
      reset: report.aggregate.totalPostCompactionCacheResetObservations,
      advisoryRatio: contextBudget.thresholds.advisoryRatio,
      hardRatio: contextBudget.thresholds.hardRatio,
      tailProtectRatio: contextBudget.compaction.tailProtectRatio,
    });
    console.log(JSON.stringify(recommendation, null, 2));
    return;
  }

  console.log(JSON.stringify(report, null, 2));
}

main();
