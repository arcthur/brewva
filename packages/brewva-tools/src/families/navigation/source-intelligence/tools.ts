import { existsSync, statSync } from "node:fs";
import { basename } from "node:path";
import { scoreDocumentsByTfIdf, type TfIdfSearchDocument } from "@brewva/brewva-search";
import type { BrewvaToolDefinition as ToolDefinition } from "@brewva/brewva-substrate/tools";
import { estimateTokenCount } from "@brewva/brewva-token-estimation";
import { Type } from "@sinclair/typebox";
import type { BrewvaBundledToolRuntime } from "../../../contracts/index.js";
import { createRuntimeBoundBrewvaToolFactory } from "../../../registry/runtime-bound-tool.js";
import { registerToolRuntimeClearStateListener } from "../../../runtime-port/extensions.js";
import { getToolSessionId } from "../../../runtime-port/parallel-read.js";
import { resolveScopedPath, resolveToolTargetScope } from "../../../runtime-port/target-scope.js";
import { failTextResult, textResult } from "../../../utils/result.js";
import { normalizeSearchAdvisorPath, registerSearchIntent } from "../search-advisor.js";
import {
  clearSourceIntelligenceCaches,
  createSourceIntelligenceEngine,
  type SourceIntelligenceEngine,
} from "./engine.js";
import {
  recordSourceIntelligenceEvent,
  recordSourceIntelligenceReadPathObservation,
} from "./events.js";
import type { SourceDocument, SourceGraph, SourceGraphEdge } from "./ir.js";
import {
  renderCycles,
  renderDigest,
  renderDigestDocument,
  renderGraphEdges,
  renderOutline,
  renderSurface,
} from "./render/text.js";

const DEFAULT_DIGEST_LIMIT = 20;
const DEFAULT_DIGEST_BUDGET = 2_000;
const DEFAULT_DIGEST_SCAN_LIMIT = 80;
const MAX_DIGEST_SCAN_LIMIT = 240;
const MAX_DIGEST_BUDGET = 20_000;
const MAX_DIGEST_LIMIT = 200;
const DEFAULT_EDGE_LIMIT = 120;
const MAX_EDGE_LIMIT = 1_000;
const DEFAULT_CYCLE_LIMIT = 50;
const MAX_CYCLE_LIMIT = 500;
const DEFAULT_DETAIL_LIMIT = 200;
const DIGEST_DISPLAY_SUMMARY_LINE_LIMIT = 5;
const SOURCE_INTELLIGENCE_EXECUTION_TRAITS = {
  concurrencySafe: true,
  interruptBehavior: "cancel",
  streamingEligible: false,
  contextModifying: false,
} as const;
const SOURCE_INTELLIGENCE_TOOL_SKIPPED_DIRECTORIES = [
  ".brewva",
  ".brewva-build-cache",
  ".config",
  ".cursor",
  ".factory",
  ".orchestrator",
  ".repos",
  ".worktrees",
  "distribution",
] as const;

const ENGINE_CACHE = new Map<string, SourceIntelligenceEngine>();

function engineForRoot(workspaceRoot: string): SourceIntelligenceEngine {
  const cached = ENGINE_CACHE.get(workspaceRoot);
  if (cached) return cached;
  const engine = createSourceIntelligenceEngine({
    workspaceRoot,
    extraSkippedDirectories: SOURCE_INTELLIGENCE_TOOL_SKIPPED_DIRECTORIES,
  });
  ENGINE_CACHE.set(workspaceRoot, engine);
  return engine;
}

function clampInteger(
  value: unknown,
  fallback: number,
  options: { readonly min: number; readonly max: number },
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(options.min, Math.min(options.max, Math.trunc(value)));
}

function resolveToolPaths(input: {
  readonly entries: readonly string[] | undefined;
  readonly baseCwd: string;
  readonly scope: ReturnType<typeof resolveToolTargetScope>;
}): string[] | null {
  const requested = input.entries && input.entries.length > 0 ? input.entries : ["."];
  const out: string[] = [];
  for (const entry of requested) {
    const resolved = resolveScopedPath(entry, input.scope, { relativeTo: input.baseCwd });
    if (!resolved) {
      return null;
    }
    out.push(resolved);
  }
  return [...new Set(out)];
}

