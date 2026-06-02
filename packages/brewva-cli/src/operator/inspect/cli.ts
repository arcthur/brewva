import { parseArgs as parseNodeArgs } from "node:util";
import { createHostedRuntimeAdapter } from "@brewva/brewva-gateway/hosted";
import { loadBrewvaInspectConfigResolution } from "@brewva/brewva-runtime/config";
import { resolveInspectDirectory, type InspectDirectory } from "../inspect-analysis.js";
import {
  buildInspectCompactionProjection,
  formatInspectCompactionText,
  formatInspectDiagnosticText,
  formatInspectText,
  printInspectText,
} from "./output.js";
import {
  buildContextCockpitReport,
  buildInspectReport,
  buildSessionInspectReport,
  resolveTargetSession,
  type ContextCockpitReport,
  type InspectReport,
  type SessionInspectReport,
} from "./report.js";
import { buildTaskWorkCardProjection, formatTaskWorkCardText } from "./work-card.js";

const INSPECT_PARSE_OPTIONS = {
  help: { type: "boolean", short: "h" },
  cwd: { type: "string" },
  config: { type: "string" },
  session: { type: "string" },
  dir: { type: "string" },
  json: { type: "boolean" },
  compaction: { type: "boolean" },
  diagnostic: { type: "boolean" },
  raw: { type: "boolean" },
} as const;

function printInspectHelp(): void {
  console.log(`Brewva Inspect - replay-first session inspection with deterministic analysis

Usage:
  brewva inspect [directory] [options]

Options:
  --cwd <path>       Working directory
  --config <path>    Brewva config path (default: merged global + workspace config)
  --session <id>     Inspect a specific replay session
  --dir <path>       Target directory for deterministic analysis (alternative to positional argument)
  --json             Emit schema-tagged work card JSON
  --compaction       Emit focused compaction timeline and economics
  --diagnostic       Emit diagnostic drill-down text instead of the work card
  --raw              Emit the full diagnostic report JSON with --json, or diagnostic text otherwise
  -h, --help         Show help

Examples:
  brewva inspect
  brewva inspect packages/brewva-runtime/src
  brewva inspect --dir packages/brewva-cli/src
  brewva inspect --session <session-id>
  brewva inspect --session <session-id> --compaction
  brewva inspect --json --session <session-id>
  brewva inspect --diagnostic --session <session-id>`);
}

export async function runInspectCli(argv: string[]): Promise<number> {
  let parsed: ReturnType<typeof parseNodeArgs>;
  try {
    parsed = parseNodeArgs({
      args: argv,
      options: INSPECT_PARSE_OPTIONS,
      allowPositionals: true,
      strict: true,
    });
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  if (parsed.values.help === true) {
    printInspectHelp();
    return 0;
  }
  if (parsed.positionals.length > 1) {
    console.error(
      `Error: unexpected positional args for inspect: ${parsed.positionals.slice(1).join(" ")}`,
    );
    return 1;
  }

  const configPath = typeof parsed.values.config === "string" ? parsed.values.config : undefined;
  const configLoad = loadBrewvaInspectConfigResolution({
    cwd: typeof parsed.values.cwd === "string" ? parsed.values.cwd : undefined,
    configPath,
  });
  const runtime = createHostedRuntimeAdapter({
    cwd: typeof parsed.values.cwd === "string" ? parsed.values.cwd : undefined,
    config: configLoad.config,
  });
  const operatorRuntime = runtime;
  const targetSessionId = resolveTargetSession(
    operatorRuntime,
    typeof parsed.values.session === "string" ? parsed.values.session : undefined,
  );
  if (!targetSessionId) {
    console.error("Error: no replayable session found.");
    return 1;
  }

  let directory: InspectDirectory;
  try {
    directory = resolveInspectDirectory(
      operatorRuntime,
      typeof parsed.positionals[0] === "string" ? parsed.positionals[0] : undefined,
      typeof parsed.values.dir === "string" ? parsed.values.dir : undefined,
    );
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  const report = buildInspectReport(operatorRuntime, targetSessionId, {
    directory,
    configLoad: {
      mode: typeof parsed.values.config === "string" ? "explicit" : "merged_default",
      paths: [...configLoad.consultedPaths],
      warningCount: configLoad.warnings.length,
      warnings: configLoad.warnings.map((warning) => ({
        code: warning.code,
        configPath: warning.configPath,
        message: warning.message,
        fields: [...(warning.fields ?? [])],
      })),
    },
  });
  const workCard = buildTaskWorkCardProjection(report);
  if (parsed.values.json === true) {
    console.log(
      JSON.stringify(
        parsed.values.raw === true
          ? report
          : parsed.values.compaction === true
            ? buildInspectCompactionProjection(report)
            : workCard,
        null,
        2,
      ),
    );
  } else if (parsed.values.raw === true || parsed.values.diagnostic === true) {
    console.log(formatInspectDiagnosticText(report));
  } else if (parsed.values.compaction === true) {
    console.log(formatInspectCompactionText(report));
  } else {
    printInspectText(report);
  }
  return 0;
}

export {
  buildContextCockpitReport,
  buildInspectReport,
  buildSessionInspectReport,
  buildTaskWorkCardProjection,
  buildInspectCompactionProjection,
  formatInspectCompactionText,
  formatInspectDiagnosticText,
  formatInspectText,
  formatTaskWorkCardText,
  resolveInspectDirectory,
  resolveTargetSession,
};
export type { ContextCockpitReport, InspectReport, SessionInspectReport };
