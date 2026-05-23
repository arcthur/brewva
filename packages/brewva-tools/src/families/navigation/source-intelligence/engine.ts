import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { createOxcTypeScriptAdapter } from "./adapters/oxc-typescript.js";
import { packageJsonAdapter } from "./adapters/package-json.js";
import { treeSitterCppAdapter } from "./adapters/tree-sitter-cpp.js";
import { treeSitterGoAdapter } from "./adapters/tree-sitter-go.js";
import { treeSitterJavaAdapter } from "./adapters/tree-sitter-java.js";
import { treeSitterPythonAdapter } from "./adapters/tree-sitter-python.js";
import { treeSitterRustAdapter } from "./adapters/tree-sitter-rust.js";
import type { SourceParserAdapter } from "./adapters/types.js";
import {
  buildParseCacheKey,
  clearSourceIntelligenceCaches,
  getCachedSourceDocument,
  getCachedSourceGraph,
  readSourceTextCached,
  setCachedSourceDocument,
  setCachedSourceGraph,
} from "./cache.js";
import type {
  SourceCall,
  SourceConfidence,
  SourceDeclaration,
  SourceDocument,
  SourceGraph,
  SourceGraphCycle,
  SourceGraphEdge,
  SourceImport,
  SourceLanguage,
  SourceSurface,
} from "./ir.js";
import { detectSourceLanguage, isSourceIntelligenceFile, isTypeScriptFamily } from "./language.js";

export { clearSourceIntelligenceCaches };

export interface SourceIntelligenceEngineOptions {
  readonly workspaceRoot: string;
  readonly maxFiles?: number;
  readonly extraSkippedDirectories?: readonly string[];
}

export interface SourceIntelligenceOperationOptions {
  readonly signal?: AbortSignal;
  readonly maxFiles?: number;
  readonly loadConcurrency?: number;
}

export interface SourceFileListing {
  readonly files: readonly string[];
  readonly truncated: boolean;
}

export interface SourceIntelligenceEngine {
  readonly workspaceRoot: string;
  loadDocument(
    filePath: string,
    options?: SourceIntelligenceOperationOptions,
  ): Promise<SourceDocument>;
  listSourceFilePaths(
    paths?: readonly string[],
    options?: SourceIntelligenceOperationOptions,
  ): Promise<SourceFileListing>;
  listDocuments(
    paths?: readonly string[],
    options?: SourceIntelligenceOperationOptions,
  ): Promise<readonly SourceDocument[]>;
  buildGraph(
    paths?: readonly string[],
    options?: SourceIntelligenceOperationOptions,
  ): Promise<SourceGraph>;
  resolveSurface(
    path: string,
    options?: SourceIntelligenceOperationOptions,
  ): Promise<SourceSurface>;
  findCallers(
    input: SourceCallQuery,
    options?: SourceIntelligenceOperationOptions,
  ): Promise<readonly SourceGraphEdge[]>;
  findCallees(
    input: SourceCallQuery,
    options?: SourceIntelligenceOperationOptions,
  ): Promise<readonly SourceGraphEdge[]>;
}

export interface SourceCallQuery {
  readonly symbol: string;
  readonly filePath?: string;
  readonly line?: number;
}

const DEFAULT_MAX_FILES = 2_000;
const DEFAULT_LOAD_CONCURRENCY = 8;
const MAX_SOURCE_FILE_BYTES = 512 * 1024;
const DEFAULT_SKIPPED_DIRECTORIES = [
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".turbo",
  ".venv",
  "target",
  "vendor",
] as const;

function normalizeSkippedDirectoryName(value: string): string | null {
  const segments = value.replaceAll("\\", "/").split("/");
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const normalized = segments[index]?.trim();
    if (normalized && normalized.length > 0) {
      return normalized;
    }
  }
  return null;
}

function buildSkippedDirectories(extraSkippedDirectories?: readonly string[]): ReadonlySet<string> {
  const skipped = new Set<string>(DEFAULT_SKIPPED_DIRECTORIES);
  for (const directory of extraSkippedDirectories ?? []) {
    const name = normalizeSkippedDirectoryName(directory);
    if (name) {
      skipped.add(name);
    }
  }
  return skipped;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new Error("source_intelligence_aborted");
  }
}

const SOURCE_RESOLUTION_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".d.ts",
  ".py",
  ".go",
  ".rs",
  ".java",
  ".cpp",
  ".cc",
  ".cxx",
  ".hpp",
  ".hh",
  ".h",
  "",
] as const;

interface GitignoreRule {
  readonly pattern: string;
  readonly directoryOnly: boolean;
  readonly anchored: boolean;
  readonly negated: boolean;
}

