import { realpathSync, statSync } from "node:fs";
import { basename, extname, relative } from "node:path";
import { LRUCache } from "lru-cache";
import ts from "typescript";
import { buildSearchAdvisorSnapshot, normalizeSearchAdvisorPath } from "./search-advisor.js";
import { escapeRegexLiteral, tokenizeSearchTerms } from "./shared/query.js";
import { DEFAULT_SKIPPED_WORKSPACE_DIRS, walkWorkspaceFiles } from "./shared/workspace-walk.js";
import { readSourceTextWithCache, resolveTocSessionKey } from "./toc-cache.js";
import type { BrewvaToolRuntime } from "./types.js";
import { getOrCreateLruValue } from "./utils/lru.js";

const JS_TS_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const MAX_CACHE_SESSIONS = 64;
const MAX_CACHE_ENTRIES_PER_SESSION = 512;

export const DEFAULT_TOC_SEARCH_LIMIT = 8;
export const MAX_TOC_SEARCH_LIMIT = 50;
export const MAX_TOC_FILE_BYTES = 1_000_000;
export const MAX_TOC_SEARCH_CANDIDATE_FILES = 2_000;
export const MAX_TOC_SEARCH_INDEXED_BYTES = 8_000_000;

const BROAD_QUERY_MIN_FILE_COUNT = 3;
const BROAD_QUERY_SINGLE_TOKEN_RATIO = 0.35;
const BROAD_QUERY_MULTI_TOKEN_RATIO = 0.6;
const BROAD_QUERY_FACTOR = 4;
const BROAD_QUERY_ABSOLUTE_CANDIDATES = 12;

type TocDeclarationKind = "interface" | "type_alias" | "enum";
type TocSymbolKind =
  | "function"
  | "const_function"
  | "class"
  | TocDeclarationKind
  | "method"
  | "getter"
  | "setter";
type TocSearchMatchKind = TocSymbolKind | "module" | "import";

interface TocImportEntry {
  source: string;
  clause: string | null;
  lineStart: number;
  lineEnd: number;
}

interface TocMethodEntry {
  kind: "method" | "getter" | "setter";
  name: string;
  static: boolean;
  lineStart: number;
  lineEnd: number;
  signature: string;
  summary: string | null;
}

interface TocFunctionEntry {
  kind: "function" | "const_function";
  name: string;
  exported: boolean;
  lineStart: number;
  lineEnd: number;
  signature: string;
  summary: string | null;
}

interface TocClassEntry {
  kind: "class";
  name: string;
  exported: boolean;
  lineStart: number;
  lineEnd: number;
  signature: string;
  summary: string | null;
  methods: TocMethodEntry[];
}

interface TocDeclarationEntry {
  kind: TocDeclarationKind;
  name: string;
  exported: boolean;
  lineStart: number;
  lineEnd: number;
  signature: string;
  summary: string | null;
}

export interface TocDocument {
  filePath: string;
  language: string;
  moduleSummary: string | null;
  imports: TocImportEntry[];
  functions: TocFunctionEntry[];
  classes: TocClassEntry[];
  declarations: TocDeclarationEntry[];
}

export interface TocSearchMatch {
  filePath: string;
  kind: TocSearchMatchKind;
  name: string;
  score: number;
  lineStart: number;
  lineEnd: number;
  signature: string | null;
  summary: string | null;
  parentName: string | null;
}

interface TocCacheEntry {
  signature: string;
  toc: TocDocument;
}

export interface TocLookupResult {
  toc: TocDocument;
  cacheHit: boolean;
}

export interface TocSearchSummary {
  indexedFiles: number;
  candidateFiles: number;
  cacheHits: number;
  cacheMisses: number;
  skippedFiles: number;
  oversizedFiles: number;
  indexedBytes: number;
}

export interface TocSearchCoreAdvisor {
  status: "applied" | "skipped";
  signalFiles: number;
  reorderedMatches: number;
  comboMatches: number;
  scoringMode: "multiplicative";
  hotFiles: string[];
  comboSuggestion?: string;
}

export interface TocSearchCoreResult {
  queryText: string;
  query: string;
  tokens: string[];
  scopeOverflow: boolean;
  scopedFileCount: number;
  noSupportedFiles: boolean;
  noAccessibleFiles: boolean;
  noIndexableFiles: boolean;
  budgetExceeded: boolean;
  broadQuery: boolean;
  summary: TocSearchSummary;
  rankedMatches: TocSearchMatch[];
  advisor: TocSearchCoreAdvisor;
}

