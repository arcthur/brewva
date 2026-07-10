/**
 * One-line summary of a reasoning block, so committed thinking can collapse to a
 * title the reader can scan (Pillar 2 density-first, applied to reasoning — the
 * largest vertical consumer of a turn). Borrowed from opencode's `reasoningSummary`.
 *
 * Pure string-in / value-out so it is unit-testable without a renderer.
 */
export interface ReasoningSummary {
  /** A single scannable line (bold lead if present, else the first line, truncated). */
  readonly title: string;
  /** True when there is content beyond the title, i.e. collapsing actually hides something. */
  readonly hasMore: boolean;
}

const MAX_TITLE_WIDTH = 80;

function truncate(text: string): string {
  return text.length > MAX_TITLE_WIDTH ? `${text.slice(0, MAX_TITLE_WIDTH)}…` : text;
}

export function summarizeReasoning(text: string): ReasoningSummary {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return { title: "", hasMore: false };
  }

  // OpenAI-style "**Title**\n body": lift the leading bold line as the title.
  const bold = /^\*\*(.+?)\*\*\s*(?:\n|$)/u.exec(trimmed);
  if (bold?.[1]) {
    return { title: truncate(bold[1].trim()), hasMore: trimmed.length > bold[0].length };
  }

  // Otherwise the first line is the title (trimmed content starts non-empty);
  // anything after it is "more".
  const lines = trimmed.split(/\r?\n/u);
  const firstLine = lines[0]!.trim();
  const hasTrailingContent = lines.slice(1).some((line) => line.trim().length > 0);
  return {
    title: truncate(firstLine),
    hasMore: hasTrailingContent || firstLine.length > MAX_TITLE_WIDTH,
  };
}