function createAdapterRegistry(): ReadonlyMap<SourceLanguage, SourceParserAdapter> {
  return new Map<SourceLanguage, SourceParserAdapter>([
    ["typescript", createOxcTypeScriptAdapter("typescript")],
    ["tsx", createOxcTypeScriptAdapter("tsx")],
    ["javascript", createOxcTypeScriptAdapter("javascript")],
    ["jsx", createOxcTypeScriptAdapter("jsx")],
    ["python", treeSitterPythonAdapter],
    ["go", treeSitterGoAdapter],
    ["rust", treeSitterRustAdapter],
    ["java", treeSitterJavaAdapter],
    ["cpp", treeSitterCppAdapter],
    ["json", packageJsonAdapter],
  ]);
}

function normalizePath(path: string): string {
  return resolve(path);
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function readRootGitignoreRules(root: string): readonly GitignoreRule[] {
  const gitignorePath = join(root, ".gitignore");
  if (!existsSync(gitignorePath) || !isFile(gitignorePath)) return [];
  try {
    return readFileSync(gitignorePath, "utf8")
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"))
      .map((line) => {
        const negated = line.startsWith("!");
        const withoutNegation = negated ? line.slice(1) : line;
        const anchored = withoutNegation.startsWith("/");
        const withoutAnchor = anchored ? withoutNegation.slice(1) : withoutNegation;
        const directoryOnly = withoutAnchor.endsWith("/");
        return {
          pattern: directoryOnly ? withoutAnchor.slice(0, -1) : withoutAnchor,
          directoryOnly,
          anchored,
          negated,
        };
      })
      .filter((rule) => rule.pattern.length > 0);
  } catch {
    return [];
  }
}

function globSegmentMatches(pattern: string, value: string): boolean {
  if (!pattern.includes("*")) return pattern === value;
  const escaped = pattern
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/gu, "\\$&"))
    .join(".*");
  return new RegExp(`^${escaped}$`, "u").test(value);
}

function gitignoreRuleMatches(input: {
  readonly rule: GitignoreRule;
  readonly relativePath: string;
  readonly isDirectory: boolean;
}): boolean {
  const segments = input.relativePath.split("/");
  if (input.rule.directoryOnly && !input.isDirectory) {
    const prefix = `${input.rule.pattern}/`;
    return input.relativePath.startsWith(prefix) || input.relativePath.includes(`/${prefix}`);
  }
  if (input.rule.anchored || input.rule.pattern.includes("/")) {
    return (
      globSegmentMatches(input.rule.pattern, input.relativePath) ||
      input.relativePath.startsWith(`${input.rule.pattern}/`)
    );
  }
  return segments.some((segment) => globSegmentMatches(input.rule.pattern, segment));
}

function isIgnoredByGitignore(input: {
  readonly root: string;
  readonly entry: string;
  readonly isDirectory: boolean;
  readonly rules: readonly GitignoreRule[];
}): boolean {
  const relativePath = relative(input.root, input.entry).replaceAll("\\", "/");
  if (relativePath.length === 0 || relativePath.startsWith("..")) return false;
  let ignored = false;
  for (const rule of input.rules) {
    if (gitignoreRuleMatches({ rule, relativePath, isDirectory: input.isDirectory })) {
      ignored = !rule.negated;
    }
  }
  return ignored;
}

function walkSourceFiles(
  root: string,
  maxFiles: number,
  skippedDirectories: ReadonlySet<string>,
  options: SourceIntelligenceOperationOptions = {},
): SourceFileListing {
  const gitignoreRules = readRootGitignoreRules(root);
  const out: string[] = [];
  let truncated = false;
  const visit = (entry: string): void => {
    throwIfAborted(options.signal);
    if (out.length >= maxFiles) {
      truncated = true;
      return;
    }
    let stats: import("node:fs").Stats;
    try {
      stats = statSync(entry);
    } catch {
      return;
    }
    if (stats.isDirectory()) {
      const name = entry.split(/[\\/]/u).at(-1) ?? "";
      if (skippedDirectories.has(name)) return;
      if (
        isIgnoredByGitignore({
          root,
          entry,
          isDirectory: true,
          rules: gitignoreRules,
        })
      ) {
        return;
      }
      for (const child of readdirSync(entry).toSorted((left, right) => left.localeCompare(right))) {
        visit(join(entry, child));
        if (out.length >= maxFiles) {
          truncated = true;
          return;
        }
      }
      return;
    }
    if (
      isIgnoredByGitignore({
        root,
        entry,
        isDirectory: false,
        rules: gitignoreRules,
      })
    ) {
      return;
    }
    if (stats.isFile() && stats.size <= MAX_SOURCE_FILE_BYTES && isSourceIntelligenceFile(entry)) {
      out.push(entry);
    }
  };
  visit(root);
  return { files: out, truncated };
}

