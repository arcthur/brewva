import { resolve } from "node:path";
import {
  buildDelegationEvidenceReport,
  createHostedRuntimeAdapter,
} from "@brewva/brewva-gateway/hosted";

interface CliOptions {
  workspaceRoot: string;
  sessionIds: string[];
}

function printUsage(): void {
  console.error(
    [
      "Usage: bun run script/report-delegation-evidence.ts [workspace-root] [--session <session-id>...]",
      "       Measures delegation trigger economics from the tape: reach by role/status/",
      "       waitMode, parallel-gate rejections, FAILURE counts by cause (the reliability",
      "       counter-signal), adoption outcomes, and child-token context economics.",
    ].join("\n"),
  );
}

function parseArgs(argv: readonly string[]): CliOptions | null {
  const sessionIds: string[] = [];
  let workspaceRoot: string | null = null;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (typeof argument !== "string") {
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      printUsage();
      return null;
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
  };
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  if (!options) {
    process.exit(0);
  }

  const runtime = createHostedRuntimeAdapter({ cwd: options.workspaceRoot });
  const report = buildDelegationEvidenceReport(runtime, {
    sessionIds: options.sessionIds.length > 0 ? options.sessionIds : undefined,
  });
  console.log(JSON.stringify(report, null, 2));
}

main();
