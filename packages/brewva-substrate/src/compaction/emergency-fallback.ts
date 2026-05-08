import {
  BREWVA_COMPACTION_DEFAULT_LINE,
  BREWVA_EMERGENCY_COMPACTION_SUMMARY_HEADER,
} from "./constants.js";
import { summarizeBrewvaCompactionMessage } from "./transcript-format.js";

export interface BrewvaCompactionSummaryOptions {
  maxLines?: number;
  maxLineChars?: number;
}

const DEFAULT_SUMMARY_MAX_LINES = 8;
const DEFAULT_SUMMARY_MAX_CHARS = 220;

function trimCompactionSummaryLine(line: string, maxLineChars: number): string {
  if (line.length <= maxLineChars) {
    return line;
  }
  return `${line.slice(0, maxLineChars - 1).trimEnd()}…`;
}

export function buildBrewvaDeterministicCompactionSummary(
  messages: readonly unknown[],
  options: BrewvaCompactionSummaryOptions = {},
): string {
  const maxLines = Math.max(1, Math.trunc(options.maxLines ?? DEFAULT_SUMMARY_MAX_LINES));
  const maxLineChars = Math.max(16, Math.trunc(options.maxLineChars ?? DEFAULT_SUMMARY_MAX_CHARS));
  const summarized = messages
    .map((message) => summarizeBrewvaCompactionMessage(message))
    .filter((line): line is string => typeof line === "string" && line.length > 0);
  const selected = summarized
    .slice(-maxLines)
    .map((line) => trimCompactionSummaryLine(line, maxLineChars));
  const lines = [BREWVA_EMERGENCY_COMPACTION_SUMMARY_HEADER];

  if (selected.length === 0) {
    lines.push(BREWVA_COMPACTION_DEFAULT_LINE);
  } else {
    for (const line of selected) {
      lines.push(`- ${line}`);
    }
  }
  return lines.join("\n");
}
