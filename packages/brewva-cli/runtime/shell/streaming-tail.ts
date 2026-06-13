/**
 * Bounded tail window for in-flight streaming text.
 *
 * OpenTUI re-measures and re-wraps a text block's full content on every
 * layout pass, so an unbounded in-flight response makes per-frame layout
 * cost grow with response length (RFC F8). Streaming previews therefore
 * render only a bounded tail; the full content renders through the
 * markdown path once the message stabilizes.
 *
 * The extraction is O(window + trailing whitespace), never O(content):
 * trailing whitespace is skipped from the end, the character cap is one
 * slice, lines are counted backwards only inside the capped window, and
 * leading whitespace is trimmed on the window alone. Callers must pass the
 * raw accumulated text — pre-trimming it would rescan the full content and
 * defeat the bound.
 */
export const STREAMING_TAIL_MAX_CHARS = 8_192;
export const STREAMING_TAIL_MAX_LINES = 200;

export interface StreamingTailWindow {
  readonly text: string;
  readonly truncated: boolean;
}

const NEWLINE = 10;

function isWhitespace(code: number): boolean {
  return code === 32 || (code >= 9 && code <= 13);
}

export function streamingTailWindow(
  content: string,
  limits: { maxChars?: number; maxLines?: number } = {},
): StreamingTailWindow {
  const maxChars = limits.maxChars ?? STREAMING_TAIL_MAX_CHARS;
  const maxLines = limits.maxLines ?? STREAMING_TAIL_MAX_LINES;

  let end = content.length;
  while (end > 0 && isWhitespace(content.charCodeAt(end - 1))) {
    end -= 1;
  }

  const charCapped = end > maxChars;
  let start = charCapped ? end - maxChars : 0;

  let lineCount = 0;
  let lineCapped = false;
  for (let index = end - 1; index >= start; index -= 1) {
    if (content.charCodeAt(index) !== NEWLINE) {
      continue;
    }
    lineCount += 1;
    if (lineCount >= maxLines) {
      start = index + 1;
      lineCapped = true;
      break;
    }
  }

  // A character-cap cut can land mid-line; advance to the next line
  // boundary so the visible tail never starts with a partial line. A
  // line-cap cut already starts right after a newline.
  if (charCapped && !lineCapped) {
    const firstNewline = content.indexOf("\n", start);
    if (firstNewline >= 0 && firstNewline < end - 1) {
      start = firstNewline + 1;
    }
  }

  while (start < end && isWhitespace(content.charCodeAt(start))) {
    start += 1;
  }

  return {
    text: content.slice(start, end),
    // Whitespace trimming is presentation, not truncation; only a cap cut
    // hides real content behind the "earlier lines" marker.
    truncated: charCapped || lineCapped,
  };
}
