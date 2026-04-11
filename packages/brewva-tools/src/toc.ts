import { existsSync, statSync } from "node:fs";
import { TOOL_READ_PATH_DISCOVERY_OBSERVED_EVENT_TYPE } from "@brewva/brewva-runtime";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { buildReadPathDiscoveryObservationPayload } from "./read-path-discovery.js";
import {
  recordToolRuntimeEvent,
  registerToolRuntimeClearStateListener,
} from "./runtime-internal.js";
import {
  attachSearchIntentPreviewCandidates,
  normalizeSearchAdvisorPath,
  registerSearchIntent,
} from "./search-advisor.js";
import { resolveScopedPath, resolveToolTargetScope, type ToolTargetScope } from "./target-scope.js";
import {
  readSourceTextWithCache,
  registerTocSourceCacheRuntime,
  resolveTocSessionKey,
} from "./toc-cache.js";
import {
  DEFAULT_TOC_SEARCH_LIMIT,
  MAX_TOC_FILE_BYTES,
  MAX_TOC_SEARCH_CANDIDATE_FILES,
  MAX_TOC_SEARCH_INDEXED_BYTES,
  MAX_TOC_SEARCH_LIMIT,
  createTocSearchSessionCacheStore,
  formatLineSpan,
  lookupTocDocument,
  normalizeRelativePath,
  runTocSearchCore,
  supportsToc,
  type TocDocument,
  type TocSearchMatch,
  type TocSearchSessionCacheStore,
  type TocSearchSummary,
} from "./toc-search-core.js";
import type { BrewvaBundledToolRuntime } from "./types.js";
import { getToolSessionId } from "./utils/parallel-read.js";
import { failTextResult, inconclusiveTextResult, textResult } from "./utils/result.js";
import { defineBrewvaTool } from "./utils/tool.js";

const TOC_EVENT_TYPE = "tool_toc_query";
const UNAVAILABLE_STATUS = "unavailable";

function recordTocReadPathObservation(input: {
  runtime?: BrewvaBundledToolRuntime;
  sessionId?: string;
  baseCwd: string;
  toolName: "toc_document" | "toc_search";
  evidenceKind: string;
  observedPaths: Iterable<string>;
}): void {
  const payload = buildReadPathDiscoveryObservationPayload({
    baseCwd: input.baseCwd,
    toolName: input.toolName,
    evidenceKind: input.evidenceKind,
    observedPaths: input.observedPaths,
  });
  if (!input.sessionId || !payload) {
    return;
  }
  recordToolRuntimeEvent(input.runtime, {
    sessionId: input.sessionId,
    type: TOOL_READ_PATH_DISCOVERY_OBSERVED_EVENT_TYPE,
    payload,
  });
}

function resolveBaseDir(ctx: unknown, runtime?: BrewvaBundledToolRuntime): ToolTargetScope {
  return resolveToolTargetScope(runtime, ctx);
}

function resolveAbsolutePath(scope: ToolTargetScope, target: string): string | null {
  return resolveScopedPath(target, scope);
}

