import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type {
  Language as TreeSitterLanguage,
  Node as TreeSitterNode,
  QueryMatch,
} from "web-tree-sitter";
import grammarManifest from "../grammars/manifest.json" with { type: "json" };
import type { SourceDiagnostic, SourceLanguage } from "../ir.js";
import { buildSpan } from "../span.js";

export interface TreeSitterGrammarManifestEntry {
  readonly language: SourceLanguage;
  readonly npmPackage: string;
  readonly asset: string;
  readonly upstream: string;
  readonly commit: string;
  readonly license: string;
  readonly sha256: string;
  readonly grammarVersion: string;
}

const GRAMMAR_PACKAGE = grammarManifest.package;
const GRAMMAR_VERSION = `${grammarManifest.package}-${grammarManifest.version}`;
const GRAMMAR_MANIFEST = new Map<SourceLanguage, TreeSitterGrammarManifestEntry>(
  grammarManifest.grammars.map((entry) => [
    entry.language as SourceLanguage,
    {
      language: entry.language as SourceLanguage,
      npmPackage: GRAMMAR_PACKAGE,
      asset: entry.asset,
      upstream: entry.upstream,
      commit: entry.commit,
      license: entry.license,
      sha256: entry.sha256,
      grammarVersion: GRAMMAR_VERSION,
    },
  ]),
);

const require = createRequire(import.meta.url);
type WebTreeSitter = typeof import("web-tree-sitter");

let parserInitPromise: Promise<WebTreeSitter> | undefined;
const languagePromises = new Map<SourceLanguage, Promise<TreeSitterLanguage>>();

function resolveGrammarPackageRoot(): string | null {
  try {
    return dirname(require.resolve(`${GRAMMAR_PACKAGE}/package.json`));
  } catch {
    return null;
  }
}

function resolveWebTreeSitterRoot(): string | null {
  try {
    return dirname(require.resolve("web-tree-sitter"));
  } catch {
    return null;
  }
}

async function loadWebTreeSitter(): Promise<WebTreeSitter> {
  parserInitPromise ??= (async () => {
    const treeSitter = await import("web-tree-sitter");
    const runtimeRoot = resolveWebTreeSitterRoot();
    await treeSitter.Parser.init({
      locateFile(fileName: string): string {
        return runtimeRoot ? join(runtimeRoot, fileName) : fileName;
      },
    });
    return treeSitter;
  })();
  return parserInitPromise;
}

async function loadTreeSitterLanguage(
  language: SourceLanguage,
): Promise<TreeSitterLanguage | null> {
  const assetPath = getTreeSitterGrammarAssetPath(language);
  if (!assetPath) return null;
  let promise = languagePromises.get(language);
  if (!promise) {
    promise = (async () => {
      const treeSitter = await loadWebTreeSitter();
      return treeSitter.Language.load(assetPath);
    })();
    languagePromises.set(language, promise);
  }
  return promise;
}

export function getTreeSitterGrammarManifest(
  language: SourceLanguage,
): TreeSitterGrammarManifestEntry | null {
  return GRAMMAR_MANIFEST.get(language) ?? null;
}

export function getTreeSitterGrammarAssetPath(language: SourceLanguage): string | null {
  const manifest = getTreeSitterGrammarManifest(language);
  const root = resolveGrammarPackageRoot();
  if (!manifest || !root) {
    return null;
  }
  const assetPath = join(root, "wasm", manifest.asset);
  return existsSync(assetPath) ? assetPath : null;
}

export function getTreeSitterGrammarVersion(language: SourceLanguage): string {
  return getTreeSitterGrammarManifest(language)?.grammarVersion ?? "none";
}

export interface TreeSitterNodeSnapshot {
  readonly type: string;
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

export interface TreeSitterQueryCaptureSnapshot {
  readonly name: string;
  readonly node: TreeSitterNodeSnapshot;
}

export interface TreeSitterQueryMatchSnapshot {
  readonly patternIndex: number;
  readonly captures: readonly TreeSitterQueryCaptureSnapshot[];
}

export interface TreeSitterParseResult {
  readonly available: boolean;
  readonly diagnostics: readonly SourceDiagnostic[];
  readonly matches: readonly TreeSitterQueryMatchSnapshot[];
}

export async function parseTreeSitterSource(input: {
  readonly language: SourceLanguage;
  readonly sourceText: string;
  readonly query?: string;
}): Promise<TreeSitterParseResult> {
  const grammar = await loadTreeSitterLanguage(input.language);
  if (!grammar) {
    return {
      available: false,
      matches: [],
      diagnostics: [
        {
          severity: "error",
          message: `Tree-sitter grammar asset is unavailable for ${input.language}.`,
          span: buildSpan(input.sourceText, 0, 0),
          source: "tree-sitter",
        },
      ],
    };
  }

  const treeSitter = await loadWebTreeSitter();
  const parser = new treeSitter.Parser();
  try {
    parser.setLanguage(grammar);
    const tree = parser.parse(input.sourceText);
    if (!tree) {
      return {
        available: false,
        matches: [],
        diagnostics: [
          {
            severity: "error",
            message: `Tree-sitter parse returned no syntax tree for ${input.language}.`,
            span: buildSpan(input.sourceText, 0, 0),
            source: "tree-sitter",
          },
        ],
      };
    }
    try {
      const matches = input.query
        ? runTreeSitterQuery({
            treeSitter,
            grammar,
            rootNode: tree.rootNode,
            query: input.query,
          })
        : [];
      return {
        available: true,
        matches,
        diagnostics: tree.rootNode.hasError
          ? [
              {
                severity: "warning",
                message: `Tree-sitter recovered from syntax errors while parsing ${input.language}.`,
                span: buildSpan(input.sourceText, tree.rootNode.startIndex, tree.rootNode.endIndex),
                source: "tree-sitter",
              },
            ]
          : [],
      };
    } finally {
      tree.delete();
    }
  } catch (error) {
    return {
      available: false,
      matches: [],
      diagnostics: [
        {
          severity: "error",
          message:
            error instanceof Error
              ? error.message
              : `Tree-sitter parse failed for ${input.language}.`,
          span: buildSpan(input.sourceText, 0, 0),
          source: "tree-sitter",
        },
      ],
    };
  } finally {
    parser.delete();
  }
}

function snapshotNode(node: TreeSitterNode): TreeSitterNodeSnapshot {
  return {
    type: node.type,
    text: node.text,
    startIndex: node.startIndex,
    endIndex: node.endIndex,
    startPosition: {
      row: node.startPosition.row,
      column: node.startPosition.column,
    },
    endPosition: {
      row: node.endPosition.row,
      column: node.endPosition.column,
    },
  };
}

function snapshotQueryMatch(match: QueryMatch): TreeSitterQueryMatchSnapshot {
  return {
    patternIndex: match.patternIndex,
    captures: match.captures.map((capture) => ({
      name: capture.name,
      node: snapshotNode(capture.node),
    })),
  };
}

function runTreeSitterQuery(input: {
  readonly treeSitter: WebTreeSitter;
  readonly grammar: TreeSitterLanguage;
  readonly rootNode: TreeSitterNode;
  readonly query: string;
}): readonly TreeSitterQueryMatchSnapshot[] {
  const query = new input.treeSitter.Query(input.grammar, input.query);
  try {
    return query.matches(input.rootNode).map(snapshotQueryMatch);
  } finally {
    query.delete();
  }
}
