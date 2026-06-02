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

function isWorkbenchContinuityLine(line: string): boolean {
  return (
    line.startsWith("custom(workbench):") ||
    line.startsWith("branchSummary:") ||
    line.startsWith("compactionSummary:") ||
    /\[Workbench\]/u.test(line)
  );
}

function selectEmergencySummaryLines(summarized: readonly string[], maxLines: number): string[] {
  const selected: string[] = [];
  const seen = new Set<string>();
  const continuity = summarized.toReversed().find(isWorkbenchContinuityLine);
  if (continuity) {
    selected.push(continuity);
    seen.add(continuity);
  }
  for (const line of summarized.toReversed()) {
    if (selected.length >= maxLines) {
      break;
    }
    if (seen.has(line)) {
      continue;
    }
    selected.push(line);
    seen.add(line);
  }
  return selected.toReversed();
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
  const selected = selectEmergencySummaryLines(summarized, maxLines).map((line) =>
    trimCompactionSummaryLine(line, maxLineChars),
  );
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
