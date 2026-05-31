import type { BrewvaToolResult } from "@brewva/brewva-substrate/tools";

export type ExecPreflightSeverity = "block" | "advisory" | "executionHint";

export interface ExecPreflightFinding {
  severity: ExecPreflightSeverity;
  code: string;
  message: string;
  suggestedTool?: string;
}

export interface ExecPreflightReport {
  decision: "allow" | "block";
  findings: ExecPreflightFinding[];
}

const DIRECT_TOOL_COMMANDS = new Map<string, string>([
  ["source_read", "source_read"],
  ["source_patch_prepare", "source_patch_prepare"],
  ["source_patch_apply", "source_patch_apply"],
  ["resource_read", "resource_read"],
  ["process", "process"],
  ["lsp_status", "lsp_status"],
  ["lsp_hover", "lsp_hover"],
  ["lsp_definition", "lsp_definition"],
  ["lsp_references", "lsp_references"],
  ["lsp_rename", "lsp_rename"],
  ["worker_results_apply", "worker_results_apply"],
  ["workbench_compact", "workbench_compact"],
]);

const LONG_RUNNING_COMMANDS = new Set([
  "dev",
  "serve",
  "server",
  "start",
  "watch",
  "vite",
  "next",
  "webpack",
  "turbo",
]);

function firstShellToken(command: string, detectedCommands: readonly string[]): string | undefined {
  return detectedCommands[0] ?? command.match(/^\s*([^\s;&|]+)/u)?.[1];
}

function hasBroadSearchShape(command: string, token: string | undefined): boolean {
  if (token !== "rg" && token !== "grep") {
    return false;
  }
  return !/\s(-n|--line-number|-l|--files|-g|--glob|--json)\b/u.test(command);
}

function hasNoisyShape(command: string): boolean {
  return /\b(find\s+\.|ls\s+-R|git\s+log\b|git\s+diff\b|npm\s+test\b|bun\s+test\b)/u.test(command);
}

function hasLongRunningShape(command: string, token: string | undefined): boolean {
  if (token && LONG_RUNNING_COMMANDS.has(token)) {
    return true;
  }
  return /\b(--watch|watch|dev|serve|server|start)\b/u.test(command);
}

export function analyzeExecPreflight(input: {
  command: string;
  detectedCommands: readonly string[];
}): ExecPreflightReport {
  const findings: ExecPreflightFinding[] = [];
  const firstToken = firstShellToken(input.command, input.detectedCommands);
  const directToolName = firstToken ? DIRECT_TOOL_COMMANDS.get(firstToken) : undefined;
  if (directToolName) {
    findings.push({
      severity: "block",
      code: "shell_as_tool",
      suggestedTool: directToolName,
      message: `Command '${firstToken}' is a Brewva tool name. Call tool '${directToolName}' directly instead of using exec.`,
    });
  }
  if (firstToken === "cat") {
    findings.push({
      severity: "advisory",
      code: "prefer_source_read",
      suggestedTool: "source_read",
      message: "Use source_read for source files so the result includes snapshots and anchors.",
    });
  }
  if (hasBroadSearchShape(input.command, firstToken)) {
    findings.push({
      severity: "advisory",
      code: "prefer_scoped_search",
      suggestedTool: "grep",
      message: "Use grep for searchable output with per-file source anchors.",
    });
  }
  if (hasNoisyShape(input.command)) {
    findings.push({
      severity: "executionHint",
      code: "noisy_output_expected",
      message: "Command output may be minimized; raw output remains available through artifacts.",
    });
  }
  if (hasLongRunningShape(input.command, firstToken)) {
    findings.push({
      severity: "executionHint",
      code: "long_running_expected",
      suggestedTool: "process",
      message: "Long-running commands auto-background after the configured foreground wait.",
    });
  }
  return {
    decision: findings.some((finding) => finding.severity === "block") ? "block" : "allow",
    findings,
  };
}

export function preflightDetails(report: ExecPreflightReport): Record<string, unknown> | undefined {
  if (report.findings.length === 0) {
    return undefined;
  }
  return {
    decision: report.decision,
    findings: report.findings.map((finding) => ({ ...finding })),
  };
}

export function attachExecPreflightDetails<TDetails extends Record<string, unknown>>(
  result: BrewvaToolResult<TDetails, TDetails>,
  report: ExecPreflightReport,
): BrewvaToolResult<TDetails & { executionPreflight?: Record<string, unknown> }, TDetails> {
  const details = preflightDetails(report);
  if (!details) {
    return result as BrewvaToolResult<
      TDetails & { executionPreflight?: Record<string, unknown> },
      TDetails
    >;
  }
  if (result.outcome.kind !== "ok") {
    return result as BrewvaToolResult<
      TDetails & { executionPreflight?: Record<string, unknown> },
      TDetails
    >;
  }
  return {
    ...result,
    outcome: {
      kind: "ok",
      value: {
        ...result.outcome.value,
        executionPreflight: details,
      },
    },
  };
}