function candidateRoots(workspaceRoot: string, paths?: readonly string[]): readonly string[] {
  if (!paths || paths.length === 0) {
    return [workspaceRoot];
  }
  return paths.map((path) => resolve(workspaceRoot, path));
}

function graphCacheKey(
  root: string,
  roots: readonly string[],
  documents: readonly SourceDocument[],
): string {
  return [
    root,
    ...roots.map(normalizePath).toSorted(),
    ...documents
      .map((document) => `${document.filePath}:${document.sourceHash}:${document.grammarVersion}`)
      .toSorted(),
  ].join("\0");
}

function resolveRelativeImport(fromPath: string, rawSpecifier: string): string | undefined {
  if (!rawSpecifier.startsWith(".")) {
    return undefined;
  }
  const base = resolve(dirname(fromPath), rawSpecifier);
  const candidates = SOURCE_RESOLUTION_EXTENSIONS.flatMap((extension) => [
    `${base}${extension}`,
    join(base, `index${extension}`),
  ]);
  return candidates.find((candidate) => existsSync(candidate) && isFile(candidate));
}

function pythonRelativeSpecifierToPath(rawSpecifier: string): string {
  const leadingDots = /^\.*/u.exec(rawSpecifier)?.[0].length ?? 0;
  const remainder = rawSpecifier.slice(leadingDots).replace(/\./gu, "/");
  const prefix =
    leadingDots <= 1 ? "." : Array.from({ length: leadingDots - 1 }, () => "..").join("/");
  return remainder.length > 0 ? `${prefix}/${remainder}` : prefix;
}

function resolvePythonRelativeImport(fromPath: string, rawSpecifier: string): string | undefined {
  const relativeSpecifier = pythonRelativeSpecifierToPath(rawSpecifier);
  const base = resolve(dirname(fromPath), relativeSpecifier);
  const pythonCandidates = [`${base}.py`, join(base, "__init__.py"), base];
  const pythonTarget = pythonCandidates.find(
    (candidate) => existsSync(candidate) && isFile(candidate),
  );
  return pythonTarget ?? resolveRelativeImport(fromPath, relativeSpecifier);
}

function resolvePythonImport(
  workspaceRoot: string,
  fromPath: string,
  sourceImport: SourceImport,
): string | undefined {
  if (sourceImport.rawSpecifier.startsWith(".")) {
    return resolvePythonRelativeImport(fromPath, sourceImport.rawSpecifier);
  }
  const modulePath = sourceImport.rawSpecifier.replace(/\./gu, "/");
  const direct = resolve(workspaceRoot, `${modulePath}.py`);
  if (existsSync(direct) && isFile(direct)) return direct;
  const initFile = resolve(workspaceRoot, modulePath, "__init__.py");
  return existsSync(initFile) && isFile(initFile) ? initFile : undefined;
}

function resolveImportTarget(
  workspaceRoot: string,
  document: SourceDocument,
  sourceImport: SourceImport,
): string | undefined {
  if (sourceImport.resolvedPath) {
    return sourceImport.resolvedPath;
  }
  if (document.language === "python") {
    return resolvePythonImport(workspaceRoot, document.filePath, sourceImport);
  }
  if (sourceImport.rawSpecifier.startsWith(".")) {
    return resolveRelativeImport(document.filePath, sourceImport.rawSpecifier);
  }
  return undefined;
}

function buildImportEdge(input: {
  readonly document: SourceDocument;
  readonly sourceImport: SourceImport;
  readonly toPath?: string;
  readonly index: number;
}): SourceGraphEdge {
  return {
    id: `${input.document.filePath}:import-edge:${input.index}`,
    kind: "import",
    fromPath: input.document.filePath,
    toPath: input.toPath,
    rawSpecifier: input.sourceImport.rawSpecifier,
    sourceSpan: input.sourceImport.span,
    confidence: input.toPath ? "exact" : "inferred",
    editAuthority: false,
  };
}

function buildReverseEdges(edges: readonly SourceGraphEdge[]): readonly SourceGraphEdge[] {
  return edges
    .filter((edge) => Boolean(edge.toPath))
    .map((edge) => {
      const toPath = edge.toPath ?? edge.fromPath;
      return {
        id: `${edge.id}:reverse`,
        kind: edge.kind,
        fromPath: toPath,
        toPath: edge.fromPath,
        rawSpecifier: edge.rawSpecifier,
        sourceSpan: edge.sourceSpan,
        confidence: edge.confidence,
        editAuthority: false,
      };
    });
}