interface AdvisorRankedTocMatch {
  match: TocSearchMatch;
  originalOrder: number;
  finalScore: number;
  comboMatches: number;
}

type TocFileCache = LRUCache<string, TocCacheEntry>;
export type TocSearchSessionCacheStore = LRUCache<string, TocFileCache>;

function trimToSingleLine(value: string | null | undefined): string | null {
  if (!value) return null;
  const firstLine = value
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  return firstLine ? firstLine.replace(/\s+/gu, " ") : null;
}

export function normalizeRelativePath(baseDir: string, filePath: string): string {
  let normalizedBase = baseDir;
  let normalizedFilePath = filePath;
  try {
    normalizedBase = realpathSync.native(normalizedBase);
  } catch {
    // ignore
  }
  try {
    normalizedFilePath = realpathSync.native(normalizedFilePath);
  } catch {
    // ignore
  }
  const relativePath = relative(normalizedBase, normalizedFilePath).replaceAll("\\", "/");
  return relativePath.length > 0 && !relativePath.startsWith("..") ? relativePath : filePath;
}

export function supportsToc(filePath: string): boolean {
  return JS_TS_EXTENSIONS.has(extname(filePath).toLowerCase());
}

function resolveScriptKind(filePath: string): ts.ScriptKind {
  const extension = extname(filePath).toLowerCase();
  if (extension === ".ts") return ts.ScriptKind.TS;
  if (extension === ".tsx") return ts.ScriptKind.TSX;
  if (extension === ".jsx") return ts.ScriptKind.JSX;
  if (extension === ".js") return ts.ScriptKind.JS;
  if (extension === ".mjs") return ts.ScriptKind.JS;
  if (extension === ".cjs") return ts.ScriptKind.JS;
  return ts.ScriptKind.Unknown;
}

function lineSpan(
  sourceFile: ts.SourceFile,
  node: ts.Node,
): { lineStart: number; lineEnd: number } {
  const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  const endPosition = Math.max(node.getStart(sourceFile), node.getEnd() - 1);
  const end = sourceFile.getLineAndCharacterOfPosition(endPosition);
  return {
    lineStart: start.line + 1,
    lineEnd: end.line + 1,
  };
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  const modifiers = (node as ts.Node & { modifiers?: ts.NodeArray<ts.ModifierLike> }).modifiers;
  return Boolean(modifiers?.some((modifier) => modifier.kind === kind));
}

function isExportedDeclaration(node: ts.Node): boolean {
  return (
    hasModifier(node, ts.SyntaxKind.ExportKeyword) ||
    hasModifier(node, ts.SyntaxKind.DefaultKeyword)
  );
}

function buildFunctionSignature(
  name: string,
  parameters: ts.NodeArray<ts.ParameterDeclaration>,
  type: ts.TypeNode | undefined,
  sourceFile: ts.SourceFile,
  prefix = "function",
): string {
  const params = parameters.map((parameter) => parameter.getText(sourceFile)).join(", ");
  const returnType = type ? `: ${type.getText(sourceFile)}` : "";
  return `${prefix} ${name}(${params})${returnType}`;
}

function buildAnonymousDefaultFunctionSignature(
  parameters: ts.NodeArray<ts.ParameterDeclaration>,
  type: ts.TypeNode | undefined,
  sourceFile: ts.SourceFile,
): string {
  const params = parameters.map((parameter) => parameter.getText(sourceFile)).join(", ");
  const returnType = type ? `: ${type.getText(sourceFile)}` : "";
  return `export default function(${params})${returnType}`;
}

function formatTypeParameters(
  typeParameters: ts.NodeArray<ts.TypeParameterDeclaration> | undefined,
  sourceFile: ts.SourceFile,
): string {
  if (!typeParameters || typeParameters.length === 0) return "";
  return `<${typeParameters.map((parameter) => parameter.getText(sourceFile)).join(", ")}>`;
}

function compactInlineText(value: string, maxChars = 180): string {
  const compact = trimToSingleLine(value) ?? "";
  if (compact.length <= maxChars) return compact;
  return `${compact.slice(0, Math.max(1, maxChars - 3))}...`;
}

