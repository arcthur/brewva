import { parseArgs as parseNodeArgs } from "node:util";
import { createHostedRuntimeAdapter } from "@brewva/brewva-gateway/hosted";
import { loadBrewvaInspectConfigResolution } from "@brewva/brewva-runtime/config";
import { createCliInspectPort } from "../../runtime/cli-runtime-ports.js";
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
import { buildRunReportProjection, formatRunReportText } from "./run-report.js";
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
  "run-report": { type: "boolean" },
  "verify-replay": { type: "boolean" },
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
  --run-report       Emit the tape-derived run story: waits, approvals, error->fix cycles, verification depth
  --verify-replay    Verify recovery posture rebuilds identically from canonical tape (zero-cache)
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

function diffRecoveryViews(served: InspectReport, rebuilt: InspectReport): string[] {
  const divergences: string[] = [];
  if (served.hydration.status !== rebuilt.hydration.status) {
    divergences.push(
      `hydration.status (${served.hydration.status} vs ${rebuilt.hydration.status})`,
    );
  }
  if (served.hydration.latestEventId !== rebuilt.hydration.latestEventId) {
    divergences.push("hydration.cursor");
  }
  if (served.hydration.issueCount !== rebuilt.hydration.issueCount) {
    divergences.push("hydration.issues");
  }
  if (served.integrity.status !== rebuilt.integrity.status) {
    divergences.push(
      `integrity.status (${served.integrity.status} vs ${rebuilt.integrity.status})`,
    );
  }
  if (served.integrity.issueCount !== rebuilt.integrity.issueCount) {
    divergences.push("integrity.issues");
  }
  if (served.rewind.checkpointCount !== rebuilt.rewind.checkpointCount) {
    divergences.push("rewind.checkpointCount");
  }
  if (served.rewind.rewindAvailable !== rebuilt.rewind.rewindAvailable) {
    divergences.push("rewind.rewindAvailable");
  }
  if (served.rewind.redoAvailable !== rebuilt.rewind.redoAvailable) {
    divergences.push("rewind.redoAvailable");
  }
  const capabilitySignature = (report: InspectReport): string =>
    report.recoveryCapabilities.capabilities
      .map((capability) => `${capability.name}=${capability.available ? 1 : 0}`)
      .join(",");
  if (capabilitySignature(served) !== capabilitySignature(rebuilt)) {
    divergences.push("recoveryCapabilities");
  }
  return divergences;
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

  const configLoadMode: "explicit" | "merged_default" =
    typeof parsed.values.config === "string" ? "explicit" : "merged_default";
  const configLoadReport = {
    mode: configLoadMode,
    paths: [...configLoad.consultedPaths],
    warningCount: configLoad.warnings.length,
    warnings: configLoad.warnings.map((warning) => ({
      code: warning.code,
      configPath: warning.configPath,
      message: warning.message,
      fields: [...(warning.fields ?? [])],
    })),
  };
  if (parsed.values["run-report"] === true) {
    const inspectPort = createCliInspectPort(operatorRuntime);
    const runReport = buildRunReportProjection(
      targetSessionId,
      inspectPort.events.list(targetSessionId) ?? [],
    );
    console.log(
      parsed.values.json === true
        ? JSON.stringify(runReport, null, 2)
        : formatRunReportText(runReport),
    );
    return 0;
  }

  const report = buildInspectReport(operatorRuntime, targetSessionId, {
    directory,
    configLoad: configLoadReport,
  });

  if (parsed.values["verify-replay"] === true) {
    // Rebuild the recovery posture from a cold second adapter over the same tape
    // and compare it (normalized, ignoring display clocks) to the served report.
    const rebuilt = createHostedRuntimeAdapter({
      cwd: typeof parsed.values.cwd === "string" ? parsed.values.cwd : undefined,
      config: configLoad.config,
    });
    const rebuiltReport = buildInspectReport(rebuilt, targetSessionId, {
      directory,
      configLoad: configLoadReport,
    });
    const divergences = diffRecoveryViews(report, rebuiltReport);
    if (divergences.length > 0) {
      console.error(`Replay divergence for session ${targetSessionId}: ${divergences.join("; ")}`);
      return 1;
    }
    console.log(
      `Replay verified for session ${targetSessionId}: hydration, integrity, recovery capabilities, and rewind state rebuild identically from canonical tape.`,
    );
    return 0;
  }

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
