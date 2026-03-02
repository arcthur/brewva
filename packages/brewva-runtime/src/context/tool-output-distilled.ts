export interface ToolOutputDistillationEntry {
  toolName: string;
  strategy: string;
  summaryText: string;
  rawTokens: number | null;
  summaryTokens: number | null;
  compressionRatio: number | null;
  artifactRef?: string | null;
  isError: boolean;
  turn?: number;
  timestamp: number;
}

export interface BuildToolOutputDistillationBlockOptions {
  maxEntries?: number;
  maxSummaryChars?: number;
}

const DEFAULT_MAX_ENTRIES = 3;
const DEFAULT_MAX_SUMMARY_CHARS = 300;

function compactWhitespace(value: string): string {
  return value.replaceAll(/\s+/g, " ").trim();
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const keep = Math.max(1, maxChars - 3);
  return `${value.slice(0, keep)}...`;
}

function formatMetric(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "n/a";
  return String(Math.max(0, Math.floor(value)));
}

function formatCompression(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "n/a";
  const normalized = Math.max(0, Math.min(1, value));
  return normalized.toFixed(3);
}

export function buildRecentToolOutputDistillationBlock(
  entries: ToolOutputDistillationEntry[],
  options: BuildToolOutputDistillationBlockOptions = {},
): string {
  if (entries.length === 0) return "";

  const maxEntries = Math.max(1, Math.floor(options.maxEntries ?? DEFAULT_MAX_ENTRIES));
  const maxSummaryChars = Math.max(
    40,
    Math.floor(options.maxSummaryChars ?? DEFAULT_MAX_SUMMARY_CHARS),
  );
  const recent = entries.slice(-maxEntries);

  const lines: string[] = ["[RecentToolOutputsDistilled]"];
  for (const entry of recent) {
    const toolName = entry.toolName.trim() || "(unknown)";
    const status = entry.isError ? "error" : "ok";
    const strategy = entry.strategy.trim() || "unknown";
    const artifactRef =
      typeof entry.artifactRef === "string" && entry.artifactRef.trim().length > 0
        ? entry.artifactRef.trim()
        : "n/a";
    const turn = Number.isFinite(entry.turn) ? Math.max(0, Math.floor(entry.turn ?? 0)) : null;
    const summary = truncate(compactWhitespace(entry.summaryText), maxSummaryChars) || "(none)";

    lines.push(
      `- tool=${toolName} status=${status} strategy=${strategy} turn=${turn ?? "n/a"} raw_tokens=${formatMetric(entry.rawTokens)} summary_tokens=${formatMetric(entry.summaryTokens)} compression=${formatCompression(entry.compressionRatio)} artifact=${artifactRef}`,
      `  summary: ${summary}`,
    );
  }

  return lines.join("\n");
}
