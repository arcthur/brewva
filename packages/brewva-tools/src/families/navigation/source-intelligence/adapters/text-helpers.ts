import type {
  SourceCall,
  SourceDeclaration,
  SourceDeclarationKind,
  SourceDiagnostic,
  SourceDocument,
  SourceImport,
  SourceImportKind,
  SourceLanguage,
  SourceSpan,
} from "../ir.js";
import { buildSpan, lineSpan, lineStartOffsets } from "../span.js";

export interface TextImportMatch {
  readonly rawSpecifier: string;
  readonly importedNames?: readonly string[];
  readonly exportedNames?: readonly string[];
  readonly kind: SourceImportKind;
  readonly lineIndex: number;
  readonly startColumn: number;
  readonly endColumn: number;
}

export interface TextDeclarationMatch {
  readonly name: string;
  readonly kind: SourceDeclarationKind;
  readonly exported?: boolean;
  readonly lineIndex: number;
  readonly startColumn: number;
  readonly endColumn: number;
  readonly endLineIndex?: number;
  readonly endLineColumn?: number;
  readonly signature?: string;
}

export interface TextCallMatch {
  readonly callee: string;
  readonly lineIndex: number;
  readonly startColumn: number;
  readonly endColumn: number;
  readonly confidence?: "exact" | "inferred" | "ambiguous";
  readonly enclosingDeclaration?: string;
}

export interface TextRangeNode {
  readonly text: string;
  readonly startIndex: number;
  readonly endIndex: number;
  readonly startPosition: {
    readonly row: number;
    readonly column: number;
  };
  readonly endPosition: {
    readonly row: number;
    readonly column: number;
  };
}

export interface TextExtractionResult {
  readonly imports: readonly TextImportMatch[];
  readonly declarations: readonly TextDeclarationMatch[];
  readonly calls: readonly TextCallMatch[];
  readonly diagnostics?: readonly SourceDiagnostic[];
}

export function createTextSourceDocument(input: {
  readonly filePath: string;
  readonly language: SourceLanguage;
  readonly sourceText: string;
  readonly sourceHash: string;
  readonly parserVersion: string;
  readonly grammarVersion: string;
  readonly extraction: TextExtractionResult;
}): SourceDocument {
  const offsets = lineStartOffsets(input.sourceText);
  const spanForLine = (lineIndex: number, start: number, end: number): SourceSpan =>
    lineSpan(input.sourceText, offsets, lineIndex, start, end);
  const spanForRange = (
    startLineIndex: number,
    startColumn: number,
    endLineIndex: number,
    endColumn: number,
  ): SourceSpan => {
    const startOffset = (offsets[startLineIndex] ?? 0) + startColumn;
    const endOffset = (offsets[endLineIndex] ?? offsets.at(-1) ?? 0) + endColumn;
    return buildSpan(input.sourceText, startOffset, endOffset);
  };

  const imports: SourceImport[] = input.extraction.imports.map((entry, index) => ({
    id: `${input.filePath}:import:${index}`,
    filePath: input.filePath,
    language: input.language,
    module: entry.rawSpecifier,
    rawSpecifier: entry.rawSpecifier,
    importedNames: entry.importedNames ?? [],
    exportedNames: entry.exportedNames,
    kind: entry.kind,
    span: spanForLine(entry.lineIndex, entry.startColumn, entry.endColumn),
  }));

  const declarations: SourceDeclaration[] = input.extraction.declarations.map((entry, index) => ({
    id: `${input.filePath}:decl:${entry.kind}:${entry.name}:${index}`,
    name: entry.name,
    kind: entry.kind,
    filePath: input.filePath,
    language: input.language,
    span: spanForRange(
      entry.lineIndex,
      entry.startColumn,
      entry.endLineIndex ?? entry.lineIndex,
      entry.endLineColumn ?? entry.endColumn,
    ),
    selectionSpan: spanForLine(entry.lineIndex, entry.startColumn, entry.endColumn),
    exported: entry.exported ?? false,
    signature: entry.signature,
  }));

  const calls: SourceCall[] = input.extraction.calls.map((entry, index) => ({
    id: `${input.filePath}:call:${entry.callee}:${index}`,
    filePath: input.filePath,
    language: input.language,
    name: entry.callee,
    callee: entry.callee,
    span: spanForLine(entry.lineIndex, entry.startColumn, entry.endColumn),
    enclosingDeclaration: entry.enclosingDeclaration,
    confidence: entry.confidence ?? "inferred",
  }));

  return {
    filePath: input.filePath,
    language: input.language,
    sourceHash: input.sourceHash,
    parserVersion: input.parserVersion,
    grammarVersion: input.grammarVersion,
    imports,
    declarations,
    calls,
    diagnostics: input.extraction.diagnostics ?? [],
    lineCount: Math.max(1, offsets.length),
  };
}