function buildMethodSignature(
  name: string,
  node:
    | ts.MethodDeclaration
    | ts.GetAccessorDeclaration
    | ts.SetAccessorDeclaration
    | ts.MethodSignature,
  sourceFile: ts.SourceFile,
): string {
  if (ts.isGetAccessorDeclaration(node)) {
    const returnType = node.type ? `: ${node.type.getText(sourceFile)}` : "";
    return `get ${name}()${returnType}`;
  }
  if (ts.isSetAccessorDeclaration(node)) {
    const params = node.parameters.map((parameter) => parameter.getText(sourceFile)).join(", ");
    return `set ${name}(${params})`;
  }
  const params = node.parameters.map((parameter) => parameter.getText(sourceFile)).join(", ");
  const returnType = node.type ? `: ${node.type.getText(sourceFile)}` : "";
  return `${name}(${params})${returnType}`;
}

function buildImportClauseText(node: ts.ImportDeclaration): string | null {
  const clause = node.importClause;
  if (!clause) return null;

  const parts: string[] = [];
  if (clause.name) {
    parts.push(clause.name.text);
  }
  if (clause.namedBindings) {
    if (ts.isNamespaceImport(clause.namedBindings)) {
      parts.push(`* as ${clause.namedBindings.name.text}`);
    } else {
      const names = clause.namedBindings.elements.map((element) => {
        const propertyName = element.propertyName?.text;
        const localName = element.name.text;
        return propertyName && propertyName !== localName
          ? `${propertyName} as ${localName}`
          : localName;
      });
      parts.push(`{ ${names.join(", ")} }`);
    }
  }

  return parts.length > 0 ? parts.join(", ") : null;
}

function extractTopOfFileSummary(sourceText: string): string | null {
  const text = sourceText.replace(/^\uFEFF/u, "");
  const lines = text.split(/\r?\n/u);
  let index = 0;

  while (index < lines.length) {
    const line = (lines[index] ?? "").trim();
    if (!line || line === "#!/usr/bin/env node") {
      index += 1;
      continue;
    }

    if (line.startsWith("//")) {
      return trimToSingleLine(line.replace(/^\/\/+\s*/u, ""));
    }

    if (line.startsWith("/*")) {
      const block: string[] = [];
      for (; index < lines.length; index += 1) {
        const current = lines[index] ?? "";
        block.push(
          current
            .replace(/^\s*\/\*\*?/u, "")
            .replace(/\*\/\s*$/u, "")
            .replace(/^\s*\*\s?/u, "")
            .trim(),
        );
        if (current.includes("*/")) break;
      }
      return trimToSingleLine(block.join("\n"));
    }

    return null;
  }

  return null;
}

function extractNodeSummary(node: ts.Node, sourceFile: ts.SourceFile): string | null {
  const jsDocNodes = (node as ts.Node & { jsDoc?: Array<{ comment?: unknown }> }).jsDoc;
  if (Array.isArray(jsDocNodes) && jsDocNodes.length > 0) {
    const jsDocComment = jsDocNodes[0]?.comment;
    if (typeof jsDocComment === "string") {
      return trimToSingleLine(jsDocComment);
    }
    if (Array.isArray(jsDocComment)) {
      const text = jsDocComment
        .map((part) => {
          if (!part || typeof part !== "object") return "";
          const value = (part as { text?: unknown }).text;
          return typeof value === "string" ? value : "";
        })
        .join("");
      return trimToSingleLine(text);
    }
  }

  const ranges = ts.getLeadingCommentRanges(sourceFile.text, node.getFullStart()) ?? [];
  const lastRange = ranges.at(-1);
  if (!lastRange) return null;
  const commentText = sourceFile.text.slice(lastRange.pos, lastRange.end);
  const normalized = commentText
    .replace(/^\/\*\*?/u, "")
    .replace(/\*\/$/u, "")
    .replace(/^\/\/+/u, "")
    .replace(/^\s*\*\s?/gmu, "")
    .trim();
  return trimToSingleLine(normalized);
}

function buildMethodEntry(
  node: ts.ClassElement,
  sourceFile: ts.SourceFile,
): TocMethodEntry | undefined {
  if (
    !ts.isMethodDeclaration(node) &&
    !ts.isGetAccessorDeclaration(node) &&
    !ts.isSetAccessorDeclaration(node)
  ) {
    return undefined;
  }
  const nameNode = node.name;
  if (!nameNode || !ts.isIdentifier(nameNode)) return undefined;
  if (
    hasModifier(node, ts.SyntaxKind.PrivateKeyword) ||
    hasModifier(node, ts.SyntaxKind.ProtectedKeyword)
  ) {
    return undefined;
  }

  const span = lineSpan(sourceFile, node);
  const kind: TocMethodEntry["kind"] = ts.isGetAccessorDeclaration(node)
    ? "getter"
    : ts.isSetAccessorDeclaration(node)
      ? "setter"
      : "method";
  return {
    kind,
    name: nameNode.text,
    static: hasModifier(node, ts.SyntaxKind.StaticKeyword),
    lineStart: span.lineStart,
    lineEnd: span.lineEnd,
    signature: buildMethodSignature(nameNode.text, node, sourceFile),
    summary: extractNodeSummary(node, sourceFile),
  };
}