function detectCycles(edges: readonly SourceGraphEdge[]): readonly SourceGraphCycle[] {
  const adjacency = new Map<string, Set<string>>();
  for (const edge of edges) {
    if (!edge.toPath) continue;
    const targets = adjacency.get(edge.fromPath) ?? new Set<string>();
    targets.add(edge.toPath);
    adjacency.set(edge.fromPath, targets);
  }

  const cycles: SourceGraphCycle[] = [];
  const stack: string[] = [];
  const onStack = new Set<string>();
  const visited = new Set<string>();

  const visit = (node: string): void => {
    if (onStack.has(node)) {
      const index = stack.indexOf(node);
      if (index >= 0) {
        cycles.push({ paths: [...stack.slice(index), node] });
      }
      return;
    }
    if (visited.has(node)) return;
    visited.add(node);
    onStack.add(node);
    stack.push(node);
    for (const target of adjacency.get(node) ?? []) {
      visit(target);
    }
    stack.pop();
    onStack.delete(node);
  };

  for (const node of adjacency.keys()) {
    visit(node);
  }
  return cycles;
}

function importedPathsForDocument(graph: SourceGraph, documentPath: string): ReadonlySet<string> {
  return new Set(
    graph.edges
      .filter((edge) => edge.kind === "import" && normalizePath(edge.fromPath) === documentPath)
      .map((edge) => edge.toPath)
      .filter((path): path is string => Boolean(path))
      .map(normalizePath),
  );
}

function declarationIsLocallyVisible(input: {
  readonly declaration: SourceDeclaration;
  readonly callerPath: string;
  readonly importedPaths: ReadonlySet<string>;
}): boolean {
  const declarationPath = normalizePath(input.declaration.filePath);
  return declarationPath === input.callerPath || input.importedPaths.has(declarationPath);
}

function confidenceForCall(input: {
  readonly callerPath: string;
  readonly importedPaths: ReadonlySet<string>;
  readonly candidates: readonly SourceDeclaration[];
  readonly targetDeclarations?: readonly SourceDeclaration[];
}): SourceConfidence {
  const candidates = input.candidates.filter((declaration) => declaration.name.length > 0);
  if (candidates.length === 0) return "ambiguous";
  const visibleCandidates = candidates.filter((declaration) =>
    declarationIsLocallyVisible({
      declaration,
      callerPath: input.callerPath,
      importedPaths: input.importedPaths,
    }),
  );
  const targetDeclarations = input.targetDeclarations ?? candidates;
  const visibleTarget = targetDeclarations.some((target) =>
    visibleCandidates.some((candidate) => candidate.id === target.id),
  );
  if (visibleTarget) return "exact";
  if (visibleCandidates.length === 1 && !input.targetDeclarations) return "exact";
  if (visibleCandidates.length > 1) return "ambiguous";
  if (candidates.length > 1) return "ambiguous";
  return "inferred";
}

function resolvedCallTarget(input: {
  readonly confidence: SourceConfidence;
  readonly candidates: readonly SourceDeclaration[];
  readonly targetDeclarations?: readonly SourceDeclaration[];
}): string | undefined {
  if (input.confidence === "ambiguous") return undefined;
  const targets = input.targetDeclarations?.length ? input.targetDeclarations : input.candidates;
  return targets.length === 1 ? targets[0]?.filePath : undefined;
}

function buildCallEdge(input: {
  readonly call: SourceCall;
  readonly fromPath: string;
  readonly toPath?: string;
  readonly confidence: SourceConfidence;
  readonly index: number;
}): SourceGraphEdge {
  return {
    id: `${input.fromPath}:call-edge:${input.call.callee}:${input.index}`,
    kind: "call",
    fromPath: input.fromPath,
    toPath: input.toPath,
    rawSpecifier: input.call.callee,
    sourceSpan: input.call.span,
    confidence: input.confidence,
    editAuthority: false,
  };
}

function declarationMatchesQuery(declaration: SourceDeclaration, query: SourceCallQuery): boolean {
  if (declaration.name !== query.symbol) return false;
  if (query.filePath && normalizePath(declaration.filePath) !== normalizePath(query.filePath)) {
    return false;
  }
  if (typeof query.line === "number") {
    return (
      declaration.selectionSpan.startLine <= query.line &&
      declaration.selectionSpan.endLine >= query.line
    );
  }
  return true;
}

interface SourceCallSite {
  readonly document: SourceDocument;
  readonly call: SourceCall;
}

