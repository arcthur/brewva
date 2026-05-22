import { SOURCE_INTELLIGENCE_PARSER_VERSION } from "../cache.js";
import type { SourceDocument } from "../ir.js";
import {
  attachEnclosingDeclarationsToCalls,
  collectIdentifierCalls,
  createTextSourceDocument,
  splitImportedNames,
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

const PYTHON_EXCLUDED_CALLS = new Set(["if", "for", "while", "return", "class", "def"]);
const PYTHON_QUERY = `
(import_statement name: (_) @import.specifier) @import
(import_from_statement module_name: (_) @from.module name: (_) @from.name) @from.import
(function_definition name: (identifier) @function.name) @function
(class_definition name: (identifier) @class.name) @class
(call function: (identifier) @call.name) @call
(call function: (attribute attribute: (identifier) @call.name)) @call
`;

function extractPythonWithRegex(sourceText: string): {
  readonly imports: readonly TextImportMatch[];
  readonly declarations: readonly TextDeclarationMatch[];
} {
  const imports: TextImportMatch[] = [];
  const declarations: TextDeclarationMatch[] = [];
  const lines = sourceText.split(/\r?\n/u);

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex] ?? "";
    const importMatch = /^\s*import\s+(.+)$/u.exec(line);
    if (importMatch) {
      const rawSpecifier = (importMatch[1] ?? "").split(",")[0]?.trim().split(/\s+/u)[0] ?? "";
      if (rawSpecifier) {
        imports.push({
          rawSpecifier,
          importedNames: splitImportedNames(importMatch[1] ?? ""),
          kind: "import",
          lineIndex,
          startColumn: line.indexOf("import"),
          endColumn: line.length,
        });
      }
      continue;
    }
    const fromImportMatch = /^\s*from\s+([A-Za-z_][\w.]*)\s+import\s+(.+)$/u.exec(line);
    if (fromImportMatch) {
      imports.push({
        rawSpecifier: fromImportMatch[1] ?? "",
        importedNames: splitImportedNames(fromImportMatch[2] ?? ""),
        kind: "from-import",
        lineIndex,
        startColumn: line.indexOf("from"),
        endColumn: line.length,
      });
      continue;
    }
    const functionMatch = /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/u.exec(line);
    if (functionMatch) {
      const name = functionMatch[1] ?? "";
      declarations.push({
        name,
        kind: "function",
        exported: true,
        lineIndex,
        startColumn: line.indexOf(name),
        endColumn: line.indexOf(name) + name.length,
        signature: line.trim(),
      });
      continue;
    }
    const classMatch = /^\s*class\s+([A-Za-z_]\w*)/u.exec(line);
    if (classMatch) {
      const name = classMatch[1] ?? "";
      declarations.push({
        name,
        kind: "class",
        exported: true,
        lineIndex,
        startColumn: line.indexOf(name),
        endColumn: line.indexOf(name) + name.length,
        signature: line.trim(),
      });
    }
  }
  return { imports, declarations };
}

async function extractPython(input: SourceParseInput): Promise<SourceDocument> {
  const parsed = await parseTreeSitterSource({
    language: "python",
    sourceText: input.sourceText,
    query: PYTHON_QUERY,
  });
  const lines = input.sourceText.split(/\r?\n/u);
  const diagnostics = [...parsed.diagnostics];
  let imports: readonly TextImportMatch[];
  let declarations: readonly TextDeclarationMatch[];

  if (parsed.available) {
    imports = uniqueTextMatches(
      parsed.matches.flatMap((match) => {
        if (captureText(match, "import.specifier")) {
          return [
            importFromMatch({
              match,
              importCapture: "import",
              specifierCapture: "import.specifier",
              kind: "import",
              importedNames: splitImportedNames(captureText(match, "import.specifier") ?? ""),
            }),
          ].filter((entry): entry is TextImportMatch => Boolean(entry));
        }
        const moduleName = captureText(match, "from.module");
        if (!moduleName) return [];
        return [
          importFromMatch({
            match,
            importCapture: "from.import",
            specifierCapture: "from.module",
            kind: "from-import",
            rawSpecifier: moduleName,
            importedNames: splitImportedNames(captureText(match, "from.name") ?? ""),
          }),
        ].filter((entry): entry is TextImportMatch => Boolean(entry));
      }),
    );
    declarations = uniqueTextMatches(
      parsed.matches.flatMap((match) => {
        if (captureText(match, "function.name")) {
          return [
            declarationFromMatch({
              match,
              declarationCapture: "function",
              nameCapture: "function.name",
              kind: "function",
              exported: true,
            }),
          ].filter((entry): entry is TextDeclarationMatch => Boolean(entry));
        }
        if (captureText(match, "class.name")) {
          return [
            declarationFromMatch({
              match,
              declarationCapture: "class",
              nameCapture: "class.name",
              kind: "class",
              exported: true,
            }),
          ].filter((entry): entry is TextDeclarationMatch => Boolean(entry));
        }
        return [];
      }),
    );
  } else {
    const fallback = extractPythonWithRegex(input.sourceText);
    imports = fallback.imports;
    declarations = fallback.declarations;
    diagnostics.push({
      severity: "warning",
      message: "Tree-sitter unavailable; using degraded regex extraction for python.",
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
      : collectIdentifierCalls(input.sourceText, { excluded: PYTHON_EXCLUDED_CALLS }),
    declarations: rangedDeclarations,
  });

  return createTextSourceDocument({
    filePath: input.filePath,
    language: "python",
    sourceText: input.sourceText,
    sourceHash: input.sourceHash,
    parserVersion: SOURCE_INTELLIGENCE_PARSER_VERSION,
    grammarVersion: getTreeSitterGrammarVersion("python"),
    extraction: {
      imports,
      declarations: rangedDeclarations,
      calls,
      diagnostics,
    },
  });
}

export const treeSitterPythonAdapter: SourceParserAdapter = {
  language: "python",
  parserVersion: SOURCE_INTELLIGENCE_PARSER_VERSION,
  grammarVersion: getTreeSitterGrammarVersion("python"),
  parse: extractPython,
};