function ensureExistingFile(filePath: string): string | null {
  if (!existsSync(filePath)) {
    return `Error: File not found: ${filePath}`;
  }
  try {
    if (!statSync(filePath).isFile()) {
      return `Error: Path is not a file: ${filePath}`;
    }
  } catch (error) {
    return `Error: ${error instanceof Error ? error.message : String(error)}`;
  }
  return null;
}

function ensureExistingPath(path: string): string | null {
  if (!existsSync(path)) {
    return `Error: Path not found: ${path}`;
  }
  try {
    statSync(path);
  } catch (error) {
    return `Error: ${error instanceof Error ? error.message : String(error)}`;
  }
  return null;
}

function sourceIntelligenceError(error: unknown): string {
  return `Error: ${error instanceof Error ? error.message : String(error)}`;
}

function summarizeDigestDisplay(text: string): string {
  const lines: string[] = [];
  let start = 0;
  for (let line = 0; line < DIGEST_DISPLAY_SUMMARY_LINE_LIMIT; line += 1) {
    const nextBreak = text.indexOf("\n", start);
    if (nextBreak < 0) {
      const tail = text.slice(start);
      if (tail.length > 0) {
        lines.push(tail);
      }
      break;
    }
    lines.push(text.slice(start, nextBreak));
    start = nextBreak + 1;
  }
  return lines.join("\n");
}

function digestScanLimit(input: { readonly query?: string; readonly limit: number }): number {
  if (input.query && input.query.trim().length > 0) {
    return Math.min(MAX_DIGEST_SCAN_LIMIT, Math.max(DEFAULT_DIGEST_SCAN_LIMIT, input.limit * 3));
  }
  return MAX_DIGEST_SCAN_LIMIT;
}

function emptyGraph(root: string): SourceGraph {
  return {
    root,
    documents: [],
    edges: [],
    reverseEdges: [],
    cycles: [],
    diagnostics: [],
  };
}

function documentSearchText(document: SourceDocument): string {
  return [
    document.filePath,
    document.language,
    ...document.imports.map((entry) => entry.rawSpecifier),
    ...document.declarations.map((entry) => `${entry.kind} ${entry.name}`),
    ...document.calls.map((entry) => entry.callee),
  ].join("\n");
}

function prioritizeDigestFilePaths(files: readonly string[]): readonly string[] {
  return [...files].toSorted((left, right) => {
    const leftManifest = basename(left) === "package.json";
    const rightManifest = basename(right) === "package.json";
    if (leftManifest !== rightManifest) {
      return leftManifest ? -1 : 1;
    }
    return left.localeCompare(right);
  });
}

function orderDocumentsByFilePaths(
  documents: readonly SourceDocument[],
  filePaths: readonly string[],
): readonly SourceDocument[] {
  const order = new Map(filePaths.map((filePath, index) => [filePath, index]));
  return [...documents].toSorted((left, right) => {
    const leftOrder = order.get(left.filePath) ?? Number.MAX_SAFE_INTEGER;
    const rightOrder = order.get(right.filePath) ?? Number.MAX_SAFE_INTEGER;
    if (leftOrder !== rightOrder) {
      return leftOrder - rightOrder;
    }
    return left.filePath.localeCompare(right.filePath);
  });
}