function buildCallsByCallee(graph: SourceGraph): ReadonlyMap<string, readonly SourceCallSite[]> {
  const callsByCallee = new Map<string, SourceCallSite[]>();
  for (const document of graph.documents) {
    for (const call of document.calls) {
      const calls = callsByCallee.get(call.callee) ?? [];
      calls.push({ document, call });
      callsByCallee.set(call.callee, calls);
    }
  }
  return callsByCallee;
}

function buildCallers(graph: SourceGraph, query: SourceCallQuery): readonly SourceGraphEdge[] {
  const declarations = graph.documents.flatMap((document) => document.declarations);
  const targetDeclarations = declarations.filter((declaration) =>
    declarationMatchesQuery(declaration, query),
  );
  const allCandidates = declarations.filter((declaration) => declaration.name === query.symbol);
  const edges: SourceGraphEdge[] = [];
  for (const { document, call } of buildCallsByCallee(graph).get(query.symbol) ?? []) {
    const callerPath = normalizePath(document.filePath);
    const importedPaths = importedPathsForDocument(graph, callerPath);
    const visibleCandidates = allCandidates.filter((declaration) =>
      declarationIsLocallyVisible({
        declaration,
        callerPath,
        importedPaths,
      }),
    );
    if (
      targetDeclarations.length > 0 &&
      visibleCandidates.length === 1 &&
      !targetDeclarations.some((target) => target.id === visibleCandidates[0]?.id)
    ) {
      continue;
    }
    const confidence = confidenceForCall({
      callerPath,
      importedPaths,
      candidates: allCandidates,
      targetDeclarations,
    });
    edges.push(
      buildCallEdge({
        call,
        fromPath: document.filePath,
        toPath: resolvedCallTarget({
          confidence,
          candidates: allCandidates,
          targetDeclarations,
        }),
        confidence,
        index: edges.length,
      }),
    );
  }
  return edges;
}

function buildCallees(graph: SourceGraph, query: SourceCallQuery): readonly SourceGraphEdge[] {
  const ownerDeclarations = graph.documents
    .flatMap((document) => document.declarations)
    .filter((declaration) => declarationMatchesQuery(declaration, query));
  if (ownerDeclarations.length === 0) {
    return [];
  }
  const declarations = graph.documents.flatMap((document) => document.declarations);
  const edges: SourceGraphEdge[] = [];
  for (const document of graph.documents) {
    const callerPath = normalizePath(document.filePath);
    const importedPaths = importedPathsForDocument(graph, callerPath);
    for (const call of document.calls) {
      const owner = ownerDeclarations.find((declaration) => {
        if (normalizePath(declaration.filePath) !== normalizePath(document.filePath)) {
          return false;
        }
        return (
          declaration.span.startByte <= call.span.startByte &&
          declaration.span.endByte >= call.span.endByte
        );
      });
      if (!owner) continue;
      const candidates = declarations.filter((declaration) => declaration.name === call.callee);
      const confidence = confidenceForCall({
        callerPath,
        importedPaths,
        candidates,
      });
      edges.push(
        buildCallEdge({
          call,
          fromPath: document.filePath,
          toPath: resolvedCallTarget({
            confidence,
            candidates,
          }),
          confidence,
          index: edges.length,
        }),
      );
    }
  }
  return edges;
}

async function mapWithConcurrency<T, U>(
  items: readonly T[],
  concurrency: number,
  signal: AbortSignal | undefined,
  fn: (item: T) => Promise<U>,
): Promise<readonly U[]> {
  throwIfAborted(signal);
  const limit = Math.max(1, Math.min(concurrency, items.length || 1));
  const results: U[] = [];
  let nextIndex = 0;

  const worker = async (): Promise<void> => {
    while (nextIndex < items.length) {
      throwIfAborted(signal);
      const index = nextIndex;
      nextIndex += 1;
      const item = items[index] as T;
      results[index] = await fn(item);
    }
  };

  await Promise.all(Array.from({ length: limit }, () => worker()));
  throwIfAborted(signal);
  return results;
}

function findSourceFiles(
  root: string,
  maxFiles: number,
  skippedDirectories: ReadonlySet<string>,
  options: SourceIntelligenceOperationOptions = {},
): SourceFileListing {
  throwIfAborted(options.signal);
  if (!existsSync(root)) return { files: [], truncated: false };
  if (isDirectory(root)) {
    return walkSourceFiles(root, maxFiles, skippedDirectories, options);
  }
  return {
    files:
      isSourceIntelligenceFile(root) && statSync(root).size <= MAX_SOURCE_FILE_BYTES ? [root] : [],
    truncated: false,
  };
}