function buildFunctionEntry(
  node: ts.FunctionDeclaration | ts.VariableStatement,
  sourceFile: ts.SourceFile,
): TocFunctionEntry[] {
  if (ts.isFunctionDeclaration(node)) {
    const isAnonymousDefaultExport = !node.name && hasModifier(node, ts.SyntaxKind.DefaultKeyword);
    if (!node.name && !isAnonymousDefaultExport) return [];
    const name = node.name?.text ?? "default";
    const span = lineSpan(sourceFile, node);
    return [
      {
        kind: "function",
        name,
        exported: isExportedDeclaration(node),
        lineStart: span.lineStart,
        lineEnd: span.lineEnd,
        signature: isAnonymousDefaultExport
          ? buildAnonymousDefaultFunctionSignature(node.parameters, node.type, sourceFile)
          : buildFunctionSignature(name, node.parameters, node.type, sourceFile, "function"),
        summary: extractNodeSummary(node, sourceFile),
      },
    ];
  }

  const entries: TocFunctionEntry[] = [];
  for (const declaration of node.declarationList.declarations) {
    if (!ts.isIdentifier(declaration.name)) continue;
    const initializer = declaration.initializer;
    if (
      !initializer ||
      (!ts.isArrowFunction(initializer) && !ts.isFunctionExpression(initializer))
    ) {
      continue;
    }
    const span = lineSpan(sourceFile, declaration);
    entries.push({
      kind: "const_function",
      name: declaration.name.text,
      exported: isExportedDeclaration(node),
      lineStart: span.lineStart,
      lineEnd: span.lineEnd,
      signature: buildFunctionSignature(
        declaration.name.text,
        initializer.parameters,
        initializer.type,
        sourceFile,
        "const",
      ),
      summary: extractNodeSummary(node, sourceFile),
    });
  }
  return entries;
}

function buildDeclarationEntry(
  node: ts.InterfaceDeclaration | ts.TypeAliasDeclaration | ts.EnumDeclaration,
  sourceFile: ts.SourceFile,
): TocDeclarationEntry {
  const span = lineSpan(sourceFile, node);

  if (ts.isInterfaceDeclaration(node)) {
    const typeParams = formatTypeParameters(node.typeParameters, sourceFile);
    const heritage = node.heritageClauses
      ?.map((clause) => {
        const clauseName = clause.token === ts.SyntaxKind.ExtendsKeyword ? "extends" : "implements";
        const types = clause.types.map((entry) => entry.getText(sourceFile)).join(", ");
        return `${clauseName} ${types}`;
      })
      .join(" ");

    return {
      kind: "interface",
      name: node.name.text,
      exported: isExportedDeclaration(node),
      lineStart: span.lineStart,
      lineEnd: span.lineEnd,
      signature: `interface ${node.name.text}${typeParams}${heritage ? ` ${heritage}` : ""}`,
      summary: extractNodeSummary(node, sourceFile),
    };
  }

  if (ts.isTypeAliasDeclaration(node)) {
    const typeParams = formatTypeParameters(node.typeParameters, sourceFile);
    return {
      kind: "type_alias",
      name: node.name.text,
      exported: isExportedDeclaration(node),
      lineStart: span.lineStart,
      lineEnd: span.lineEnd,
      signature: `type ${node.name.text}${typeParams} = ${compactInlineText(node.type.getText(sourceFile))}`,
      summary: extractNodeSummary(node, sourceFile),
    };
  }

  return {
    kind: "enum",
    name: node.name.text,
    exported: isExportedDeclaration(node),
    lineStart: span.lineStart,
    lineEnd: span.lineEnd,
    signature: `${hasModifier(node, ts.SyntaxKind.ConstKeyword) ? "const " : ""}enum ${node.name.text}`,
    summary: extractNodeSummary(node, sourceFile),
  };
}