function selectDigestDocuments(input: {
  readonly documents: readonly SourceDocument[];
  readonly query?: string;
  readonly limit: number;
  readonly budget: number;
  readonly baseCwd: string;
}): { readonly documents: readonly SourceDocument[]; readonly omittedFiles: number } {
  const docs: readonly SourceDocument[] =
    input.query && input.query.trim().length > 0
      ? scoreDocumentsByTfIdf(
          input.query,
          input.documents.map<TfIdfSearchDocument<SourceDocument>>((document) => ({
            id: document.filePath,
            text: documentSearchText(document),
            metadata: document,
          })),
          { limit: input.limit },
        )
          .map((result) => result.document.metadata)
          .filter((document): document is SourceDocument => Boolean(document))
      : input.documents.slice(0, input.limit);
  const ranked = docs.length > 0 ? docs : input.documents.slice(0, input.limit);
  const selected: SourceDocument[] = [];
  let usedTokens = 0;
  for (const document of ranked) {
    const tokenEstimate = estimateTokenCount(renderDigestDocument(document, input.baseCwd), {
      encoding: "o200k_base",
    });
    if (selected.length > 0 && usedTokens + tokenEstimate > input.budget) {
      break;
    }
    selected.push(document);
    usedTokens += tokenEstimate;
  }
  return {
    documents: selected,
    omittedFiles: Math.max(0, input.documents.length - selected.length),
  };
}

function observedGraphPaths(edges: readonly SourceGraphEdge[]): readonly string[] {
  return edges.flatMap((edge) => (edge.toPath ? [edge.fromPath, edge.toPath] : [edge.fromPath]));
}

function omittedDeclarationCount(
  allDocuments: readonly SourceDocument[],
  includedDocuments: readonly SourceDocument[],
): number {
  return allDocuments
    .filter((document) => !includedDocuments.includes(document))
    .reduce((total, document) => total + document.declarations.length, 0);
}

const CLEAR_STATE_ATTACHED_RUNTIMES = new WeakSet<object>();

function registerToolClearState(runtime?: BrewvaBundledToolRuntime): void {
  if (!runtime || CLEAR_STATE_ATTACHED_RUNTIMES.has(runtime as object)) {
    return;
  }
  CLEAR_STATE_ATTACHED_RUNTIMES.add(runtime as object);
  registerToolRuntimeClearStateListener(runtime, () => {
    clearSourceIntelligenceCaches();
    ENGINE_CACHE.clear();
  });
}

