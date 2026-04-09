import { resolve } from "node:path";
import {
  buildContextEvidenceReport,
  persistContextEvidenceReport,
} from "@brewva/brewva-gateway/runtime-plugins";
import { BrewvaRuntime } from "@brewva/brewva-runtime";

interface CliOptions {
  workspaceRoot: string;
  sessionIds: string[];
}

function printUsage(): void {
  console.error(
    "Usage: bun run script/report-context-evidence.ts [workspace-root] [--session <session-id>...]",
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
    process.exit(1);
  }

  const runtime = new BrewvaRuntime({
    cwd: options.workspaceRoot,
  });
  const report = buildContextEvidenceReport(runtime, {
    sessionIds: options.sessionIds.length > 0 ? options.sessionIds : undefined,
  });
  persistContextEvidenceReport({
    workspaceRoot: options.workspaceRoot,
    report,
  });
  console.log(JSON.stringify(report, null, 2));
}

main();