function buildDocumentText(toc: TocDocument, baseDir: string): string {
  const lines: string[] = [
    "[TOCDocument]",
    `file: ${normalizeRelativePath(baseDir, toc.filePath)}`,
    `language: ${toc.language}`,
    `module_summary: ${toc.moduleSummary ?? "n/a"}`,
    `imports_count: ${toc.imports.length}`,
    `functions_count: ${toc.functions.length}`,
    `classes_count: ${toc.classes.length}`,
    `declarations_count: ${toc.declarations.length}`,
    "",
    "[Imports]",
  ];

  if (toc.imports.length === 0) {
    lines.push("- none");
  } else {
    for (const entry of toc.imports) {
      lines.push(
        `- lines=${formatLineSpan(entry.lineStart, entry.lineEnd)} source=${entry.source} clause=${entry.clause ?? "n/a"}`,
      );
    }
  }

  lines.push("", "[Functions]");
  if (toc.functions.length === 0) {
    lines.push("- none");
  } else {
    for (const entry of toc.functions) {
      lines.push(
        `- lines=${formatLineSpan(entry.lineStart, entry.lineEnd)} kind=${entry.kind} name=${entry.name} exported=${entry.exported ? "true" : "false"} signature=${JSON.stringify(entry.signature)} summary=${JSON.stringify(entry.summary ?? "n/a")}`,
      );
    }
  }

  lines.push("", "[Declarations]");
  if (toc.declarations.length === 0) {
    lines.push("- none");
  } else {
    for (const entry of toc.declarations) {
      lines.push(
        `- lines=${formatLineSpan(entry.lineStart, entry.lineEnd)} kind=${entry.kind} name=${entry.name} exported=${entry.exported ? "true" : "false"} signature=${JSON.stringify(entry.signature)} summary=${JSON.stringify(entry.summary ?? "n/a")}`,
      );
    }
  }

  lines.push("", "[Classes]");
  if (toc.classes.length === 0) {
    lines.push("- none");
  } else {
    for (const entry of toc.classes) {
      lines.push(
        `- lines=${formatLineSpan(entry.lineStart, entry.lineEnd)} kind=class name=${entry.name} exported=${entry.exported ? "true" : "false"} signature=${JSON.stringify(entry.signature)} summary=${JSON.stringify(entry.summary ?? "n/a")}`,
      );
      if (entry.methods.length === 0) {
        lines.push(`- parent=${entry.name} methods=none`);
        continue;
      }
      for (const method of entry.methods) {
        lines.push(
          `- parent=${entry.name} lines=${formatLineSpan(method.lineStart, method.lineEnd)} kind=${method.kind} name=${method.name} static=${method.static ? "true" : "false"} signature=${JSON.stringify(method.signature)} summary=${JSON.stringify(method.summary ?? "n/a")}`,
        );
      }
    }
  }

  return lines.join("\n");
}

function summarizeSearch(
  query: string,
  matches: TocSearchMatch[],
  summary: TocSearchSummary,
  baseDir: string,
): string {
  const lines: string[] = [
    "[TOCSearch]",
    `query: ${query}`,
    "status: ok",
    `indexed_files: ${summary.indexedFiles}`,
    `candidate_files: ${summary.candidateFiles}`,
    `matches_shown: ${matches.length}`,
    `cache_hits: ${summary.cacheHits}`,
    `cache_misses: ${summary.cacheMisses}`,
    `skipped_files: ${summary.skippedFiles}`,
    `oversized_files: ${summary.oversizedFiles}`,
    `indexed_bytes: ${summary.indexedBytes}`,
    "follow_up_hint: Prefer read_spans for exact line ranges; use grep for broad text search.",
    "",
  ];

  for (const match of matches) {
    lines.push(
      `- score=${match.score} file=${normalizeRelativePath(baseDir, match.filePath)} kind=${match.kind} name=${match.name} lines=${formatLineSpan(match.lineStart, match.lineEnd)} parent=${match.parentName ?? "n/a"} signature=${JSON.stringify(match.signature ?? "n/a")} summary=${JSON.stringify(match.summary ?? "n/a")}`,
    );
  }

  return lines.join("\n");
}

function summarizeBroadQuery(input: {
  query: string;
  preview: TocSearchMatch[];
  summary: TocSearchSummary;
  baseDir: string;
}): string {
  const lines: string[] = [
    "[TOCSearch]",
    `query: ${input.query}`,
    `status: ${UNAVAILABLE_STATUS}`,
    "reason: broad_query",
    `indexed_files: ${input.summary.indexedFiles}`,
    `candidate_files: ${input.summary.candidateFiles}`,
    `matches_shown: ${input.preview.length}`,
    `cache_hits: ${input.summary.cacheHits}`,
    `cache_misses: ${input.summary.cacheMisses}`,
    `skipped_files: ${input.summary.skippedFiles}`,
    `oversized_files: ${input.summary.oversizedFiles}`,
    `indexed_bytes: ${input.summary.indexedBytes}`,
    "next_step: Narrow the query to a symbol/import name or switch to grep for broad text search.",
  ];

  if (input.preview.length > 0) {
    lines.push("", "[TopCandidates]");
    for (const match of input.preview) {
      lines.push(
        `- file=${normalizeRelativePath(input.baseDir, match.filePath)} kind=${match.kind} name=${match.name} lines=${formatLineSpan(match.lineStart, match.lineEnd)} score=${match.score}`,
      );
    }
  }

  return lines.join("\n");
}

