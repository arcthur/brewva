import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, resolve as resolvePath } from "node:path";
import { parseTscDiagnostics, type TscDiagnostic } from "@brewva/brewva-runtime/protocol";
import { runCommand } from "../internal/command.js";

export const LSP_DIAGNOSTIC_SEVERITIES = [
  "error",
  "warning",
  "information",
  "hint",
  "all",
] as const;

const require = createRequire(import.meta.url);

function resolveTscBinPath(): string {
  try {
    return require.resolve("typescript/bin/tsc");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`TypeScript diagnostics runtime is unavailable: ${detail}`, { cause: error });
  }
}

function parseSeverityLine(line: string): "error" | "warning" | "information" | "hint" {
  const lower = line.toLowerCase();
  if (lower.includes("error")) return "error";
  if (lower.includes("warning")) return "warning";
  if (lower.includes("hint")) return "hint";
  return "information";
}

export type DiagnosticsRun = {
  text: string;
  status: "ok" | "unavailable";
  reason?: "diagnostics_scope_mismatch";
  exitCode: number;
  filteredLineCount: number;
  diagnostics: TscDiagnostic[];
  truncated: boolean;
  countsByCode: Record<string, number>;
};

export async function runTscDiagnostics(
  cwd: string,
  filePath: string,
  severity?: string,
): Promise<DiagnosticsRun> {
  const tsconfigPath = resolvePath(cwd, "tsconfig.json");
  const args = [resolveTscBinPath(), "--noEmit", "--pretty", "false"];
  if (existsSync(tsconfigPath)) {
    args.push("--project", tsconfigPath);
  }

  const result = await runCommand(process.execPath, args, {
    cwd,
    timeoutMs: 120000,
  });

  if (result.exitCode === 0) {
    return {
      text: "No diagnostics found",
      status: "ok",
      exitCode: 0,
      filteredLineCount: 0,
      diagnostics: [],
      truncated: false,
      countsByCode: {},
    };
  }

  const combined = `${result.stdout}\n${result.stderr}`;
  const lines = combined
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => line.includes(basename(filePath)) || line.includes(resolvePath(filePath)));

  const filtered =
    severity && severity !== "all"
      ? lines.filter((line) => parseSeverityLine(line) === severity)
      : lines;

  if (filtered.length === 0) {
    return {
      text: "No matching diagnostics for the requested file/severity scope.",
      status: "unavailable",
      reason: "diagnostics_scope_mismatch",
      exitCode: result.exitCode,
      filteredLineCount: 0,
      diagnostics: [],
      truncated: false,
      countsByCode: {},
    };
  }

  const limited = filtered.slice(0, 200);
  const text = limited.join("\n");
  const parsed = parseTscDiagnostics(text, 80);
  const fileDiagnostics = parsed.diagnostics.filter((diagnostic) => {
    try {
      return resolvePath(cwd, diagnostic.file) === resolvePath(cwd, filePath);
    } catch {
      return false;
    }
  });

  if (fileDiagnostics.length === 0) {
    return {
      text: "No matching diagnostics for the requested file/severity scope.",
      status: "unavailable",
      reason: "diagnostics_scope_mismatch",
      exitCode: result.exitCode,
      filteredLineCount: filtered.length,
      diagnostics: [],
      truncated: parsed.truncated || filtered.length > limited.length,
      countsByCode: {},
    };
  }

  const countsByCode: Record<string, number> = {};
  for (const diagnostic of fileDiagnostics) {
    countsByCode[diagnostic.code] = (countsByCode[diagnostic.code] ?? 0) + 1;
  }

  return {
    text,
    status: "ok",
    exitCode: result.exitCode,
    filteredLineCount: filtered.length,
    diagnostics: fileDiagnostics,
    truncated: parsed.truncated || filtered.length > limited.length,
    countsByCode,
  };
}
