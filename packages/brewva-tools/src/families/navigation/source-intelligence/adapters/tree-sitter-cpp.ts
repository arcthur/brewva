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

const CPP_EXCLUDED_CALLS = new Set(["if", "for", "while", "switch", "return", "sizeof"]);
const CPP_QUERY = `
(preproc_include path: (_) @import.path) @import
(class_specifier name: (type_identifier) @class.name) @class
(struct_specifier name: (type_identifier) @struct.name) @struct
(enum_specifier name: (type_identifier) @enum.name) @enum
(function_definition declarator: (function_declarator declarator: (identifier) @function.name)) @function
(call_expression function: (identifier) @call.name) @call
`;

function extractCppWithRegex(sourceText: string): {
  readonly imports: readonly TextImportMatch[];
  readonly declarations: readonly TextDeclarationMatch[];
} {
  const imports: TextImportMatch[] = [];
  const declarations: TextDeclarationMatch[] = [];
  const lines = sourceText.split(/\r?\n/u);

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex] ?? "";
    const includeMatch = /^\s*#\s*include\s+[<"]([^>"]+)[>"]/u.exec(line);
    if (includeMatch) {
      const rawSpecifier = includeMatch[1] ?? "";
      imports.push({
        rawSpecifier,
        importedNames: [],
        kind: "include",
        lineIndex,
        startColumn: line.indexOf(rawSpecifier),
        endColumn: line.indexOf(rawSpecifier) + rawSpecifier.length,
      });
      continue;
    }
    const typeMatch = /^\s*(class|struct|enum)\s+([A-Za-z_]\w*)/u.exec(line);
    if (typeMatch) {
      const name = typeMatch[2] ?? "";
      declarations.push({
        name,
        kind: typeMatch[1] === "struct" ? "struct" : typeMatch[1] === "enum" ? "enum" : "class",
        exported: true,
        lineIndex,
        startColumn: line.indexOf(name),
        endColumn: line.indexOf(name) + name.length,
        signature: line.trim(),
      });
      continue;
    }
    const functionMatch =
      /^\s*(?:template\s*<[^>]+>\s*)?(?:[\w:<>~*&]+\s+)+([A-Za-z_]\w*)\s*\([^;]*\)\s*(?:const\s*)?(?:\{|;)/u.exec(
        line,
      );
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
    }
  }
  return { imports, declarations };
}

async function extractCpp(input: SourceParseInput): Promise<SourceDocument> {
  const parsed = await parseTreeSitterSource({
    language: "cpp",
    sourceText: input.sourceText,
    query: CPP_QUERY,
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
            kind: "include",
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
                exported: true,
              })
            : captureText(match, "struct.name") !== null
              ? declarationFromMatch({
                  match,
                  declarationCapture: "struct",
                  nameCapture: "struct.name",
                  kind: "struct",
                  exported: true,
                })
              : captureText(match, "enum.name") !== null
                ? declarationFromMatch({
                    match,
                    declarationCapture: "enum",
                    nameCapture: "enum.name",
                    kind: "enum",
                    exported: true,
                  })
                : captureText(match, "function.name") !== null
                  ? declarationFromMatch({
                      match,
                      declarationCapture: "function",
                      nameCapture: "function.name",
                      kind: "function",
                      exported: true,
                    })
                  : null;
        return declaration ? [declaration] : [];
      }),
    );
  } else {
    const fallback = extractCppWithRegex(input.sourceText);
    imports = fallback.imports;
    declarations = fallback.declarations;
    diagnostics.push({
      severity: "warning",
      message: "Tree-sitter unavailable; using degraded regex extraction for cpp.",
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
      : collectIdentifierCalls(input.sourceText, { excluded: CPP_EXCLUDED_CALLS }),
    declarations: rangedDeclarations,
  });

  return createTextSourceDocument({
    filePath: input.filePath,
    language: "cpp",
    sourceText: input.sourceText,
    sourceHash: input.sourceHash,
    parserVersion: SOURCE_INTELLIGENCE_PARSER_VERSION,
    grammarVersion: getTreeSitterGrammarVersion("cpp"),
    extraction: {
      imports,
      declarations: rangedDeclarations,
      calls,
      diagnostics,
    },
  });
}

export const treeSitterCppAdapter: SourceParserAdapter = {
  language: "cpp",
  parserVersion: SOURCE_INTELLIGENCE_PARSER_VERSION,
  grammarVersion: getTreeSitterGrammarVersion("cpp"),
  parse: extractCpp,
};