function summarizeScopeOverflow(input: {
  query: string;
  candidateFiles: number;
  baseDir: string;
}): string {
  return [
    "[TOCSearch]",
    `query: ${input.query}`,
    `status: ${UNAVAILABLE_STATUS}`,
    "reason: search_scope_too_large",
    `candidate_files_scanned: ${input.candidateFiles}`,
    `walk_limit: ${MAX_TOC_SEARCH_CANDIDATE_FILES}`,
    `workspace_root: ${input.baseDir}`,
    "next_step: Narrow paths to a package/folder first, then retry toc_search.",
  ].join("\n");
}

function summarizeIndexBudgetExceeded(input: {
  query: string;
  preview: TocSearchMatch[];
  summary: TocSearchSummary;
  baseDir: string;
}): string {
  const lines: string[] = [
    "[TOCSearch]",
    `query: ${input.query}`,
    `status: ${UNAVAILABLE_STATUS}`,
    "reason: indexing_budget_exceeded",
    `indexed_files: ${input.summary.indexedFiles}`,
    `candidate_files: ${input.summary.candidateFiles}`,
    `cache_hits: ${input.summary.cacheHits}`,
    `cache_misses: ${input.summary.cacheMisses}`,
    `skipped_files: ${input.summary.skippedFiles}`,
    `oversized_files: ${input.summary.oversizedFiles}`,
    `indexed_bytes: ${input.summary.indexedBytes}`,
    `indexed_bytes_limit: ${MAX_TOC_SEARCH_INDEXED_BYTES}`,
    "next_step: Narrow paths or query terms before retrying toc_search.",
  ];

  if (input.preview.length > 0) {
    lines.push("", "[IndexedPreview]");
    for (const match of input.preview) {
      lines.push(
        `- file=${normalizeRelativePath(input.baseDir, match.filePath)} kind=${match.kind} name=${match.name} lines=${formatLineSpan(match.lineStart, match.lineEnd)} score=${match.score}`,
      );
    }
  }

  return lines.join("\n");
}

function summarizeNoMatchWithSuggestions(input: {
  query: string;
  indexedFiles: number;
  cacheHits: number;
  cacheMisses: number;
  skippedFiles: number;
  oversizedFiles: number;
  indexedBytes: number;
  suggestions: string[];
}): string {
  const lines: string[] = [
    "[TOCSearch]",
    `query: ${input.query}`,
    `status: ${UNAVAILABLE_STATUS}`,
    "reason: no_match",
    `indexed_files: ${input.indexedFiles}`,
    `cache_hits: ${input.cacheHits}`,
    `cache_misses: ${input.cacheMisses}`,
    `skipped_files: ${input.skippedFiles}`,
    `oversized_files: ${input.oversizedFiles}`,
    `indexed_bytes: ${input.indexedBytes}`,
    "next_step: Try grep for raw text search or inspect one of the suggested files.",
  ];

  if (input.suggestions.length > 0) {
    lines.push("", "[SuggestedFiles]");
    for (const suggestion of input.suggestions) {
      lines.push(`- ${suggestion}`);
    }
  }

  return lines.join("\n");
}

function recordTocEvent(
  runtime: BrewvaBundledToolRuntime | undefined,
  sessionId: string | undefined,
  payload: Record<string, unknown>,
): void {
  if (!sessionId) return;
  recordToolRuntimeEvent(runtime, {
    sessionId,
    type: TOC_EVENT_TYPE,
    payload,
  });
}

