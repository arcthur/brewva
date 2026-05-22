import type { SourceDeclarationKind, SourceImportKind } from "../ir.js";
import {
  textRangeFromNode,
  unquoteTreeSitterString,
  type TextCallMatch,
  type TextDeclarationMatch,
  type TextImportMatch,
  type TextRangeNode,
} from "./text-helpers.js";
import type { TreeSitterQueryMatchSnapshot } from "./tree-sitter-runtime.js";

export function captureNode(
  match: TreeSitterQueryMatchSnapshot,
  name: string,
): TextRangeNode | null {
  return match.captures.find((capture) => capture.name === name)?.node ?? null;
}

export function captureText(match: TreeSitterQueryMatchSnapshot, name: string): string | null {
  return captureNode(match, name)?.text ?? null;
}

export function declarationFromMatch(input: {
  readonly match: TreeSitterQueryMatchSnapshot;
  readonly declarationCapture: string;
  readonly nameCapture: string;
  readonly kind: SourceDeclarationKind;
  readonly exported: boolean;
}): TextDeclarationMatch | null {
  const declarationNode = captureNode(input.match, input.declarationCapture);
  const nameNode = captureNode(input.match, input.nameCapture);
  if (!declarationNode || !nameNode) return null;
  const name = nameNode.text.trim();
  if (name.length === 0) return null;
  return {
    name,
    kind: input.kind,
    exported: input.exported,
    ...textRangeFromNode(nameNode),
    endLineIndex: declarationNode.endPosition.row,
    endLineColumn: declarationNode.endPosition.column,
    signature: declarationNode.text.split(/\r?\n/u)[0]?.trim(),
  };
}

export function importFromMatch(input: {
  readonly match: TreeSitterQueryMatchSnapshot;
  readonly importCapture: string;
  readonly specifierCapture: string;
  readonly kind: SourceImportKind;
  readonly rawSpecifier?: string;
  readonly importedNames?: readonly string[];
  readonly exportedNames?: readonly string[];
}): TextImportMatch | null {
  const importNode = captureNode(input.match, input.importCapture);
  const specifierNode = captureNode(input.match, input.specifierCapture);
  if (!importNode || !specifierNode) return null;
  const rawSpecifier = input.rawSpecifier ?? unquoteTreeSitterString(specifierNode.text);
  if (rawSpecifier.length === 0) return null;
  return {
    rawSpecifier,
    importedNames: input.importedNames ?? [],
    exportedNames: input.exportedNames,
    kind: input.kind,
    lineIndex: importNode.startPosition.row,
    startColumn: importNode.startPosition.column,
    endColumn:
      importNode.startPosition.row === importNode.endPosition.row
        ? importNode.endPosition.column
        : importNode.startPosition.column + importNode.text.length,
  };
}

export function callFromMatch(input: {
  readonly match: TreeSitterQueryMatchSnapshot;
  readonly nameCapture: string;
}): TextCallMatch | null {
  const nameNode = captureNode(input.match, input.nameCapture);
  if (!nameNode) return null;
  const callee = nameNode.text.trim();
  if (callee.length === 0) return null;
  return {
    callee,
    lineIndex: nameNode.startPosition.row,
    startColumn: nameNode.startPosition.column,
    endColumn: nameNode.endPosition.column,
    confidence: "inferred",
  };
}

export function uniqueTextMatches<
  T extends {
    readonly lineIndex: number;
    readonly startColumn: number;
    readonly endColumn: number;
  },
>(entries: readonly T[]): readonly T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const entry of entries) {
    const key = `${entry.lineIndex}:${entry.startColumn}:${entry.endColumn}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out;
}
