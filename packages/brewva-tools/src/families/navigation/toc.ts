import type { BrewvaToolDefinition as ToolDefinition } from "@brewva/brewva-substrate/tools";
import { Type } from "@sinclair/typebox";
import type { BrewvaBundledToolRuntime } from "../../contracts/index.js";
import { createRuntimeBoundBrewvaToolFactory } from "../../registry/runtime-bound-tool.js";
import { registerToolRuntimeClearStateListener } from "../../runtime-port/extensions.js";
import { getToolSessionId } from "../../runtime-port/parallel-read.js";
import { failTextResult, inconclusiveTextResult, textResult } from "../../utils/result.js";
import {
  attachSearchIntentPreviewCandidates,
  normalizeSearchAdvisorPath,
  registerSearchIntent,
} from "./search-advisor.js";
import { registerTocSourceCacheRuntime, resolveTocSessionKey } from "./toc-cache.js";
import {
  DEFAULT_TOC_SEARCH_LIMIT,
  MAX_TOC_SEARCH_CANDIDATE_FILES,
  MAX_TOC_SEARCH_INDEXED_BYTES,
  MAX_TOC_SEARCH_LIMIT,
  createTocSearchSessionCacheStore,
  runTocSearchCore,
  type TocSearchSessionCacheStore,
} from "./toc-search-core.js";
import { createTocDocumentTool } from "./toc/document-tool.js";
import {
  recordTocEvent,
  recordTocReadPathObservation,
  recordTocSearchEvent,
} from "./toc/events.js";
import {
  TOC_UNAVAILABLE_STATUS as UNAVAILABLE_STATUS,
  summarizeBroadQuery,
  summarizeIndexBudgetExceeded,
  summarizeNoMatchWithSuggestions,
  summarizeScopeOverflow,
  summarizeSearch,
} from "./toc/render.js";
import { resolveAbsolutePath, resolveBaseDir } from "./toc/scope.js";

export function createTocTools(options?: { runtime?: BrewvaBundledToolRuntime }): ToolDefinition[] {
  const sessionCache: TocSearchSessionCacheStore = createTocSearchSessionCacheStore();
  registerTocSourceCacheRuntime(options?.runtime);
  registerToolRuntimeClearStateListener(options?.runtime, (sessionId) => {
    sessionCache.delete(resolveTocSessionKey(sessionId));
  });
  const tocDocument = createTocDocumentTool({
    runtime: options?.runtime,
    sessionCache,
  });
  const tocSearchTool = createRuntimeBoundBrewvaToolFactory(options?.runtime, "toc_search");

  const tocSearch = tocSearchTool.define({
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
      const scope = resolveBaseDir(ctx, tocSearchTool.runtime);
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
        runtime: tocSearchTool.runtime,
        sessionId,
        toolName: "toc_search",
        query: queryText,
        requestedPaths: roots
          .map((root) => normalizeSearchAdvisorPath(scope.baseCwd, root))
          .filter((root): root is string => Boolean(root)),
      });

      const startedAt = Date.now();
      const core = runTocSearchCore({
        runtime: tocSearchTool.runtime,
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
        recordTocEvent(tocSearchTool.runtime, sessionId, {
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
      const recordSearchEvent = (event: {
        returnedMatches: number;
        advisorStatus: string;
        broadQuery: boolean;
        budgetExceeded: boolean;
      }): void => {
        recordTocSearchEvent({
          runtime: tocSearchTool.runtime,
          sessionId,
          summary: searchSummary,
          candidateFiles,
          advisor: core.advisor,
          durationMs,
          ...event,
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
          runtime: tocSearchTool.runtime,
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
          runtime: tocSearchTool.runtime,
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
        runtime: tocSearchTool.runtime,
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
