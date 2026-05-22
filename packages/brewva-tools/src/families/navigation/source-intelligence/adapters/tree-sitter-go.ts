import { SOURCE_INTELLIGENCE_PARSER_VERSION } from "../cache.js";
import type { SourceDocument } from "../ir.js";
import {
  attachEnclosingDeclarationsToCalls,
  collectIdentifierCalls,
  createTextSourceDocument,
  withDeclarationLineRanges,
  type TextCallMatch,
  type TextDeclarationMatch,
  type TextImportMatch,
} from "./text-helpers.js";
import {
  callFromMatch,
  captureText,
  declarationFromMatch,
  importFromMatch,
  uniqueTextMatches,
} from "./tree-sitter-query-helpers.js";
import { getTreeSitterGrammarVersion, parseTreeSitterSource } from "./tree-sitter-runtime.js";
import type { SourceParseInput, SourceParserAdapter } from "./types.js";

const GO_EXCLUDED_CALLS = new Set([
  "defer",
  "for",
  "func",
  "go",
  "if",
  "return",
  "select",
  "switch",
]);
const GO_QUERY = `
(import_spec path: (_) @import.path) @import
(function_declaration name: (identifier) @function.name) @function
(method_declaration name: (field_identifier) @method.name) @method
(type_spec name: (type_identifier) @type.name type: (struct_type)) @struct
(type_spec name: (type_identifier) @type.name type: (interface_type)) @interface
(call_expression function: (identifier) @call.name) @call
(call_expression function: (selector_expression field: (field_identifier) @call.name)) @call
`;

function extractGoWithRegex(sourceText: string): {
  readonly imports: readonly TextImportMatch[];
  readonly declarations: readonly TextDeclarationMatch[];
} {
  const imports: TextImportMatch[] = [];
  const declarations: TextDeclarationMatch[] = [];
  const lines = sourceText.split(/\r?\n/u);
  let inImportBlock = false;

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex] ?? "";
    if (/^\s*import\s*\(\s*$/u.test(line)) {
      inImportBlock = true;
      continue;
    }
    if (inImportBlock && /^\s*\)\s*$/u.test(line)) {
      inImportBlock = false;
      continue;
    }
    const blockImport = inImportBlock ? /^\s*(?:(?:\w+|\.)\s+)?["']([^"']+)["']/u.exec(line) : null;
    const singleImport = /^\s*import\s+(?:(?:\w+|\.)\s+)?["']([^"']+)["']/u.exec(line);
    const importMatch = blockImport ?? singleImport;
    if (importMatch) {
      const rawSpecifier = importMatch[1] ?? "";
      imports.push({
        rawSpecifier,
        importedNames: [],
        kind: "import",
        lineIndex,
        startColumn: line.indexOf(rawSpecifier),
        endColumn: line.indexOf(rawSpecifier) + rawSpecifier.length,
      });
      continue;
    }
    const funcMatch = /^\s*func\s+(?:\([^)]+\)\s*)?([A-Za-z_]\w*)\s*\(/u.exec(line);
    if (funcMatch) {
      const name = funcMatch[1] ?? "";
      declarations.push({
        name,
        kind: "function",
        exported: /^[A-Z]/u.test(name),
        lineIndex,
        startColumn: line.indexOf(name),
        endColumn: line.indexOf(name) + name.length,
        signature: line.trim(),
      });
      continue;
    }
    const typeMatch = /^\s*type\s+([A-Za-z_]\w*)\s+(struct|interface)\b/u.exec(line);
    if (typeMatch) {
      const name = typeMatch[1] ?? "";
      declarations.push({
        name,
        kind: typeMatch[2] === "interface" ? "interface" : "struct",
        exported: /^[A-Z]/u.test(name),
        lineIndex,
        startColumn: line.indexOf(name),
        endColumn: line.indexOf(name) + name.length,
        signature: line.trim(),
      });
    }
  }
  return { imports, declarations };
}

async function extractGo(input: SourceParseInput): Promise<SourceDocument> {
  const parsed = await parseTreeSitterSource({
    language: "go",
    sourceText: input.sourceText,
    query: GO_QUERY,
  });
  const lines = input.sourceText.split(/\r?\n/u);
  const diagnostics = [...parsed.diagnostics];
  let imports: readonly TextImportMatch[];
  let declarations: readonly TextDeclarationMatch[];

  if (parsed.available) {
    imports = uniqueTextMatches(
      parsed.matches
        .map((match) =>
          importFromMatch({
            match,
            importCapture: "import",
            specifierCapture: "import.path",
            kind: "import",
          }),
        )
        .filter((entry): entry is TextImportMatch => Boolean(entry)),
    );
    declarations = uniqueTextMatches(
      parsed.matches.flatMap((match) => {
        if (captureText(match, "function.name")) {
          const name = captureText(match, "function.name") ?? "";
          return [
            declarationFromMatch({
              match,
              declarationCapture: "function",
              nameCapture: "function.name",
              kind: "function",
              exported: /^[A-Z]/u.test(name),
            }),
          ].filter((entry): entry is TextDeclarationMatch => Boolean(entry));
        }
        if (captureText(match, "method.name")) {
          const name = captureText(match, "method.name") ?? "";
          return [
            declarationFromMatch({
              match,
              declarationCapture: "method",
              nameCapture: "method.name",
              kind: "method",
              exported: /^[A-Z]/u.test(name),
            }),
          ].filter((entry): entry is TextDeclarationMatch => Boolean(entry));
        }
        if (captureText(match, "type.name")) {
          const name = captureText(match, "type.name") ?? "";
          return [
            declarationFromMatch({
              match,
              declarationCapture: captureText(match, "struct") ? "struct" : "interface",
              nameCapture: "type.name",
              kind: captureText(match, "struct") ? "struct" : "interface",
              exported: /^[A-Z]/u.test(name),
            }),
          ].filter((entry): entry is TextDeclarationMatch => Boolean(entry));
        }
        return [];
      }),
    );
  } else {
    const fallback = extractGoWithRegex(input.sourceText);
    imports = fallback.imports;
    declarations = fallback.declarations;
    diagnostics.push({
      severity: "warning",
      message: "Tree-sitter unavailable; using degraded regex extraction for go.",
      source: "source-intelligence",
    });
  }
  const rangedDeclarations = withDeclarationLineRanges(declarations, lines);
  const calls = attachEnclosingDeclarationsToCalls({
    calls: parsed.available
      ? uniqueTextMatches(
          parsed.matches
            .map((match) => callFromMatch({ match, nameCapture: "call.name" }))
            .filter((entry): entry is TextCallMatch => Boolean(entry)),
        )
      : collectIdentifierCalls(input.sourceText, { excluded: GO_EXCLUDED_CALLS }),
    declarations: rangedDeclarations,
  });

  return createTextSourceDocument({
    filePath: input.filePath,
    language: "go",
    sourceText: input.sourceText,
    sourceHash: input.sourceHash,
    parserVersion: SOURCE_INTELLIGENCE_PARSER_VERSION,
    grammarVersion: getTreeSitterGrammarVersion("go"),
    extraction: {
      imports,
      declarations: rangedDeclarations,
      calls,
      diagnostics,
    },
  });
}

export const treeSitterGoAdapter: SourceParserAdapter = {
  language: "go",
  parserVersion: SOURCE_INTELLIGENCE_PARSER_VERSION,
  grammarVersion: getTreeSitterGrammarVersion("go"),
  parse: extractGo,
};