function parseTocDocument(filePath: string, sourceText: string): TocDocument {
  const language = extname(filePath).replace(/^\./u, "").toLowerCase() || "unknown";
  const sourceFile = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    resolveScriptKind(filePath),
  );

  const imports: TocImportEntry[] = [];
  const functions: TocFunctionEntry[] = [];
  const classes: TocClassEntry[] = [];
  const declarations: TocDeclarationEntry[] = [];

  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement)) {
      const span = lineSpan(sourceFile, statement);
      const moduleSpecifier = statement.moduleSpecifier
        .getText(sourceFile)
        .replace(/^['"]|['"]$/gu, "");
      imports.push({
        source: moduleSpecifier,
        clause: buildImportClauseText(statement),
        lineStart: span.lineStart,
        lineEnd: span.lineEnd,
      });
      continue;
    }

    if (ts.isFunctionDeclaration(statement) || ts.isVariableStatement(statement)) {
      functions.push(...buildFunctionEntry(statement, sourceFile));
      continue;
    }

    if (
      ts.isInterfaceDeclaration(statement) ||
      ts.isTypeAliasDeclaration(statement) ||
      ts.isEnumDeclaration(statement)
    ) {
      declarations.push(buildDeclarationEntry(statement, sourceFile));
      continue;
    }

    if (ts.isClassDeclaration(statement)) {
      const isAnonymousDefaultExport =
        !statement.name && hasModifier(statement, ts.SyntaxKind.DefaultKeyword);
      if (!statement.name && !isAnonymousDefaultExport) {
        continue;
      }
      const className = statement.name?.text ?? "default";
      const span = lineSpan(sourceFile, statement);
      const methods = statement.members
        .map((member) => buildMethodEntry(member, sourceFile))
        .filter((entry): entry is TocMethodEntry => Boolean(entry));
      classes.push({
        kind: "class",
        name: className,
        exported: isExportedDeclaration(statement),
        lineStart: span.lineStart,
        lineEnd: span.lineEnd,
        signature: isAnonymousDefaultExport ? "export default class" : `class ${className}`,
        summary: extractNodeSummary(statement, sourceFile),
        methods,
      });
    }
  }

  return {
    filePath,
    language,
    moduleSummary: extractTopOfFileSummary(sourceText),
    imports,
    functions,
    classes,
    declarations,
  };
}

function getSessionCache(cacheStore: TocSearchSessionCacheStore, sessionKey: string): TocFileCache {
  return getOrCreateLruValue(cacheStore, sessionKey, () => {
    return new LRUCache({
      max: MAX_CACHE_ENTRIES_PER_SESSION,
    });
  });
}

export function createTocSearchSessionCacheStore(): TocSearchSessionCacheStore {
  return new LRUCache({
    max: MAX_CACHE_SESSIONS,
  });
}

export function lookupTocDocument(input: {
  cacheStore: TocSearchSessionCacheStore;
  sessionKey: string;
  absolutePath: string;
  signature: string;
  sourceText: string;
}): TocLookupResult {
  const cache = getSessionCache(input.cacheStore, input.sessionKey);
  const cached = cache.get(input.absolutePath);
  if (cached && cached.signature === input.signature) {
    return {
      toc: cached.toc,
      cacheHit: true,
    };
  }

  const toc = parseTocDocument(input.absolutePath, input.sourceText);
  cache.set(input.absolutePath, {
    signature: input.signature,
    toc,
  });
  return {
    toc,
    cacheHit: false,
  };
}

function walkTocFiles(
  paths: string[],
  maxCandidateFiles: number,
): { files: string[]; scopeOverflow: boolean } {
  const { files, overflow } = walkWorkspaceFiles({
    roots: paths,
    maxFiles: maxCandidateFiles,
    isMatch: (filePath) => supportsToc(filePath),
    skippedDirs: DEFAULT_SKIPPED_WORKSPACE_DIRS,
  });
  return { files: files.toSorted(), scopeOverflow: overflow };
}

function splitSearchTerms(value: string): string[] {
  return [
    ...new Set(
      value
        .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
        .toLowerCase()
        .split(/[^\p{L}\p{N}_-]+/u)
        .map((token) => token.trim())
        .filter((token) => token.length >= 2),
    ),
  ];
}

function hasWordBoundaryMatch(value: string, token: string): boolean {
  if (!value || !token) return false;
  return new RegExp(
    `(^|[^\\p{L}\\p{N}_-])${escapeRegexLiteral(token)}($|[^\\p{L}\\p{N}_-])`,
    "iu",
  ).test(value);
}