function extractPythonAllExports(filePath: string): ReadonlySet<string> | null {
  let sourceText: string;
  try {
    sourceText = readSourceTextCached(filePath).sourceText;
  } catch {
    return null;
  }
  const names: string[] = [];
  for (const match of sourceText.matchAll(/__all__\s*(?:\+?=)\s*[[(]([\s\S]*?)[\])]/gu)) {
    for (const entry of (match[1] ?? "").matchAll(/["']([A-Za-z_]\w*)["']/gu)) {
      if (entry[1]) names.push(entry[1]);
    }
  }
  return names.length > 0 ? new Set(names) : null;
}

function publicDeclarations(document: SourceDocument): readonly SourceDeclaration[] {
  if (document.language === "python") {
    const pythonAll = extractPythonAllExports(document.filePath);
    if (pythonAll) {
      return document.declarations.filter((declaration) => pythonAll.has(declaration.name));
    }
  }
  return document.declarations.filter((declaration) => declaration.exported);
}

function namespaceDeclarationFromReExport(entry: SourceImport, name: string): SourceDeclaration {
  return {
    id: `${entry.id}:namespace:${name}`,
    name,
    kind: "namespace",
    filePath: entry.filePath,
    language: entry.language,
    span: entry.span,
    selectionSpan: entry.span,
    exported: true,
    signature: `export * as ${name} from "${entry.rawSpecifier}"`,
  };
}

function publicDeclarationsForReExport(input: {
  readonly reExport: SourceImport;
  readonly surface: SourceSurface;
}): readonly SourceDeclaration[] {
  const importedNames = input.reExport.importedNames;
  const exportedNames = input.reExport.exportedNames ?? [];
  if (importedNames.includes("*")) {
    const namespaceName = exportedNames.find((name) => name !== "*");
    return namespaceName
      ? [namespaceDeclarationFromReExport(input.reExport, namespaceName)]
      : input.surface.declarations;
  }
  if (importedNames.length === 0) {
    return input.surface.declarations;
  }
  return input.surface.declarations.flatMap((declaration) => {
    const index = importedNames.indexOf(declaration.name);
    if (index < 0) return [];
    const exportedName = exportedNames[index] ?? declaration.name;
    return [
      exportedName === declaration.name
        ? declaration
        : {
            ...declaration,
            id: `${declaration.id}:re-export:${input.reExport.id}:${exportedName}`,
            name: exportedName,
            exported: true,
            signature: declaration.signature
              ? declaration.signature.replace(declaration.name, exportedName)
              : declaration.signature,
          },
    ];
  });
}

function collectPackageEntrySpecs(value: unknown): readonly string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(collectPackageEntrySpecs);
  if (value && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).flatMap(collectPackageEntrySpecs);
  }
  return [];
}

function packageSurfaceEntryPaths(directoryPath: string): readonly string[] {
  const packageJsonPath = join(directoryPath, "package.json");
  const entries: string[] = [];
  if (existsSync(packageJsonPath) && isFile(packageJsonPath)) {
    try {
      const manifest = JSON.parse(readFileSync(packageJsonPath, "utf8")) as Record<string, unknown>;
      entries.push(
        ...collectPackageEntrySpecs(manifest.exports),
        ...collectPackageEntrySpecs(manifest.main),
        ...collectPackageEntrySpecs(manifest.module),
        ...collectPackageEntrySpecs(manifest.types),
      );
    } catch {
      // Fall through to index fallback.
    }
  }
  const entryCandidates: string[] = [];
  for (const entry of entries) {
    if (!entry.startsWith(".")) continue;
    const resolved = resolve(directoryPath, entry);
    entryCandidates.push(resolved);
    for (const extension of SOURCE_RESOLUTION_EXTENSIONS) {
      entryCandidates.push(`${resolved}${extension}`);
    }
  }
  const resolvedEntries = entryCandidates.filter(
    (entry) => existsSync(entry) && isFile(entry) && isSourceIntelligenceFile(entry),
  );
  const indexEntries = SOURCE_RESOLUTION_EXTENSIONS.map((extension) =>
    join(directoryPath, `index${extension}`),
  ).filter((entry) => existsSync(entry) && isFile(entry) && isSourceIntelligenceFile(entry));
  return [...new Set([...resolvedEntries, ...indexEntries])];
}

