import { eastAsianWidth } from "get-east-asian-width";

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const zeroWidthRegex =
  /^(?:\p{Default_Ignorable_Code_Point}|\p{Control}|\p{Mark}|\p{Surrogate})+$/u;
const leadingNonPrintingRegex =
  /^[\p{Default_Ignorable_Code_Point}\p{Control}\p{Format}\p{Mark}\p{Surrogate}]+/u;

function couldBeEmoji(segment: string): boolean {
  const cp = segment.codePointAt(0);
  if (cp === undefined) {
    return false;
  }
  return (
    (cp >= 0x1f000 && cp <= 0x1fbff) ||
    (cp >= 0x2300 && cp <= 0x23ff) ||
    (cp >= 0x2600 && cp <= 0x27bf) ||
    (cp >= 0x2b50 && cp <= 0x2b55) ||
    segment.includes("\uFE0F") ||
    segment.length > 2
  );
}

function extractAnsiCode(text: string, start: number): number {
  if (text[start] !== "\u001b") {
    return 0;
  }

  const next = text[start + 1];
  if (next === "[") {
    let index = start + 2;
    while (index < text.length) {
      const code = text.charCodeAt(index);
      if (code >= 0x40 && code <= 0x7e) {
        return index - start + 1;
      }
      index += 1;
    }
    return text.length - start;
  }

  if (next === "]" || next === "_") {
    let index = start + 2;
    while (index < text.length) {
      if (text[index] === "\u0007") {
        return index - start + 1;
      }
      if (text[index] === "\u001b" && text[index + 1] === "\\") {
        return index - start + 2;
      }
      index += 1;
    }
    return text.length - start;
  }

  return next ? 2 : 1;
}

function stripAnsi(text: string): string {
  let result = "";
  for (let index = 0; index < text.length; ) {
    const ansiLength = extractAnsiCode(text, index);
    if (ansiLength > 0) {
      index += ansiLength;
      continue;
    }
    result += text[index] ?? "";
    index += 1;
  }
  return result;
}

function normalizeVisibleText(text: string): string {
  return stripAnsi(text).replace(/\t/gu, "  ");
}

function graphemeWidth(segment: string): number {
  if (zeroWidthRegex.test(segment)) {
    return 0;
  }
  if (couldBeEmoji(segment)) {
    return 2;
  }

  const base = segment.replace(leadingNonPrintingRegex, "");
  const cp = base.codePointAt(0);
  if (cp === undefined) {
    return 0;
  }
  if (cp >= 0x1f1e6 && cp <= 0x1f1ff) {
    return 2;
  }

  let width = eastAsianWidth(cp);
  if (segment.length > 1) {
    for (const char of segment.slice(1)) {
      const trailing = char.codePointAt(0);
      if (trailing !== undefined && trailing >= 0xff00 && trailing <= 0xffef) {
        width += eastAsianWidth(trailing);
      }
    }
  }
  return width;
}

export function visibleWidth(text: string): number {
  if (text.length === 0) {
    return 0;
  }
  let width = 0;
  for (const { segment } of segmenter.segment(normalizeVisibleText(text))) {
    width += graphemeWidth(segment);
  }
  return width;
}

/**
 * Convert a display-column position within a single line of text to a
 * JavaScript UTF-16 string offset. OpenTUI's logicalCursor.col is measured
 * in terminal display columns (wide/CJK characters count as 2), so this
 * function is required to map it back to a JS string index.
 */
export function visualColumnToTextOffset(line: string, visualCol: number): number {
  if (visualCol <= 0 || line.length === 0) {
    return 0;
  }
  let col = 0;
  let offset = 0;
  for (const { segment } of segmenter.segment(line)) {
    const w = graphemeWidth(segment);
    if (col + w > visualCol) {
      break;
    }
    col += w;
    offset += segment.length;
  }
  return offset;
}

export function truncateToWidth(text: string, maxWidth: number): string {
  if (maxWidth <= 0 || text.length === 0) {
    return "";
  }
  let result = "";
  let width = 0;
  for (const { segment } of segmenter.segment(normalizeVisibleText(text))) {
    const segmentWidth = graphemeWidth(segment);
    if (width + segmentWidth > maxWidth) {
      break;
    }
    result += segment;
    width += segmentWidth;
  }
  return result;
}

export function wrapTextToLines(text: string, width: number): string[] {
  const boundedWidth = Math.max(1, Math.trunc(width));
  const normalized = normalizeVisibleText(text);
  if (normalized.length === 0) {
    return [""];
  }

  const lines: string[] = [];
  for (const rawLine of normalized.split("\n")) {
    if (rawLine.length === 0) {
      lines.push("");
      continue;
    }
    let currentLine = "";
    let currentWidth = 0;
    for (const { segment } of segmenter.segment(rawLine)) {
      const segmentWidth = graphemeWidth(segment);
      if (currentWidth > 0 && currentWidth + segmentWidth > boundedWidth) {
        lines.push(currentLine);
        currentLine = "";
        currentWidth = 0;
      }
      if (segmentWidth > boundedWidth && currentWidth === 0) {
        lines.push(segment);
        continue;
      }
      currentLine += segment;
      currentWidth += segmentWidth;
    }
    lines.push(currentLine);
  }

  return lines.length > 0 ? lines : [""];
}

export function padToWidth(text: string, width: number): string {
  const boundedWidth = Math.max(0, Math.trunc(width));
  const clipped = truncateToWidth(text, boundedWidth);
  const padding = Math.max(0, boundedWidth - visibleWidth(clipped));
  return clipped + " ".repeat(padding);
}