export function createTocTools(options?: { runtime?: BrewvaBundledToolRuntime }): ToolDefinition[] {
  const sessionCache: TocSearchSessionCacheStore = createTocSearchSessionCacheStore();
  registerTocSourceCacheRuntime(options?.runtime);
  registerToolRuntimeClearStateListener(options?.runtime, (sessionId) => {
    sessionCache.delete(resolveTocSessionKey(sessionId));
  });

  const tocDocument = defineBrewvaTool({
    name: "toc_document",
    label: "TOC Document",
    description:
      "Return a structural table of contents for one TS/JS file: imports, top-level symbols, public methods, summaries, and line spans.",
    parameters: Type.Object({
      file_path: Type.String({ minLength: 1 }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const scope = resolveBaseDir(ctx, options?.runtime);
      const absolutePath = resolveAbsolutePath(scope, params.file_path);
      if (!absolutePath) {
        return failTextResult(
          `toc_document rejected: path escapes target roots (${scope.allowedRoots.join(", ")}).`,
        );
      }
      if (!existsSync(absolutePath)) {
        return failTextResult(`Error: File not found: ${absolutePath}`);
      }
      let stats: import("node:fs").Stats;
      try {
        stats = statSync(absolutePath);
      } catch (error) {
        return failTextResult(`Error: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (!stats.isFile()) {
        return failTextResult(`Error: Path is not a file: ${absolutePath}`);
      }
      const sessionId = getToolSessionId(ctx);
      recordTocReadPathObservation({
        runtime: options?.runtime,
        sessionId,
        baseCwd: scope.baseCwd,
        toolName: "toc_document",
        evidenceKind: "direct_file_access",
        observedPaths: [absolutePath],
      });
      if (!supportsToc(absolutePath)) {
        return inconclusiveTextResult(
          [
            "toc_document unavailable: unsupported language for structural TOC extraction.",
            `file: ${absolutePath}`,
            "reason=unsupported_language",
            "next_step=Use grep or look_at for non-TS/JS files.",
          ].join("\n"),
          {
            status: UNAVAILABLE_STATUS,
            reason: "unsupported_language",
            nextStep: "Use grep or look_at for non-TS/JS files.",
            filePath: absolutePath,
          },
        );
      }
      if (stats.size > MAX_TOC_FILE_BYTES) {
        return inconclusiveTextResult(
          [
            "toc_document unavailable: file exceeds structural parse budget.",
            `file: ${absolutePath}`,
            "reason=file_too_large",
            `file_bytes: ${stats.size}`,
            `max_file_bytes: ${MAX_TOC_FILE_BYTES}`,
            "next_step=Use read_spans on a focused line range or grep for targeted text search.",
          ].join("\n"),
          {
            status: UNAVAILABLE_STATUS,
            reason: "file_too_large",
            filePath: absolutePath,
            fileBytes: stats.size,
            maxFileBytes: MAX_TOC_FILE_BYTES,
            nextStep: "Use read_spans on a focused line range or grep for targeted text search.",
          },
        );
      }

      const signature = `${stats.mtimeMs}:${stats.size}`;
      const source = readSourceTextWithCache({
        sessionId,
        absolutePath,
        signature,
      });
      const startedAt = Date.now();
      const lookup = lookupTocDocument({
        cacheStore: sessionCache,
        sessionKey: resolveTocSessionKey(sessionId),
        absolutePath,
        signature,
        sourceText: source.sourceText,
      });
      recordTocEvent(options?.runtime, sessionId, {
        toolName: "toc_document",
        operation: "document",
        filePath: absolutePath,
        cacheHit: lookup.cacheHit,
        sourceCacheHit: source.cacheHit,
        durationMs: Date.now() - startedAt,
      });

      return textResult(buildDocumentText(lookup.toc, scope.baseCwd), {
        status: "ok",
        filePath: absolutePath,
        cacheHit: lookup.cacheHit,
        sourceCacheHit: source.cacheHit,
        language: lookup.toc.language,
        importsCount: lookup.toc.imports.length,
        functionsCount: lookup.toc.functions.length,
        classesCount: lookup.toc.classes.length,
        declarationsCount: lookup.toc.declarations.length,
      });
    },
  });

  const tocSearch = defineBrewvaTool({
    name: "toc_search",
    label: "TOC Search",
    description:
      "Search TS/JS file structure before full reads. Returns ranked symbols, imports, summaries, and line spans; broad queries fall back with guidance.",
    parameters: Type.Object({
      query: Type.String({ minLength: 1 }),
      paths: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: 20 })),
      limit: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: MAX_TOC_SEARCH_LIMIT,
          default: DEFAULT_TOC_SEARCH_LIMIT,
        }),
      ),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const scope = resolveBaseDir(ctx, options?.runtime);
      const roots = (params.paths ?? ["."])
        .map((entry) => resolveAbsolutePath(scope, entry))
        .filter((entry): entry is string => Boolean(entry));
      if (roots.length === 0) {
        return failTextResult(
          `toc_search rejected: paths escape target roots (${scope.allowedRoots.join(", ")}).`,
        );
      }
      const sessionId = getToolSessionId(ctx);
      const queryText = params.query.trim();
      const limit = params.limit ?? DEFAULT_TOC_SEARCH_LIMIT;
      registerSearchIntent({
        runtime: options?.runtime,
        sessionId,
        toolName: "toc_search",
        query: queryText,
        requestedPaths: roots
          .map((root) => normalizeSearchAdvisorPath(scope.baseCwd, root))
          .filter((root): root is string => Boolean(root)),
      });

      const startedAt = Date.now();
      const core = runTocSearchCore({
        runtime: options?.runtime,
        sessionId,
        baseDir: scope.baseCwd,
        roots,
        queryText,
        limit,
        cacheStore: sessionCache,
      });

      if (core.tokens.length === 0) {
        return inconclusiveTextResult(
          [
            "toc_search unavailable: query is too broad or empty after tokenization.",
            "reason=query_tokens_insufficient",
            "next_step=Provide a symbol, import path, or API phrase with at least one concrete token.",
          ].join("\n"),
          {
            status: UNAVAILABLE_STATUS,
            reason: "query_tokens_insufficient",
            nextStep:
              "Provide a symbol, import path, or API phrase with at least one concrete token.",
          },
        );
      }

      if (core.scopeOverflow) {
        recordTocEvent(options?.runtime, sessionId, {
          toolName: "toc_search",
          operation: "search",
          broadQuery: false,
          scopeOverflow: true,
          candidateFilesScanned: core.scopedFileCount,
          durationMs: 0,
        });
        return inconclusiveTextResult(
          summarizeScopeOverflow({
            query: queryText,
            candidateFiles: core.scopedFileCount,
            baseDir: scope.baseCwd,
          }),
          {
            status: UNAVAILABLE_STATUS,
            reason: "search_scope_too_large",
            candidateFiles: core.scopedFileCount,
            walkLimit: MAX_TOC_SEARCH_CANDIDATE_FILES,
            nextStep: "Narrow paths to a package/folder first, then retry toc_search.",
          },
        );
      }

      if (core.noSupportedFiles) {
        return inconclusiveTextResult(
          [
            "toc_search unavailable: no supported TS/JS files found in the requested paths.",
            "reason=no_supported_files",
            "next_step=Point paths at a TS/JS workspace or use grep/look_at for other languages.",
          ].join("\n"),
          {
            status: UNAVAILABLE_STATUS,
            reason: "no_supported_files",
            nextStep: "Point paths at a TS/JS workspace or use grep/look_at for other languages.",
          },
        );
      }

      if (core.noAccessibleFiles || core.noIndexableFiles) {
        return inconclusiveTextResult(
          [
            "toc_search unavailable: no accessible TS/JS files could be indexed.",
            `reason=${core.noIndexableFiles ? "no_indexable_files" : "no_accessible_files"}`,
            `candidate_files: ${core.scopedFileCount}`,
            `skipped_files: ${core.summary.skippedFiles}`,
            `oversized_files: ${core.summary.oversizedFiles}`,
            "next_step=Check file permissions, narrow paths, or use read_spans on a specific file.",
          ].join("\n"),
          {
            status: UNAVAILABLE_STATUS,
            reason: core.noIndexableFiles ? "no_indexable_files" : "no_accessible_files",
            candidateFiles: core.scopedFileCount,
            skippedFiles: core.summary.skippedFiles,
            oversizedFiles: core.summary.oversizedFiles,
            nextStep: "Check file permissions, narrow paths, or use read_spans on a specific file.",
          },
        );
      }

      const searchSummary = core.summary;
      const candidateFiles = searchSummary.candidateFiles;
      const durationMs = Date.now() - startedAt;
      const rankedMatches = core.rankedMatches;
      const recordSearchEvent = (input: {
        returnedMatches: number;
        advisorStatus: string;
        broadQuery: boolean;
        budgetExceeded: boolean;
      }): void => {
        recordTocEvent(options?.runtime, sessionId, {
          toolName: "toc_search",
          operation: "search",
          indexedFiles: searchSummary.indexedFiles,
          candidateFiles,
          returnedMatches: input.returnedMatches,
          cacheHits: searchSummary.cacheHits,
          cacheMisses: searchSummary.cacheMisses,
          skippedFiles: searchSummary.skippedFiles,
          oversizedFiles: searchSummary.oversizedFiles,
          indexedBytes: searchSummary.indexedBytes,
          broadQuery: input.broadQuery,
          budgetExceeded: input.budgetExceeded,
          advisorStatus: input.advisorStatus,
          advisorSignalFiles: core.advisor.signalFiles,
          advisorReorderedMatches: core.advisor.reorderedMatches,
          comboMatches: core.advisor.comboMatches,
          durationMs,
        });
      };

      if (core.budgetExceeded) {
        const preview = rankedMatches.slice(0, Math.min(5, limit));
        attachSearchIntentPreviewCandidates({
          sessionId,
          toolName: "toc_search",
          query: queryText,
          candidatePaths: preview
            .map((match) => normalizeSearchAdvisorPath(scope.baseCwd, match.filePath))
            .filter((path): path is string => Boolean(path)),
        });
        recordTocReadPathObservation({
          runtime: options?.runtime,
          sessionId,
          baseCwd: scope.baseCwd,
          toolName: "toc_search",
          evidenceKind: "search_preview",
          observedPaths: preview.map((match) => match.filePath),
        });
        recordSearchEvent({
          returnedMatches: 0,
          advisorStatus: core.advisor.status,
          broadQuery: false,
          budgetExceeded: true,
        });
        return inconclusiveTextResult(
          summarizeIndexBudgetExceeded({
            query: queryText,
            preview,
            summary: searchSummary,
            baseDir: scope.baseCwd,
          }),
          {
            status: UNAVAILABLE_STATUS,
            reason: "indexing_budget_exceeded",
            indexedFiles: searchSummary.indexedFiles,
            candidateFiles,
            cacheHits: searchSummary.cacheHits,
            cacheMisses: searchSummary.cacheMisses,
            skippedFiles: searchSummary.skippedFiles,
            oversizedFiles: searchSummary.oversizedFiles,
            indexedBytes: searchSummary.indexedBytes,
            indexedBytesLimit: MAX_TOC_SEARCH_INDEXED_BYTES,
            nextStep: "Narrow paths or query terms before retrying toc_search.",
            advisor: core.advisor,
          },
        );
      }

      if (rankedMatches.length === 0) {
        const suggestions = [
          ...new Set(
            [core.advisor.comboSuggestion, ...core.advisor.hotFiles].filter(
              (suggestion): suggestion is string => Boolean(suggestion),
            ),
          ),
        ];
        const advisorStatus = suggestions.length > 0 ? "suggestion_only" : core.advisor.status;
        if (suggestions.length > 0) {
          attachSearchIntentPreviewCandidates({
            sessionId,
            toolName: "toc_search",
            query: queryText,
            candidatePaths: suggestions,
          });
        }
        recordSearchEvent({
          returnedMatches: 0,
          advisorStatus,
          broadQuery: false,
          budgetExceeded: false,
        });
        return inconclusiveTextResult(
          summarizeNoMatchWithSuggestions({
            query: queryText,
            indexedFiles: searchSummary.indexedFiles,
            cacheHits: searchSummary.cacheHits,
            cacheMisses: searchSummary.cacheMisses,
            skippedFiles: searchSummary.skippedFiles,
            oversizedFiles: searchSummary.oversizedFiles,
            indexedBytes: searchSummary.indexedBytes,
            suggestions,
          }),
          {
            status: UNAVAILABLE_STATUS,
            reason: "no_match",
            indexedFiles: searchSummary.indexedFiles,
            cacheHits: searchSummary.cacheHits,
            cacheMisses: searchSummary.cacheMisses,
            skippedFiles: searchSummary.skippedFiles,
            oversizedFiles: searchSummary.oversizedFiles,
            indexedBytes: searchSummary.indexedBytes,
            nextStep: "Try a symbol name, import path, or use grep for raw text search.",
            advisor: {
              ...core.advisor,
              status: advisorStatus,
              scoringMode: "multiplicative",
            },
          },
        );
      }

      if (core.broadQuery) {
        const preview = rankedMatches.slice(0, Math.min(5, limit));
        attachSearchIntentPreviewCandidates({
          sessionId,
          toolName: "toc_search",
          query: queryText,
          candidatePaths: preview
            .map((match) => normalizeSearchAdvisorPath(scope.baseCwd, match.filePath))
            .filter((path): path is string => Boolean(path)),
        });
        recordTocReadPathObservation({
          runtime: options?.runtime,
          sessionId,
          baseCwd: scope.baseCwd,
          toolName: "toc_search",
          evidenceKind: "search_preview",
          observedPaths: preview.map((match) => match.filePath),
        });
        recordSearchEvent({
          returnedMatches: 0,
          advisorStatus: core.advisor.status,
          broadQuery: true,
          budgetExceeded: false,
        });
        return inconclusiveTextResult(
          summarizeBroadQuery({
            query: queryText,
            preview,
            summary: searchSummary,
            baseDir: scope.baseCwd,
          }),
          {
            status: UNAVAILABLE_STATUS,
            reason: "broad_query",
            indexedFiles: searchSummary.indexedFiles,
            candidateFiles,
            cacheHits: searchSummary.cacheHits,
            cacheMisses: searchSummary.cacheMisses,
            skippedFiles: searchSummary.skippedFiles,
            oversizedFiles: searchSummary.oversizedFiles,
            indexedBytes: searchSummary.indexedBytes,
            nextStep:
              "Narrow the query to a symbol/import name or switch to grep for broad text search.",
            advisor: core.advisor,
          },
        );
      }

      const matches = rankedMatches.slice(0, limit);
      attachSearchIntentPreviewCandidates({
        sessionId,
        toolName: "toc_search",
        query: queryText,
        candidatePaths: matches
          .map((match) => normalizeSearchAdvisorPath(scope.baseCwd, match.filePath))
          .filter((path): path is string => Boolean(path)),
      });
      recordTocReadPathObservation({
        runtime: options?.runtime,
        sessionId,
        baseCwd: scope.baseCwd,
        toolName: "toc_search",
        evidenceKind: "search_match",
        observedPaths: matches.map((match) => match.filePath),
      });
      recordSearchEvent({
        returnedMatches: matches.length,
        advisorStatus: core.advisor.status,
        broadQuery: false,
        budgetExceeded: false,
      });
      return textResult(summarizeSearch(queryText, matches, searchSummary, scope.baseCwd), {
        status: "ok",
        indexedFiles: searchSummary.indexedFiles,
        candidateFiles,
        cacheHits: searchSummary.cacheHits,
        cacheMisses: searchSummary.cacheMisses,
        skippedFiles: searchSummary.skippedFiles,
        oversizedFiles: searchSummary.oversizedFiles,
        indexedBytes: searchSummary.indexedBytes,
        matchesReturned: matches.length,
        advisor: core.advisor,
      });
    },
  });

  return [tocDocument, tocSearch];
}