function scoreField(query: string, tokens: string[], field: string | null | undefined): number {
  if (!field) return 0;
  const lower = field.toLowerCase();
  const fieldTerms = new Set(splitSearchTerms(field));
  let score = 0;
  if (lower === query) score += 30;
  if (fieldTerms.has(query)) score += 20;
  if (hasWordBoundaryMatch(lower, query)) score += 10;
  if (lower.includes(query)) score += 12;
  for (const token of tokens) {
    if (lower === token) {
      score += 12;
      continue;
    }
    if (fieldTerms.has(token)) {
      score += Math.max(4, token.length + 2);
      continue;
    }
    if (hasWordBoundaryMatch(lower, token)) {
      score += Math.max(3, token.length + 1);
      continue;
    }
    if (lower.includes(token)) {
      score += Math.max(2, token.length);
    }
  }
  return score;
}

export function formatLineSpan(lineStart: number, lineEnd: number): string {
  return lineStart === lineEnd ? `L${lineStart}` : `L${lineStart}-L${lineEnd}`;
}

function searchDocument(
  toc: TocDocument,
  baseDir: string,
  query: string,
  tokens: string[],
): TocSearchMatch[] {
  const relativePath = normalizeRelativePath(baseDir, toc.filePath);
  const matches: TocSearchMatch[] = [];

  const moduleScore =
    scoreField(query, tokens, relativePath) + scoreField(query, tokens, toc.moduleSummary);
  if (moduleScore > 0) {
    matches.push({
      filePath: toc.filePath,
      kind: "module",
      name: basename(toc.filePath),
      score: moduleScore,
      lineStart: 1,
      lineEnd: 1,
      signature: null,
      summary: toc.moduleSummary,
      parentName: null,
    });
  }

  for (const entry of toc.imports) {
    const score =
      scoreField(query, tokens, entry.source) +
      scoreField(query, tokens, entry.clause) +
      scoreField(query, tokens, relativePath);
    if (score <= 0) continue;
    matches.push({
      filePath: toc.filePath,
      kind: "import",
      name: entry.source,
      score,
      lineStart: entry.lineStart,
      lineEnd: entry.lineEnd,
      signature: entry.clause
        ? `import ${entry.clause} from "${entry.source}"`
        : `import "${entry.source}"`,
      summary: null,
      parentName: null,
    });
  }

  for (const entry of toc.functions) {
    const score =
      scoreField(query, tokens, entry.name) +
      scoreField(query, tokens, entry.signature) +
      scoreField(query, tokens, entry.summary) +
      scoreField(query, tokens, entry.exported ? "export" : undefined);
    if (score <= 0) continue;
    matches.push({
      filePath: toc.filePath,
      kind: entry.kind,
      name: entry.name,
      score,
      lineStart: entry.lineStart,
      lineEnd: entry.lineEnd,
      signature: entry.signature,
      summary: entry.summary,
      parentName: null,
    });
  }

  for (const entry of toc.declarations) {
    const score =
      scoreField(query, tokens, entry.name) +
      scoreField(query, tokens, entry.signature) +
      scoreField(query, tokens, entry.summary) +
      scoreField(query, tokens, entry.exported ? "export" : undefined);
    if (score <= 0) continue;
    matches.push({
      filePath: toc.filePath,
      kind: entry.kind,
      name: entry.name,
      score,
      lineStart: entry.lineStart,
      lineEnd: entry.lineEnd,
      signature: entry.signature,
      summary: entry.summary,
      parentName: null,
    });
  }

  for (const entry of toc.classes) {
    const classScore =
      scoreField(query, tokens, entry.name) +
      scoreField(query, tokens, entry.signature) +
      scoreField(query, tokens, entry.summary) +
      scoreField(query, tokens, entry.exported ? "export" : undefined);
    if (classScore > 0) {
      matches.push({
        filePath: toc.filePath,
        kind: "class",
        name: entry.name,
        score: classScore,
        lineStart: entry.lineStart,
        lineEnd: entry.lineEnd,
        signature: entry.signature,
        summary: entry.summary,
        parentName: null,
      });
    }

    for (const method of entry.methods) {
      const methodScore =
        scoreField(query, tokens, method.name) +
        scoreField(query, tokens, method.signature) +
        scoreField(query, tokens, method.summary) +
        scoreField(query, tokens, entry.name);
      if (methodScore <= 0) continue;
      matches.push({
        filePath: toc.filePath,
        kind: method.kind,
        name: method.name,
        score: methodScore,
        lineStart: method.lineStart,
        lineEnd: method.lineEnd,
        signature: method.signature,
        summary: method.summary,
        parentName: entry.name,
      });
    }
  }

  return matches;
}