export function spanFromNodeLike(
  sourceText: string,
  value: { readonly start?: unknown; readonly end?: unknown },
): SourceSpan {
  const start = typeof value.start === "number" ? value.start : 0;
  const end = typeof value.end === "number" ? value.end : start;
  return buildSpan(sourceText, start, end);
}

export function splitImportedNames(input: string): readonly string[] {
  return input
    .split(",")
    .map((part) => part.trim().replace(/\s+as\s+\w+$/u, ""))
    .filter((part) => part === "*" || /^[A-Za-z_$][\w$]*$/u.test(part));
}

export function collectIdentifierCalls(
  sourceText: string,
  options: { readonly excluded?: ReadonlySet<string> } = {},
): readonly TextCallMatch[] {
  const excluded = options.excluded ?? new Set<string>();
  const calls: TextCallMatch[] = [];
  const lines = sourceText.split(/\r?\n/u);
  const pattern = /\b([A-Za-z_$][\w$]*)\s*\(/gu;
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex] ?? "";
    for (const match of line.matchAll(pattern)) {
      const callee = match[1] ?? "";
      if (!callee || excluded.has(callee)) {
        continue;
      }
      const startColumn = match.index ?? 0;
      calls.push({
        callee,
        lineIndex,
        startColumn,
        endColumn: startColumn + callee.length,
        confidence: "inferred",
      });
    }
  }
  return calls;
}

export function withDeclarationLineRanges(
  declarations: readonly TextDeclarationMatch[],
  lines: readonly string[],
): readonly TextDeclarationMatch[] {
  const sorted = [...declarations].toSorted((left, right) => {
    if (left.lineIndex !== right.lineIndex) return left.lineIndex - right.lineIndex;
    return left.startColumn - right.startColumn;
  });
  return sorted.map((declaration, index) => {
    const next = sorted[index + 1];
    const endLineIndex = next
      ? Math.max(declaration.lineIndex, next.lineIndex - 1)
      : Math.max(declaration.lineIndex, lines.length - 1);
    return {
      name: declaration.name,
      kind: declaration.kind,
      exported: declaration.exported,
      lineIndex: declaration.lineIndex,
      startColumn: declaration.startColumn,
      endColumn: declaration.endColumn,
      endLineIndex,
      endLineColumn: lines[endLineIndex]?.length ?? declaration.endColumn,
      signature: declaration.signature,
    };
  });
}

export function attachEnclosingDeclarationsToCalls<TCall extends TextCallMatch>(input: {
  readonly calls: readonly TCall[];
  readonly declarations: readonly TextDeclarationMatch[];
}): readonly TCall[] {
  return input.calls.flatMap((call) => {
    const owner = input.declarations.findLast((declaration) => {
      const endLineIndex = declaration.endLineIndex ?? declaration.lineIndex;
      if (call.lineIndex < declaration.lineIndex || call.lineIndex > endLineIndex) {
        return false;
      }
      if (
        call.lineIndex === declaration.lineIndex &&
        call.startColumn === declaration.startColumn &&
        call.endColumn === declaration.endColumn
      ) {
        return false;
      }
      return true;
    });
    return owner ? [{ ...call, enclosingDeclaration: owner.name }] : [call];
  });
}

export function attachEnclosingSourceDeclarationsToCalls(input: {
  readonly calls: readonly SourceCall[];
  readonly declarations: readonly SourceDeclaration[];
}): readonly SourceCall[] {
  return input.calls.map((call) => {
    const owner = input.declarations
      .filter(
        (declaration) =>
          declaration.span.startByte <= call.span.startByte &&
          declaration.span.endByte >= call.span.endByte,
      )
      .toSorted(
        (left, right) =>
          left.span.endByte - left.span.startByte - (right.span.endByte - right.span.startByte),
      )[0];
    return owner ? { ...call, enclosingDeclaration: owner.name } : call;
  });
}

export function textRangeFromNode(
  node: TextRangeNode,
): Pick<
  TextDeclarationMatch,
  "lineIndex" | "startColumn" | "endColumn" | "endLineIndex" | "endLineColumn"
> {
  return {
    lineIndex: node.startPosition.row,
    startColumn: node.startPosition.column,
    endColumn:
      node.startPosition.row === node.endPosition.row
        ? node.endPosition.column
        : node.startPosition.column + node.text.length,
    endLineIndex: node.endPosition.row,
    endLineColumn: node.endPosition.column,
  };
}

export function unquoteTreeSitterString(value: string): string {
  return value
    .trim()
    .replace(/^["'<]+/u, "")
    .replace(/[>"']+$/u, "");
}