function dedupeDeclarations(
  declarations: readonly SourceDeclaration[],
): readonly SourceDeclaration[] {
  const seen = new Set<string>();
  const out: SourceDeclaration[] = [];
  for (const declaration of declarations) {
    const key = `${normalizePath(declaration.filePath)}:${declaration.kind}:${declaration.name}:${declaration.selectionSpan.startLine}:${declaration.selectionSpan.startColumn}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(declaration);
  }
  return out;
}

function dedupeImports(imports: readonly SourceImport[]): readonly SourceImport[] {
  const seen = new Set<string>();
  const out: SourceImport[] = [];
  for (const sourceImport of imports) {
    const key = `${normalizePath(sourceImport.filePath)}:${sourceImport.kind}:${sourceImport.rawSpecifier}:${sourceImport.span.startLine}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(sourceImport);
  }
  return out;
}

class DefaultSourceIntelligenceEngine implements SourceIntelligenceEngine {
  readonly workspaceRoot: string;
  readonly #maxFiles: number;
  readonly #adapters: ReadonlyMap<SourceLanguage, SourceParserAdapter>;
  readonly #skippedDirectories: ReadonlySet<string>;

  constructor(options: SourceIntelligenceEngineOptions) {
    this.workspaceRoot = normalizePath(options.workspaceRoot);
    this.#maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
    this.#adapters = createAdapterRegistry();
    this.#skippedDirectories = buildSkippedDirectories(options.extraSkippedDirectories);
  }

  async loadDocument(
    filePath: string,
    options: SourceIntelligenceOperationOptions = {},
  ): Promise<SourceDocument> {
    throwIfAborted(options.signal);
    const absolutePath = normalizePath(filePath);
    const stats = statSync(absolutePath);
    if (stats.size > MAX_SOURCE_FILE_BYTES) {
      throw new Error(`Source file too large for source intelligence: ${absolutePath}`);
    }
    const language = detectSourceLanguage(absolutePath);
    if (!language) {
      throw new Error(`Unsupported source language: ${absolutePath}`);
    }
    const adapter = this.#adapters.get(language);
    if (!adapter) {
      throw new Error(`No source-intelligence adapter for language: ${language}`);
    }
    const source = readSourceTextCached(absolutePath);
    const cacheKey = buildParseCacheKey({
      root: this.workspaceRoot,
      filePath: absolutePath,
      language,
      parserVersion: adapter.parserVersion,
      grammarVersion: adapter.grammarVersion,
      sourceHash: source.sourceHash,
    });
    const cached = getCachedSourceDocument(cacheKey);
    if (cached) {
      return cached;
    }
    throwIfAborted(options.signal);
    const parsed = await adapter.parse({
      filePath: absolutePath,
      language: isTypeScriptFamily(language) ? language : adapter.language,
      sourceText: source.sourceText,
      sourceHash: source.sourceHash,
    });
    throwIfAborted(options.signal);
    setCachedSourceDocument(cacheKey, parsed);
    return parsed;
  }

