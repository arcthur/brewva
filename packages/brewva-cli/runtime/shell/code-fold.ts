/**
 * Pure line-fold for code payloads (Pillar 2 of the streaming-transcript legibility
 * work): assistant fenced code, whole-file `Write` echoes, and diffs were the only
 * uncapped payloads while tool output was already capped. This brings them under one
 * information-density-first fold — long code collapses to `limit` lines with an
 * explicit hidden-line count, and expands on demand.
 *
 * Pure string-in / value-out so it is unit-testable without a renderer. The caller
 * owns the `expanded` signal (persisted per tool call) and the `limit` constant.
 */
export interface CollapsedCode {
  /** The content to render now — full text when not collapsible or expanded, else the first `limit` lines. */
  readonly visibleContent: string;
  /** True when the content exceeds `limit` and can therefore be toggled. */
  readonly collapsible: boolean;
  /** Lines hidden by the current fold (0 when expanded or not collapsible). */
  readonly hiddenLineCount: number;
  /** Total line count of the full content. */
  readonly totalLineCount: number;
}

/**
 * Cap a single line's width so one very long line (e.g. a minified/data file
 * written to disk) cannot flood the collapsed preview or stall the highlighter.
 * Applied only to collapsed lines — expanding restores the untruncated text.
 */
export function capLineWidth(line: string, maxLineWidth: number | undefined): string {
  return maxLineWidth !== undefined && line.length > maxLineWidth
    ? `${line.slice(0, maxLineWidth)}…`
    : line;
}

export function collapseCodeContent(input: {
  readonly content: string;
  readonly limit: number;
  readonly expanded: boolean;
  /** When set, each collapsed line is truncated to this many characters. */
  readonly maxLineWidth?: number;
}): CollapsedCode {
  const lines = input.content.split(/\r?\n/u);
  const totalLineCount = lines.length;
  // Collapsible on line COUNT or line WIDTH: a single 200KB minified/generated line
  // has totalLineCount 1 but must still fold, or it floods the view and stalls the
  // highlighter — the very "giant payload" this fold exists to bound.
  const overWide =
    input.maxLineWidth !== undefined && lines.some((line) => line.length > input.maxLineWidth!);
  const collapsible = totalLineCount > input.limit || overWide;

  if (!collapsible || input.expanded) {
    return { visibleContent: input.content, collapsible, hiddenLineCount: 0, totalLineCount };
  }

  const visible = lines.slice(0, input.limit).map((line) => capLineWidth(line, input.maxLineWidth));
  return {
    visibleContent: visible.join("\n"),
    collapsible: true,
    hiddenLineCount: totalLineCount - visible.length,
    totalLineCount,
  };
}

/**
 * A segment of committed assistant text: normal `markdown` prose, or a long
 * `code` block lifted out to be rendered folded.
 */
export type TranscriptTextSegment =
  | { readonly kind: "markdown"; readonly content: string }
  | { readonly kind: "code"; readonly content: string; readonly lang: string | undefined };

// A fence that opens a foldable block: TOP-LEVEL only (no leading indent), then
// ``` or ~~~ (3+), then an optional info string (which cannot start with a
// backtick/tilde/space). Indented fences (e.g. inside a list item) are deliberately
// left to the markdown renderer, so lifting a code block never tears a list apart.
const OPEN_FENCE = /^(`{3,}|~{3,})[ \t]*([^\s`~][^\n]*)?$/u;

// A fence that closes a block: same run character, length >= the opener, no info.
function isClosingFence(line: string, openMarker: string): boolean {
  const match = /^ {0,3}(`{3,}|~{3,})[ \t]*$/u.exec(line);
  if (!match) return false;
  const marker = match[1]!;
  return marker[0] === openMarker[0] && marker.length >= openMarker.length;
}

/**
 * Split committed assistant text into markdown and foldable-code segments. Only a
 * *closed* fenced code block whose body has at least `minFoldLines` lines becomes a
 * `code` segment (rendered folded); everything else — prose plus short or unclosed
 * fences — stays in `markdown` segments rendered by the normal markdown renderer.
 * Prose on either side of a long code block is split into separate markdown
 * segments; that separation is inherent to lifting the code out.
 *
 * Never used mid-stream: the caller only splits once `renderMode` is stable, so a
 * still-being-written unterminated fence is never mis-folded.
 */
export function splitFoldableCodeBlocks(
  content: string,
  minFoldLines: number,
): TranscriptTextSegment[] {
  const lines = content.split(/\r?\n/u);
  const segments: TranscriptTextSegment[] = [];
  let markdownBuffer: string[] = [];

  const flushMarkdown = () => {
    if (markdownBuffer.length === 0) return;
    const text = markdownBuffer.join("\n").trim();
    if (text.length > 0) {
      segments.push({ kind: "markdown", content: text });
    }
    markdownBuffer = [];
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const open = OPEN_FENCE.exec(line);
    if (open) {
      const marker = open[1]!;
      const lang = open[2]?.trim().split(/\s+/u)[0] || undefined;
      let close = i + 1;
      while (close < lines.length && !isClosingFence(lines[close]!, marker)) {
        close += 1;
      }
      const closed = close < lines.length;
      const bodyLineCount = closed ? close - (i + 1) : 0;
      if (closed && bodyLineCount >= minFoldLines) {
        flushMarkdown();
        segments.push({ kind: "code", content: lines.slice(i + 1, close).join("\n"), lang });
        i = close + 1;
        continue;
      }
      // Short or unclosed fence: keep it verbatim in the markdown buffer so the
      // markdown renderer handles it exactly as before.
      const end = closed ? close : lines.length - 1;
      for (let k = i; k <= end; k += 1) {
        markdownBuffer.push(lines[k]!);
      }
      i = end + 1;
      continue;
    }
    markdownBuffer.push(line);
    i += 1;
  }
  flushMarkdown();

  return segments;
}