function resolveBroadQuery(input: {
  candidateFiles: number;
  indexedFiles: number;
  limit: number;
  tokens: string[];
}): boolean {
  if (input.indexedFiles <= 0 || input.candidateFiles <= 0) return false;
  const ratio = input.candidateFiles / input.indexedFiles;
  const ratioThreshold =
    input.tokens.length <= 1 ? BROAD_QUERY_SINGLE_TOKEN_RATIO : BROAD_QUERY_MULTI_TOKEN_RATIO;
  const absoluteThreshold = Math.max(
    input.limit * BROAD_QUERY_FACTOR,
    BROAD_QUERY_ABSOLUTE_CANDIDATES,
  );
  if (input.candidateFiles > absoluteThreshold) return true;
  return input.candidateFiles >= BROAD_QUERY_MIN_FILE_COUNT && ratio >= ratioThreshold;
}

export function runTocSearchCore(input: {
  runtime?: BrewvaToolRuntime;
  sessionId?: string;
  baseDir: string;
  roots: string[];
  queryText: string;
  limit: number;
  cacheStore: TocSearchSessionCacheStore;
  maxCandidateFiles?: number;
  maxIndexedBytes?: number;
}): TocSearchCoreResult {
  const queryText = input.queryText.trim();
  const query = queryText.toLowerCase();
  const tokens = tokenizeSearchTerms(query);
  const emptySummary: TocSearchSummary = {
    indexedFiles: 0,
    candidateFiles: 0,
    cacheHits: 0,
    cacheMisses: 0,
    skippedFiles: 0,
    oversizedFiles: 0,
    indexedBytes: 0,
  };
  const emptyAdvisor: TocSearchCoreAdvisor = {
    status: "skipped",
    signalFiles: 0,
    reorderedMatches: 0,
    comboMatches: 0,
    scoringMode: "multiplicative",
    hotFiles: [],
  };

  if (tokens.length === 0) {
    return {
      queryText,
      query,
      tokens,
      scopeOverflow: false,
      scopedFileCount: 0,
      noSupportedFiles: false,
      noAccessibleFiles: false,
      noIndexableFiles: false,
      budgetExceeded: false,
      broadQuery: false,
      summary: emptySummary,
      rankedMatches: [],
      advisor: emptyAdvisor,
    };
  }

  const maxCandidateFiles = input.maxCandidateFiles ?? MAX_TOC_SEARCH_CANDIDATE_FILES;
  const maxIndexedBytes = input.maxIndexedBytes ?? MAX_TOC_SEARCH_INDEXED_BYTES;
  const walk = walkTocFiles(input.roots, maxCandidateFiles);
  if (walk.scopeOverflow) {
    return {
      queryText,
      query,
      tokens,
      scopeOverflow: true,
      scopedFileCount: walk.files.length,
      noSupportedFiles: false,
      noAccessibleFiles: false,
      noIndexableFiles: false,
      budgetExceeded: false,
      broadQuery: false,
      summary: emptySummary,
      rankedMatches: [],
      advisor: emptyAdvisor,
    };
  }

  const files = walk.files;
  if (files.length === 0) {
    return {
      queryText,
      query,
      tokens,
      scopeOverflow: false,
      scopedFileCount: 0,
      noSupportedFiles: true,
      noAccessibleFiles: false,
      noIndexableFiles: false,
      budgetExceeded: false,
      broadQuery: false,
      summary: emptySummary,
      rankedMatches: [],
      advisor: emptyAdvisor,
    };
  }

  const allMatches: TocSearchMatch[] = [];
  const sessionKey = resolveTocSessionKey(input.sessionId);
  let indexedFiles = 0;
  let cacheHits = 0;
  let cacheMisses = 0;
  let skippedFiles = 0;
  let oversizedFiles = 0;
  let indexedBytes = 0;
  let budgetExceeded = false;

  for (const filePath of files) {
    try {
      const stats = statSync(filePath);
      if (stats.size > MAX_TOC_FILE_BYTES) {
        oversizedFiles += 1;
        continue;
      }
      if (indexedBytes + stats.size > maxIndexedBytes) {
        budgetExceeded = true;
        break;
      }
      const source = readSourceTextWithCache({
        sessionId: input.sessionId,
        absolutePath: filePath,
        signature: `${stats.mtimeMs}:${stats.size}`,
      });
      const lookup = lookupTocDocument({
        cacheStore: input.cacheStore,
        sessionKey,
        absolutePath: filePath,
        signature: `${stats.mtimeMs}:${stats.size}`,
        sourceText: source.sourceText,
      });
      indexedFiles += 1;
      indexedBytes += stats.size;
      if (lookup.cacheHit) {
        cacheHits += 1;
      } else {
        cacheMisses += 1;
      }
      allMatches.push(...searchDocument(lookup.toc, input.baseDir, query, tokens));
    } catch {
      skippedFiles += 1;
      continue;
    }
  }

  const summary: TocSearchSummary = {
    indexedFiles,
    candidateFiles: 0,
    cacheHits,
    cacheMisses,
    skippedFiles,
    oversizedFiles,
    indexedBytes,
  };

  if (indexedFiles === 0) {
    return {
      queryText,
      query,
      tokens,
      scopeOverflow: false,
      scopedFileCount: files.length,
      noSupportedFiles: false,
      noAccessibleFiles: oversizedFiles === 0,
      noIndexableFiles: oversizedFiles > 0,
      budgetExceeded,
      broadQuery: false,
      summary,
      rankedMatches: [],
      advisor: emptyAdvisor,
    };
  }

  allMatches.sort((left, right) => {
    if (left.score !== right.score) return right.score - left.score;
    if (left.filePath !== right.filePath) return left.filePath.localeCompare(right.filePath);
    if (left.lineStart !== right.lineStart) return left.lineStart - right.lineStart;
    return left.name.localeCompare(right.name);
  });

  const advisorSnapshot = buildSearchAdvisorSnapshot({
    runtime: input.runtime,
    sessionId: input.sessionId,
  });
  const rankedMatches: AdvisorRankedTocMatch[] = allMatches.map((match, originalOrder) => {
    const advisorPath = normalizeSearchAdvisorPath(input.baseDir, match.filePath) ?? match.filePath;
    const advisorScore = advisorSnapshot.scoreFile({
      toolName: "toc_search",
      query: queryText,
      filePath: advisorPath,
    });
    const pathFactor = Math.min(0.15, advisorScore.pathScore / 60);
    const comboFactor =
      advisorScore.comboHits < 3
        ? Math.min(0.05, advisorScore.comboStrength * 0.02)
        : Math.min(0.2, advisorScore.comboStrength * 0.05);
    const advisoryFactor = Math.min(0.35, pathFactor + comboFactor);
    return {
      match,
      originalOrder,
      finalScore: match.score * (1 + advisoryFactor),
      comboMatches: advisorScore.comboHits,
    };
  });
  rankedMatches.sort((left, right) => {
    if (left.finalScore !== right.finalScore) return right.finalScore - left.finalScore;
    if (left.match.score !== right.match.score) return right.match.score - left.match.score;
    return left.originalOrder - right.originalOrder;
  });

  const candidateFiles = new Set(allMatches.map((match) => match.filePath)).size;
  summary.candidateFiles = candidateFiles;
  const comboMatch = advisorSnapshot.getComboMatch({
    toolName: "toc_search",
    query: queryText,
  });
  const comboMatchCount = Math.max(
    comboMatch?.hitCount ?? 0,
    ...rankedMatches.map((item) => item.comboMatches),
  );
  const advisorStatus =
    advisorSnapshot.signalFiles > 0 || comboMatchCount > 0 ? "applied" : "skipped";

  return {
    queryText,
    query,
    tokens,
    scopeOverflow: false,
    scopedFileCount: files.length,
    noSupportedFiles: false,
    noAccessibleFiles: false,
    noIndexableFiles: false,
    budgetExceeded,
    broadQuery: resolveBroadQuery({
      candidateFiles,
      indexedFiles,
      limit: input.limit,
      tokens,
    }),
    summary,
    rankedMatches: rankedMatches.map((item) => item.match),
    advisor: {
      status: advisorStatus,
      signalFiles: advisorSnapshot.signalFiles,
      reorderedMatches: rankedMatches.filter((item, index) => item.originalOrder !== index).length,
      comboMatches: comboMatchCount,
      scoringMode: "multiplicative",
      hotFiles: advisorSnapshot.hotFiles.slice(0, 3),
      comboSuggestion: comboMatch?.filePath,
    },
  };
}
