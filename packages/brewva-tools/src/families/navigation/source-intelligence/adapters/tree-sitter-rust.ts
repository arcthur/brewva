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

const RUST_EXCLUDED_CALLS = new Set(["if", "for", "while", "loop", "match", "return", "fn"]);
const RUST_QUERY = `
(use_declaration argument: (_) @import.path) @import
(function_item name: (identifier) @function.name) @function
(struct_item name: (type_identifier) @struct.name) @struct
(enum_item name: (type_identifier) @enum.name) @enum
(trait_item name: (type_identifier) @trait.name) @trait
(call_expression function: (identifier) @call.name) @call
(call_expression function: (scoped_identifier name: (identifier) @call.name)) @call
`;

function extractRustWithRegex(sourceText: string): {
  readonly imports: readonly TextImportMatch[];
  readonly declarations: readonly TextDeclarationMatch[];
} {
  const imports: TextImportMatch[] = [];
  const declarations: TextDeclarationMatch[] = [];
  const lines = sourceText.split(/\r?\n/u);

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex] ?? "";
    const useMatch = /^\s*(?:pub\s+)?use\s+([^;]+);/u.exec(line);
    if (useMatch) {
      const rawSpecifier = (useMatch[1] ?? "").trim();
      imports.push({
        rawSpecifier,
        importedNames: [],
        kind: "use",
        lineIndex,
        startColumn: line.indexOf(rawSpecifier),
        endColumn: line.indexOf(rawSpecifier) + rawSpecifier.length,
      });
      continue;
    }
    const fnMatch = /^\s*(pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)\s*\(/u.exec(line);
    if (fnMatch) {
      const name = fnMatch[2] ?? "";
      declarations.push({
        name,
        kind: "function",
        exported: Boolean(fnMatch[1]),
        lineIndex,
        startColumn: line.indexOf(name),
        endColumn: line.indexOf(name) + name.length,
        signature: line.trim(),
      });
      continue;
    }
    const typeMatch = /^\s*(pub\s+)?(struct|enum|trait)\s+([A-Za-z_]\w*)/u.exec(line);
    if (typeMatch) {
      const name = typeMatch[3] ?? "";
      const kind =
        typeMatch[2] === "struct" ? "struct" : typeMatch[2] === "trait" ? "trait" : "enum";
      declarations.push({
        name,
        kind,
        exported: Boolean(typeMatch[1]),
        lineIndex,
        startColumn: line.indexOf(name),
        endColumn: line.indexOf(name) + name.length,
        signature: line.trim(),
      });
    }
  }
  return { imports, declarations };
}

async function extractRust(input: SourceParseInput): Promise<SourceDocument> {
  const parsed = await parseTreeSitterSource({
    language: "rust",
    sourceText: input.sourceText,
    query: RUST_QUERY,
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
            kind: "use",
          }),
        )
        .filter((entry): entry is TextImportMatch => Boolean(entry)),
    );
    declarations = uniqueTextMatches(
      parsed.matches.flatMap((match) => {
        const declaration =
          captureText(match, "function.name") !== null
            ? declarationFromMatch({
                match,
                declarationCapture: "function",
                nameCapture: "function.name",
                kind: "function",
                exported: /^pub\b/u.test(captureText(match, "function") ?? ""),
              })
            : captureText(match, "struct.name") !== null
              ? declarationFromMatch({
                  match,
                  declarationCapture: "struct",
                  nameCapture: "struct.name",
                  kind: "struct",
                  exported: /^pub\b/u.test(captureText(match, "struct") ?? ""),
                })
              : captureText(match, "enum.name") !== null
                ? declarationFromMatch({
                    match,
                    declarationCapture: "enum",
                    nameCapture: "enum.name",
                    kind: "enum",
                    exported: /^pub\b/u.test(captureText(match, "enum") ?? ""),
                  })
                : captureText(match, "trait.name") !== null
                  ? declarationFromMatch({
                      match,
                      declarationCapture: "trait",
                      nameCapture: "trait.name",
                      kind: "trait",
                      exported: /^pub\b/u.test(captureText(match, "trait") ?? ""),
                    })
                  : null;
        return declaration ? [declaration] : [];
      }),
    );
  } else {
    const fallback = extractRustWithRegex(input.sourceText);
    imports = fallback.imports;
    declarations = fallback.declarations;
    diagnostics.push({
      severity: "warning",
      message: "Tree-sitter unavailable; using degraded regex extraction for rust.",
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
      : collectIdentifierCalls(input.sourceText, { excluded: RUST_EXCLUDED_CALLS }),
    declarations: rangedDeclarations,
  });

  return createTextSourceDocument({
    filePath: input.filePath,
    language: "rust",
    sourceText: input.sourceText,
    sourceHash: input.sourceHash,
    parserVersion: SOURCE_INTELLIGENCE_PARSER_VERSION,
    grammarVersion: getTreeSitterGrammarVersion("rust"),
    extraction: {
      imports,
      declarations: rangedDeclarations,
      calls,
      diagnostics,
    },
  });
}

export const treeSitterRustAdapter: SourceParserAdapter = {
  language: "rust",
  parserVersion: SOURCE_INTELLIGENCE_PARSER_VERSION,
  grammarVersion: getTreeSitterGrammarVersion("rust"),
  parse: extractRust,
};