export function createSourceIntelligenceTools(options?: {
  readonly runtime?: BrewvaBundledToolRuntime;
}): ToolDefinition[] {
  registerToolClearState(options?.runtime);

  const codeOutlineFactory = createRuntimeBoundBrewvaToolFactory(options?.runtime, "code_outline");
  const codeDigestFactory = createRuntimeBoundBrewvaToolFactory(options?.runtime, "code_digest");
  const codeSurfaceFactory = createRuntimeBoundBrewvaToolFactory(options?.runtime, "code_surface");
  const codeDepsFactory = createRuntimeBoundBrewvaToolFactory(options?.runtime, "code_deps");
  const codeReverseDepsFactory = createRuntimeBoundBrewvaToolFactory(
    options?.runtime,
    "code_reverse_deps",
  );
  const codeCyclesFactory = createRuntimeBoundBrewvaToolFactory(options?.runtime, "code_cycles");
  const codeCallersFactory = createRuntimeBoundBrewvaToolFactory(options?.runtime, "code_callers");
  const codeCalleesFactory = createRuntimeBoundBrewvaToolFactory(options?.runtime, "code_callees");

  const codeOutline = codeOutlineFactory.define(
    {
      name: "code_outline",
      label: "Code Outline",
      description:
        "Default language-neutral entry for one source file: imports, declarations, calls, diagnostics, and line spans. Use code_digest for directories and code_surface for public API only.",
      parameters: Type.Object({
        file_path: Type.String({ minLength: 1 }),
      }),
      async execute(_id, params, signal, _onUpdate, ctx) {
        const scope = resolveToolTargetScope(codeOutlineFactory.runtime, ctx);
        const absolutePath = resolveScopedPath(params.file_path, scope);
        if (!absolutePath) {
          return failTextResult(
            `code_outline rejected: path escapes target roots (${scope.allowedRoots.join(", ")}).`,
          );
        }
        const fileError = ensureExistingFile(absolutePath);
        if (fileError) {
          return failTextResult(fileError);
        }
        const sessionId = getToolSessionId(ctx);
        const engine = engineForRoot(scope.primaryRoot);
        const startedAt = Date.now();
        let document: Awaited<ReturnType<typeof engine.loadDocument>>;
        try {
          document = await engine.loadDocument(absolutePath, { signal });
        } catch (error) {
          return failTextResult(sourceIntelligenceError(error));
        }
        recordSourceIntelligenceReadPathObservation({
          runtime: codeOutlineFactory.runtime,
          sessionId,
          baseCwd: scope.baseCwd,
          toolName: "code_outline",
          evidenceKind: "direct_file_access",
          observedPaths: [absolutePath],
        });
        recordSourceIntelligenceEvent(codeOutlineFactory.runtime, sessionId, {
          toolName: "code_outline",
          operation: "outline",
          filePath: absolutePath,
          language: document.language,
          declarationsCount: document.declarations.length,
          importsCount: document.imports.length,
          callsCount: document.calls.length,
          diagnosticsCount: document.diagnostics.length,
          durationMs: Date.now() - startedAt,
        });
        return textResult(renderOutline(document, scope.baseCwd), {
          status: "ok",
          filePath: absolutePath,
          language: document.language,
          importsCount: document.imports.length,
          declarationsCount: document.declarations.length,
          callsCount: document.calls.length,
          diagnosticsCount: document.diagnostics.length,
          spans: document.declarations.slice(0, DEFAULT_DETAIL_LIMIT).map((entry) => ({
            name: entry.name,
            kind: entry.kind,
            span: entry.selectionSpan,
          })),
          omittedSpans: Math.max(0, document.declarations.length - DEFAULT_DETAIL_LIMIT),
        });
      },
    },
    { executionTraits: SOURCE_INTELLIGENCE_EXECUTION_TRAITS },
  );

  const codeDigest = codeDigestFactory.define(
    {
      name: "code_digest",
      label: "Code Digest",
      description:
        "Build a token-budgeted structural digest across source paths using Brewva search tokenization and token estimation.",
      parameters: Type.Object({
        paths: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: 50 })),
        query: Type.Optional(Type.String()),
        max_tokens: Type.Optional(
          Type.Integer({
            minimum: 100,
            maximum: MAX_DIGEST_BUDGET,
            default: DEFAULT_DIGEST_BUDGET,
          }),
        ),
        limit: Type.Optional(
          Type.Integer({ minimum: 1, maximum: MAX_DIGEST_LIMIT, default: DEFAULT_DIGEST_LIMIT }),
        ),
      }),
      async execute(_id, params, signal, _onUpdate, ctx) {
        const scope = resolveToolTargetScope(codeDigestFactory.runtime, ctx);
        const roots = resolveToolPaths({
          entries: params.paths,
          baseCwd: scope.baseCwd,
          scope,
        });
        if (!roots) {
          return failTextResult(
            `code_digest rejected: paths escape target roots (${scope.allowedRoots.join(", ")}).`,
          );
        }
        const missingRoot = roots.map((root) => ensureExistingPath(root)).find(Boolean);
        if (missingRoot) {
          return failTextResult(missingRoot);
        }
        const sessionId = getToolSessionId(ctx);
        const startedAt = Date.now();
        const budget = clampInteger(params.max_tokens, DEFAULT_DIGEST_BUDGET, {
          min: 100,
          max: MAX_DIGEST_BUDGET,
        });
        const limit = clampInteger(params.limit, DEFAULT_DIGEST_LIMIT, {
          min: 1,
          max: MAX_DIGEST_LIMIT,
        });
        const engine = engineForRoot(scope.primaryRoot);
        const scanLimit = digestScanLimit({ query: params.query, limit });
        if (params.query && params.query.trim().length > 0) {
          registerSearchIntent({
            runtime: codeDigestFactory.runtime,
            sessionId,
            toolName: "code_digest",
            query: params.query,
            requestedPaths: roots
              .map((root) => normalizeSearchAdvisorPath(scope.baseCwd, root))
              .filter((root): root is string => Boolean(root)),
          });
        }
        let graph: Awaited<ReturnType<typeof engine.buildGraph>>;
        let orderedDocuments: readonly SourceDocument[] = [];
        let listedFileCount = 0;
        let listingTruncated = false;
        try {
          const listing = await engine.listSourceFilePaths(roots, {
            signal,
            maxFiles: scanLimit,
          });
          const candidateFiles = prioritizeDigestFilePaths(listing.files);
          listedFileCount = candidateFiles.length;
          listingTruncated = listing.truncated;
          const graphPaths =
            params.query && params.query.trim().length > 0
              ? candidateFiles
              : candidateFiles.slice(0, limit);
          graph =
            graphPaths.length > 0
              ? await engine.buildGraph(graphPaths, {
                  signal,
                  maxFiles: graphPaths.length,
                })
              : emptyGraph(scope.primaryRoot);
          orderedDocuments = orderDocumentsByFilePaths(graph.documents, graphPaths);
        } catch (error) {
          return failTextResult(sourceIntelligenceError(error));
        }
        const selected = selectDigestDocuments({
          documents: orderedDocuments,
          query: params.query,
          limit,
          budget,
          baseCwd: scope.baseCwd,
        });
        recordSourceIntelligenceReadPathObservation({
          runtime: codeDigestFactory.runtime,
          sessionId,
          baseCwd: scope.baseCwd,
          toolName: "code_digest",
          evidenceKind: "digest",
          observedPaths: selected.documents.map((document) => document.filePath),
        });
        recordSourceIntelligenceEvent(codeDigestFactory.runtime, sessionId, {
          toolName: "code_digest",
          operation: "digest",
          roots,
          query: params.query,
          files: selected.documents.length,
          totalFiles: listedFileCount,
          budgetTokens: budget,
          durationMs: Date.now() - startedAt,
        });
        let digestDocuments = selected.documents;
        let omittedDeclarations = omittedDeclarationCount(graph.documents, digestDocuments);
        const omittedFiles = Math.max(0, listedFileCount - digestDocuments.length);
        let renderedDigest = renderDigest({
          baseCwd: scope.baseCwd,
          root: roots[0] ?? scope.primaryRoot,
          budget,
          documents: digestDocuments,
          graph,
          omittedFiles,
          omittedDeclarations,
        });
        let renderedTokens = estimateTokenCount(renderedDigest, { encoding: "o200k_base" });
        while (digestDocuments.length > 1 && renderedTokens > budget) {
          digestDocuments = digestDocuments.slice(0, -1);
          omittedDeclarations = omittedDeclarationCount(graph.documents, digestDocuments);
          renderedDigest = renderDigest({
            baseCwd: scope.baseCwd,
            root: roots[0] ?? scope.primaryRoot,
            budget,
            documents: digestDocuments,
            graph,
            omittedFiles: Math.max(0, listedFileCount - digestDocuments.length),
            omittedDeclarations,
          });
          renderedTokens = estimateTokenCount(renderedDigest, { encoding: "o200k_base" });
        }
        if (renderedTokens > budget) {
          renderedDigest = renderDigest({
            baseCwd: scope.baseCwd,
            root: roots[0] ?? scope.primaryRoot,
            budget,
            documents: digestDocuments,
            graph,
            omittedFiles: Math.max(0, listedFileCount - digestDocuments.length),
            omittedDeclarations,
            graphHintLimit: 0,
          });
          renderedTokens = estimateTokenCount(renderedDigest, { encoding: "o200k_base" });
        }
        return textResult(
          renderedDigest,
          {
            status: "ok",
            root: roots[0] ?? scope.primaryRoot,
            budget: {
              maxTokens: budget,
              renderedTokens,
              estimator: "@brewva/brewva-token-estimation",
            },
            files: digestDocuments.map((document) => ({
              path: document.filePath,
              language: document.language,
              declarations: document.declarations.length,
              imports: document.imports.length,
            })),
            diagnostics: graph.diagnostics.length,
            omitted: {
              files: Math.max(0, listedFileCount - digestDocuments.length),
              declarations: omittedDeclarations,
              listingTruncated,
            },
          },
          {
            summaryText: summarizeDigestDisplay(renderedDigest),
          },
        );
      },
    },
    { executionTraits: SOURCE_INTELLIGENCE_EXECUTION_TRAITS },
  );

  const codeSurface = codeSurfaceFactory.define(
    {
      name: "code_surface",
      label: "Code Surface",
      description:
        "Resolve public source surface for a file or directory, including TS/JS re-exports and Python __all__ style exports.",
      parameters: Type.Object({
        path: Type.String({ minLength: 1 }),
      }),
      async execute(_id, params, signal, _onUpdate, ctx) {
        const scope = resolveToolTargetScope(codeSurfaceFactory.runtime, ctx);
        const absolutePath = resolveScopedPath(params.path, scope);
        if (!absolutePath) {
          return failTextResult(
            `code_surface rejected: path escapes target roots (${scope.allowedRoots.join(", ")}).`,
          );
        }
        const pathError = ensureExistingPath(absolutePath);
        if (pathError) {
          return failTextResult(pathError);
        }
        const engine = engineForRoot(scope.primaryRoot);
        let surface: Awaited<ReturnType<typeof engine.resolveSurface>>;
        try {
          surface = await engine.resolveSurface(absolutePath, { signal });
        } catch (error) {
          return failTextResult(sourceIntelligenceError(error));
        }
        const sessionId = getToolSessionId(ctx);
        recordSourceIntelligenceEvent(codeSurfaceFactory.runtime, sessionId, {
          toolName: "code_surface",
          operation: "surface",
          path: absolutePath,
          declarationsCount: surface.declarations.length,
          reExportsCount: surface.reExports.length,
        });
        return textResult(renderSurface(surface, scope.baseCwd), {
          status: "ok",
          path: absolutePath,
          declarations: surface.declarations.slice(0, DEFAULT_DETAIL_LIMIT),
          reExports: surface.reExports.slice(0, DEFAULT_DETAIL_LIMIT),
          diagnostics: surface.diagnostics.slice(0, DEFAULT_DETAIL_LIMIT),
          omittedDeclarations: Math.max(0, surface.declarations.length - DEFAULT_DETAIL_LIMIT),
          omittedReExports: Math.max(0, surface.reExports.length - DEFAULT_DETAIL_LIMIT),
          omittedDiagnostics: Math.max(0, surface.diagnostics.length - DEFAULT_DETAIL_LIMIT),
        });
      },
    },
    { executionTraits: SOURCE_INTELLIGENCE_EXECUTION_TRAITS },
  );

  const buildGraphTool = (
    factory: typeof codeDepsFactory,
    name: "code_deps" | "code_reverse_deps",
    reverse: boolean,
  ): ToolDefinition =>
    factory.define(
      {
        name,
        label: reverse ? "Code Reverse Dependencies" : "Code Dependencies",
        description: reverse
          ? "Return reverse source dependency edges from the shared source-intelligence graph."
          : "Return forward source dependency edges from the shared source-intelligence graph.",
        parameters: Type.Object({
          paths: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: 50 })),
          max_edges: Type.Optional(
            Type.Integer({ minimum: 1, maximum: MAX_EDGE_LIMIT, default: DEFAULT_EDGE_LIMIT }),
          ),
        }),
        async execute(_id, params, signal, _onUpdate, ctx) {
          const scope = resolveToolTargetScope(factory.runtime, ctx);
          const roots = resolveToolPaths({
            entries: params.paths,
            baseCwd: scope.baseCwd,
            scope,
          });
          if (!roots) {
            return failTextResult(
              `${name} rejected: paths escape target roots (${scope.allowedRoots.join(", ")}).`,
            );
          }
          const missingRoot = roots.map((root) => ensureExistingPath(root)).find(Boolean);
          if (missingRoot) {
            return failTextResult(missingRoot);
          }
          const maxEdges = clampInteger(params.max_edges, DEFAULT_EDGE_LIMIT, {
            min: 1,
            max: MAX_EDGE_LIMIT,
          });
          const sessionId = getToolSessionId(ctx);
          const engine = engineForRoot(scope.primaryRoot);
          let graph: Awaited<ReturnType<typeof engine.buildGraph>>;
          try {
            graph = await engine.buildGraph(roots, { signal });
          } catch (error) {
            return failTextResult(sourceIntelligenceError(error));
          }
          const edges = reverse ? graph.reverseEdges : graph.edges;
          recordSourceIntelligenceReadPathObservation({
            runtime: factory.runtime,
            sessionId,
            baseCwd: scope.baseCwd,
            toolName: name,
            evidenceKind: reverse ? "reverse_dependency_graph" : "dependency_graph",
            observedPaths: observedGraphPaths(edges),
          });
          recordSourceIntelligenceEvent(factory.runtime, sessionId, {
            toolName: name,
            operation: reverse ? "reverse_deps" : "deps",
            edges: edges.length,
            roots,
          });
          return textResult(
            renderGraphEdges({
              title: reverse ? "[CodeReverseDeps]" : "[CodeDeps]",
              baseCwd: scope.baseCwd,
              edges,
              limit: maxEdges,
            }),
            {
              status: "ok",
              roots,
              edges: edges.slice(0, maxEdges),
              omittedEdges: Math.max(0, edges.length - maxEdges),
            },
          );
        },
      },
      { executionTraits: SOURCE_INTELLIGENCE_EXECUTION_TRAITS },
    );

  const codeDeps = buildGraphTool(codeDepsFactory, "code_deps", false);
  const codeReverseDeps = buildGraphTool(codeReverseDepsFactory, "code_reverse_deps", true);

  const codeCycles = codeCyclesFactory.define(
    {
      name: "code_cycles",
      label: "Code Cycles",
      description: "Return import cycles from the source-intelligence dependency graph.",
      parameters: Type.Object({
        paths: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: 50 })),
        max_cycles: Type.Optional(
          Type.Integer({ minimum: 1, maximum: MAX_CYCLE_LIMIT, default: DEFAULT_CYCLE_LIMIT }),
        ),
      }),
      async execute(_id, params, signal, _onUpdate, ctx) {
        const scope = resolveToolTargetScope(codeCyclesFactory.runtime, ctx);
        const roots = resolveToolPaths({
          entries: params.paths,
          baseCwd: scope.baseCwd,
          scope,
        });
        if (!roots) {
          return failTextResult(
            `code_cycles rejected: paths escape target roots (${scope.allowedRoots.join(", ")}).`,
          );
        }
        const missingRoot = roots.map((root) => ensureExistingPath(root)).find(Boolean);
        if (missingRoot) {
          return failTextResult(missingRoot);
        }
        const maxCycles = clampInteger(params.max_cycles, DEFAULT_CYCLE_LIMIT, {
          min: 1,
          max: MAX_CYCLE_LIMIT,
        });
        const sessionId = getToolSessionId(ctx);
        const engine = engineForRoot(scope.primaryRoot);
        let graph: Awaited<ReturnType<typeof engine.buildGraph>>;
        try {
          graph = await engine.buildGraph(roots, { signal });
        } catch (error) {
          return failTextResult(sourceIntelligenceError(error));
        }
        recordSourceIntelligenceEvent(codeCyclesFactory.runtime, sessionId, {
          toolName: "code_cycles",
          operation: "cycles",
          cycles: graph.cycles.length,
          roots,
        });
        return textResult(renderCycles(graph, scope.baseCwd, maxCycles), {
          status: "ok",
          roots,
          cycles: graph.cycles.slice(0, maxCycles),
          omittedCycles: Math.max(0, graph.cycles.length - maxCycles),
        });
      },
    },
    { executionTraits: SOURCE_INTELLIGENCE_EXECUTION_TRAITS },
  );

  const buildCallGraphTool = (
    factory: typeof codeCallersFactory,
    name: "code_callers" | "code_callees",
  ): ToolDefinition =>
    factory.define(
      {
        name,
        label: name === "code_callers" ? "Code Callers" : "Code Callees",
        description:
          name === "code_callers"
            ? "Return callers for a symbol with exact, inferred, or ambiguous confidence. Ambiguous edges are observations only."
            : "Return callees for a symbol/file with exact, inferred, or ambiguous confidence. Ambiguous edges are observations only.",
        parameters: Type.Object({
          symbol: Type.String({ minLength: 1 }),
          file_path: Type.Optional(Type.String({ minLength: 1 })),
          line: Type.Optional(Type.Integer({ minimum: 1 })),
          max_edges: Type.Optional(
            Type.Integer({ minimum: 1, maximum: MAX_EDGE_LIMIT, default: DEFAULT_EDGE_LIMIT }),
          ),
        }),
        async execute(_id, params, signal, _onUpdate, ctx) {
          const scope = resolveToolTargetScope(factory.runtime, ctx);
          const absolutePath = params.file_path
            ? resolveScopedPath(params.file_path, scope)
            : undefined;
          if (params.file_path && !absolutePath) {
            return failTextResult(
              `${name} rejected: file_path escapes target roots (${scope.allowedRoots.join(", ")}).`,
            );
          }
          if (absolutePath) {
            const fileError = ensureExistingFile(absolutePath);
            if (fileError) {
              return failTextResult(fileError);
            }
          }
          const maxEdges = clampInteger(params.max_edges, DEFAULT_EDGE_LIMIT, {
            min: 1,
            max: MAX_EDGE_LIMIT,
          });
          const sessionId = getToolSessionId(ctx);
          const engine = engineForRoot(scope.primaryRoot);
          let edges: readonly SourceGraphEdge[];
          try {
            edges =
              name === "code_callers"
                ? await engine.findCallers(
                    {
                      symbol: params.symbol,
                      filePath: absolutePath ?? undefined,
                      line: params.line,
                    },
                    { signal },
                  )
                : await engine.findCallees(
                    {
                      symbol: params.symbol,
                      filePath: absolutePath ?? undefined,
                      line: params.line,
                    },
                    { signal },
                  );
          } catch (error) {
            return failTextResult(sourceIntelligenceError(error));
          }
          recordSourceIntelligenceReadPathObservation({
            runtime: factory.runtime,
            sessionId,
            baseCwd: scope.baseCwd,
            toolName: name,
            evidenceKind: name === "code_callers" ? "callers" : "callees",
            observedPaths: observedGraphPaths(edges),
          });
          recordSourceIntelligenceEvent(factory.runtime, sessionId, {
            toolName: name,
            operation: name === "code_callers" ? "callers" : "callees",
            symbol: params.symbol,
            filePath: absolutePath ?? undefined,
            edges: edges.length,
            ambiguousEdges: edges.filter((edge) => edge.confidence === "ambiguous").length,
          });
          return textResult(
            renderGraphEdges({
              title: name === "code_callers" ? "[CodeCallers]" : "[CodeCallees]",
              baseCwd: scope.baseCwd,
              edges,
              limit: maxEdges,
            }),
            {
              status: "ok",
              symbol: params.symbol,
              filePath: absolutePath,
              edges: edges.slice(0, maxEdges),
              omittedEdges: Math.max(0, edges.length - maxEdges),
            },
          );
        },
      },
      { executionTraits: SOURCE_INTELLIGENCE_EXECUTION_TRAITS },
    );

  const codeCallers = buildCallGraphTool(codeCallersFactory, "code_callers");
  const codeCallees = buildCallGraphTool(codeCalleesFactory, "code_callees");

  return [
    codeOutline,
    codeDigest,
    codeSurface,
    codeDeps,
    codeReverseDeps,
    codeCycles,
    codeCallers,
    codeCallees,
  ];
}
