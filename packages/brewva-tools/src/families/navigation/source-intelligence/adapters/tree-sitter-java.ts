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

const JAVA_EXCLUDED_CALLS = new Set(["if", "for", "while", "switch", "return", "new"]);
const JAVA_QUERY = `
(import_declaration (scoped_identifier) @import.path) @import
(class_declaration name: (identifier) @class.name) @class
(interface_declaration name: (identifier) @interface.name) @interface
(enum_declaration name: (identifier) @enum.name) @enum
(method_declaration name: (identifier) @method.name) @method
(method_invocation name: (identifier) @call.name) @call
`;

function extractJavaWithRegex(sourceText: string): {
  readonly imports: readonly TextImportMatch[];
  readonly declarations: readonly TextDeclarationMatch[];
} {
  const imports: TextImportMatch[] = [];
  const declarations: TextDeclarationMatch[] = [];
  const lines = sourceText.split(/\r?\n/u);

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex] ?? "";
    const importMatch = /^\s*import\s+(?:static\s+)?([A-Za-z_][\w.*]*)\s*;/u.exec(line);
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
    const typeMatch =
      /^\s*(public\s+)?(?:abstract\s+|final\s+)?(class|interface|enum)\s+([A-Za-z_]\w*)/u.exec(
        line,
      );
    if (typeMatch) {
      const name = typeMatch[3] ?? "";
      declarations.push({
        name,
        kind:
          typeMatch[2] === "class" ? "class" : typeMatch[2] === "interface" ? "interface" : "enum",
        exported: Boolean(typeMatch[1]),
        lineIndex,
        startColumn: line.indexOf(name),
        endColumn: line.indexOf(name) + name.length,
        signature: line.trim(),
      });
      continue;
    }
    const methodMatch =
      /^\s*(public|protected|private)?\s*(?:static\s+)?[\w<>,.?[\]\s]+\s+([A-Za-z_]\w*)\s*\(/u.exec(
        line,
      );
    if (methodMatch) {
      const name = methodMatch[2] ?? "";
      declarations.push({
        name,
        kind: "method",
        exported: methodMatch[1] === "public",
        lineIndex,
        startColumn: line.indexOf(name),
        endColumn: line.indexOf(name) + name.length,
        signature: line.trim(),
      });
    }
  }
  return { imports, declarations };
}

async function extractJava(input: SourceParseInput): Promise<SourceDocument> {
  const parsed = await parseTreeSitterSource({
    language: "java",
    sourceText: input.sourceText,
    query: JAVA_QUERY,
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
        const declaration =
          captureText(match, "class.name") !== null
            ? declarationFromMatch({
                match,
                declarationCapture: "class",
                nameCapture: "class.name",
                kind: "class",
                exported: /^public\b/u.test(captureText(match, "class") ?? ""),
              })
            : captureText(match, "interface.name") !== null
              ? declarationFromMatch({
                  match,
                  declarationCapture: "interface",
                  nameCapture: "interface.name",
                  kind: "interface",
                  exported: /^public\b/u.test(captureText(match, "interface") ?? ""),
                })
              : captureText(match, "enum.name") !== null
                ? declarationFromMatch({
                    match,
                    declarationCapture: "enum",
                    nameCapture: "enum.name",
                    kind: "enum",
                    exported: /^public\b/u.test(captureText(match, "enum") ?? ""),
                  })
                : captureText(match, "method.name") !== null
                  ? declarationFromMatch({
                      match,
                      declarationCapture: "method",
                      nameCapture: "method.name",
                      kind: "method",
                      exported: /^public\b/u.test(captureText(match, "method") ?? ""),
                    })
                  : null;
        return declaration ? [declaration] : [];
      }),
    );
  } else {
    const fallback = extractJavaWithRegex(input.sourceText);
    imports = fallback.imports;
    declarations = fallback.declarations;
    diagnostics.push({
      severity: "warning",
      message: "Tree-sitter unavailable; using degraded regex extraction for java.",
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
      : collectIdentifierCalls(input.sourceText, { excluded: JAVA_EXCLUDED_CALLS }),
    declarations: rangedDeclarations,
  });

  return createTextSourceDocument({
    filePath: input.filePath,
    language: "java",
    sourceText: input.sourceText,
    sourceHash: input.sourceHash,
    parserVersion: SOURCE_INTELLIGENCE_PARSER_VERSION,
    grammarVersion: getTreeSitterGrammarVersion("java"),
    extraction: {
      imports,
      declarations: rangedDeclarations,
      calls,
      diagnostics,
    },
  });
}

export const treeSitterJavaAdapter: SourceParserAdapter = {
  language: "java",
  parserVersion: SOURCE_INTELLIGENCE_PARSER_VERSION,
  grammarVersion: getTreeSitterGrammarVersion("java"),
  parse: extractJava,
};
