import { formatTaskVerificationLevelForSurface } from "../task/surface.js";
import type { ToolFailureEntry } from "./tool-failures.js";

export interface VerificationOutcomeSnapshot {
  timestamp: number;
  level?: string;
  outcome?: string;
  failedChecks?: string[];
  missingChecks?: string[];
  missingEvidence?: string[];
  reason?: string | null;
  commandsFresh?: string[];
  commandsStale?: string[];
}

export interface BuildRuntimeStatusBlockOptions {
  maxFailureEntries?: number;
  maxOutputChars?: number;
  maxArgsChars?: number;
}

const DEFAULT_MAX_FAILURE_ENTRIES = 3;
const DEFAULT_MAX_OUTPUT_CHARS = 240;
const DEFAULT_MAX_ARGS_CHARS = 140;

export function buildRuntimeStatusBlock(input: {
  verification?: VerificationOutcomeSnapshot;
  failures: ToolFailureEntry[];
  options?: BuildRuntimeStatusBlockOptions;
}): string {
  const verification = input.verification;
  const failures = input.failures;
  if (!verification && failures.length === 0) return "";

  const maxFailureEntries = Math.max(
    1,
    Math.floor(input.options?.maxFailureEntries ?? DEFAULT_MAX_FAILURE_ENTRIES),
  );
  const maxOutputChars = Math.max(
    32,
    Math.floor(input.options?.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS),
  );
  const maxArgsChars = Math.max(
    16,
    Math.floor(input.options?.maxArgsChars ?? DEFAULT_MAX_ARGS_CHARS),
  );

  const lines: string[] = ["[RuntimeStatus]"];

  if (verification) {
    const verificationLevel =
      formatTaskVerificationLevelForSurface(verification.level) ??
      normalizeToken(verification.level, "unknown");
    const summary = [
      `verification=${normalizeToken(verification.outcome, "unknown")}`,
      `level=${verificationLevel}`,
    ];
    if (verification.failedChecks && verification.failedChecks.length > 0) {
      summary.push(`failed=${joinList(verification.failedChecks, 4)}`);
    }
    if (verification.missingChecks && verification.missingChecks.length > 0) {
      summary.push(`missing=${joinList(verification.missingChecks, 4)}`);
    }
    if (verification.commandsFresh && verification.commandsFresh.length > 0) {
      summary.push(`fresh=${joinList(verification.commandsFresh, 4)}`);
    }
    if (verification.commandsStale && verification.commandsStale.length > 0) {
      summary.push(`stale=${joinList(verification.commandsStale, 4)}`);
    }
    lines.push(summary.join(" "));

    const reason = truncate(compactWhitespace(verification.reason ?? ""), 220);
    if (reason) {
      lines.push(`reason: ${reason}`);
    }
    if (verification.missingEvidence && verification.missingEvidence.length > 0) {
      lines.push(`missing_evidence: ${joinList(verification.missingEvidence, 6)}`);
    }
  }

  if (failures.length > 0) {
    const recentFailures = failures.slice(-maxFailureEntries);
    lines.push(`recent_failures=${recentFailures.length}`);
    for (const failure of recentFailures) {
      const toolName = normalizeToken(failure.toolName, "unknown");
      const turn = Number.isFinite(failure.turn) ? Math.max(0, Math.floor(failure.turn)) : 0;
      const argsSummary = summarizeArgs(failure.args, maxArgsChars);
      const failureClass = failure.failureClass ? ` class=${failure.failureClass}` : "";
      const output = truncate(compactWhitespace(failure.outputText), maxOutputChars) || "(none)";
      lines.push(
        `- tool=${toolName}${failureClass} turn=${turn} args=${argsSummary}`,
        `  output: ${output}`,
      );
    }
  }

  return lines.join("\n");
}

function joinList(values: string[], maxItems: number): string {
  return values
    .map((value) => normalizeToken(value, "unknown"))
    .filter(Boolean)
    .slice(0, maxItems)
    .join(",");
}

function summarizeArgs(args: Record<string, unknown>, maxChars: number): string {
  try {
    return truncate(compactWhitespace(JSON.stringify(args)), maxChars) || "(none)";
  } catch {
    return "(none)";
  }
}

function compactWhitespace(value: string): string {
  return value.replaceAll(/\s+/g, " ").trim();
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const keep = Math.max(1, maxChars - 3);
  return `${value.slice(0, keep)}...`;
}

function normalizeToken(value: string | undefined | null, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : fallback;
}