  async listSourceFilePaths(
    paths?: readonly string[],
    options: SourceIntelligenceOperationOptions = {},
  ): Promise<SourceFileListing> {
    const roots = candidateRoots(this.workspaceRoot, paths);
    const maxFiles = options.maxFiles ?? this.#maxFiles;
    const files: string[] = [];
    let truncated = false;
    for (const [index, root] of roots.entries()) {
      throwIfAborted(options.signal);
      const remaining = Math.max(0, maxFiles - files.length);
      if (remaining === 0) {
        truncated = true;
        break;
      }
      const listing = findSourceFiles(root, remaining, this.#skippedDirectories, options);
      files.push(...listing.files);
      truncated = truncated || listing.truncated;
      if (files.length >= maxFiles) {
        truncated = truncated || index < roots.length - 1;
        break;
      }
    }
    const unique = [...new Set(files.map(normalizePath))].toSorted((left, right) =>
      relative(this.workspaceRoot, left).localeCompare(relative(this.workspaceRoot, right)),
    );
    return { files: unique, truncated };
  }

  async listDocuments(
    paths?: readonly string[],
    options: SourceIntelligenceOperationOptions = {},
  ): Promise<readonly SourceDocument[]> {
    const listing = await this.listSourceFilePaths(paths, options);
    return mapWithConcurrency(
      listing.files,
      options.loadConcurrency ?? DEFAULT_LOAD_CONCURRENCY,
      options.signal,
      (filePath) => this.loadDocument(filePath, options),
    );
  }

  async buildGraph(
    paths?: readonly string[],
    options: SourceIntelligenceOperationOptions = {},
  ): Promise<SourceGraph> {
    throwIfAborted(options.signal);
    const roots = candidateRoots(this.workspaceRoot, paths);
    const documents = await this.listDocuments(paths, options);
    const key = graphCacheKey(this.workspaceRoot, roots, documents);
    const cached = getCachedSourceGraph(key);
    if (cached) {
      return cached;
    }
    throwIfAborted(options.signal);
    const edges: SourceGraphEdge[] = [];
    for (const document of documents) {
      throwIfAborted(options.signal);
      for (const sourceImport of document.imports) {
        const toPath = resolveImportTarget(this.workspaceRoot, document, sourceImport);
        edges.push(buildImportEdge({ document, sourceImport, toPath, index: edges.length }));
      }
    }
    const graph: SourceGraph = {
      root: this.workspaceRoot,
      documents,
      edges,
      reverseEdges: buildReverseEdges(edges),
      cycles: detectCycles(edges),
      diagnostics: documents.flatMap((document) => document.diagnostics),
    };
    setCachedSourceGraph(key, graph);
    return graph;
  }

  async resolveSurface(
    path: string,
    options: SourceIntelligenceOperationOptions = {},
  ): Promise<SourceSurface> {
    throwIfAborted(options.signal);
    const absolutePath = normalizePath(path);
    if (isDirectory(absolutePath)) {
      const entryPaths = packageSurfaceEntryPaths(absolutePath);
      if (entryPaths.length > 0) {
        const surfaces = await Promise.all(
          entryPaths.map((entryPath) =>
            this.#resolveFileSurface(entryPath, new Set<string>(), options),
          ),
        );
        return {
          path: absolutePath,
          declarations: dedupeDeclarations(
            surfaces.flatMap((surface) => [...surface.declarations]),
          ),
          reExports: dedupeImports(surfaces.flatMap((surface) => [...surface.reExports])),
          diagnostics: surfaces.flatMap((surface) => surface.diagnostics),
        };
      }
      const graph = await this.buildGraph([relative(this.workspaceRoot, absolutePath)], options);
      return {
        path: absolutePath,
        declarations: graph.documents.flatMap((document) => [...publicDeclarations(document)]),
        reExports: graph.documents.flatMap((document) =>
          document.imports.filter((entry) => entry.kind === "re-export"),
        ),
        diagnostics: graph.diagnostics,
      };
    }
    return this.#resolveFileSurface(absolutePath, new Set<string>(), options);
  }

  async findCallers(
    input: SourceCallQuery,
    options: SourceIntelligenceOperationOptions = {},
  ): Promise<readonly SourceGraphEdge[]> {
    return buildCallers(await this.buildGraph(undefined, options), input);
  }

  async findCallees(
    input: SourceCallQuery,
    options: SourceIntelligenceOperationOptions = {},
  ): Promise<readonly SourceGraphEdge[]> {
    return buildCallees(await this.buildGraph(undefined, options), input);
  }

  async #resolveFileSurface(
    path: string,
    seen: Set<string>,
    options: SourceIntelligenceOperationOptions,
  ): Promise<SourceSurface> {
    throwIfAborted(options.signal);
    const absolutePath = normalizePath(path);
    if (seen.has(absolutePath)) {
      return {
        path: absolutePath,
        declarations: [],
        reExports: [],
        diagnostics: [],
      };
    }
    seen.add(absolutePath);
    const document = await this.loadDocument(absolutePath, options);
    const reExports = document.imports.filter((entry) => entry.kind === "re-export");
    const childSurfaces = await Promise.all(
      reExports.flatMap((entry) => {
        const target = resolveImportTarget(this.workspaceRoot, document, entry);
        return target
          ? [
              this.#resolveFileSurface(target, seen, options).then((surface) => ({
                reExport: entry,
                surface,
              })),
            ]
          : [];
      }),
    );
    return {
      path: absolutePath,
      declarations: dedupeDeclarations([
        ...publicDeclarations(document),
        ...childSurfaces.flatMap((entry) => [
          ...publicDeclarationsForReExport({
            reExport: entry.reExport,
            surface: entry.surface,
          }),
        ]),
      ]),
      reExports: dedupeImports([
        ...reExports,
        ...childSurfaces.flatMap((entry) => [...entry.surface.reExports]),
      ]),
      diagnostics: [
        ...document.diagnostics,
        ...childSurfaces.flatMap((entry) => entry.surface.diagnostics),
      ],
    };
  }
}

export function createSourceIntelligenceEngine(
  options: SourceIntelligenceEngineOptions,
): SourceIntelligenceEngine {
  return new DefaultSourceIntelligenceEngine(options);
}

export function buildSourceDependencyGraph(
  engine: SourceIntelligenceEngine,
  paths?: readonly string[],
): Promise<SourceGraph> {
  return engine.buildGraph(paths);
}
