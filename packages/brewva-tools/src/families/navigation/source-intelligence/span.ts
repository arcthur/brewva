import type { SourceSpan } from "./ir.js";

export function offsetToLineColumn(
  sourceText: string,
  offset: number,
): { line: number; column: number } {
  let line = 1;
  let column = 0;
  const limit = Math.max(0, Math.min(offset, sourceText.length));
  for (let index = 0; index < limit; index += 1) {
    if (sourceText.charCodeAt(index) === 10) {
      line += 1;
      column = 0;
    } else {
      column += 1;
    }
  }
  return { line, column };
}

export function lineStartOffsets(sourceText: string): readonly number[] {
  const offsets = [0];
  for (let index = 0; index < sourceText.length; index += 1) {
    if (sourceText.charCodeAt(index) === 10) {
      offsets.push(index + 1);
    }
  }
  return offsets;
}

export function buildSpan(sourceText: string, startByte: number, endByte: number): SourceSpan {
  const start = offsetToLineColumn(sourceText, startByte);
  const end = offsetToLineColumn(sourceText, endByte);
  return {
    startByte,
    endByte,
    startLine: start.line,
    startColumn: start.column,
    endLine: end.line,
    endColumn: end.column,
  };
}

export function lineSpan(
  sourceText: string,
  offsets: readonly number[],
  lineIndex: number,
  matchStart: number,
  matchEnd: number,
): SourceSpan {
  const lineStart = offsets[lineIndex] ?? 0;
  return buildSpan(sourceText, lineStart + matchStart, lineStart + matchEnd);
}
