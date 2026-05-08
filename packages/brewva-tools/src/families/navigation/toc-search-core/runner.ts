import { statSync } from "node:fs";
import { tokenizeSearchQuery } from "@brewva/brewva-search";
import type { BrewvaToolRuntime } from "../../../contracts/index.js";
import { buildSearchAdvisorSnapshot, normalizeSearchAdvisorPath } from "../search-advisor.js";
import { readSourceTextWithCache, resolveTocSessionKey } from "../toc-cache.js";
import { lookupTocDocument } from "./cache.js";
import {
  MAX_TOC_FILE_BYTES,
  MAX_TOC_SEARCH_CANDIDATE_FILES,
  MAX_TOC_SEARCH_INDEXED_BYTES,
} from "./constants.js";
import { resolveBroadQuery, searchDocument, walkTocFiles } from "./search.js";
import type {
  AdvisorRankedTocMatch,
  TocSearchCoreAdvisor,
  TocSearchCoreResult,
  TocSearchMatch,
  TocSearchSessionCacheStore,
  TocSearchSummary,
} from "./types.js";

const EMPTY_TOC_SEARCH_SUMMARY: TocSearchSummary = {
  indexedFiles: 0,
  candidateFiles: 0,
  cacheHits: 0,
  cacheMisses: 0,
  skippedFiles: 0,
  oversizedFiles: 0,
  indexedBytes: 0,
};

const EMPTY_TOC_SEARCH_ADVISOR: TocSearchCoreAdvisor = {
  status: "skipped",
  signalFiles: 0,
  reorderedMatches: 0,
  comboMatches: 0,
  scoringMode: "multiplicative",
  hotFiles: [],
};

function buildEmptyTocSearchResult(input: {
  queryText: string;
  query: string;
  tokens: string[];
  scopeOverflow?: boolean;
  scopedFileCount?: number;
  noSupportedFiles?: boolean;
  noAccessibleFiles?: boolean;
  noIndexableFiles?: boolean;
  budgetExceeded?: boolean;
  summary?: TocSearchSummary;
}): TocSearchCoreResult {
  return {
    queryText: input.queryText,
    query: input.query,
    tokens: input.tokens,
    scopeOverflow: input.scopeOverflow ?? false,
    scopedFileCount: input.scopedFileCount ?? 0,
    noSupportedFiles: input.noSupportedFiles ?? false,
    noAccessibleFiles: input.noAccessibleFiles ?? false,
    noIndexableFiles: input.noIndexableFiles ?? false,
    budgetExceeded: input.budgetExceeded ?? false,
    broadQuery: false,
    summary: input.summary ?? EMPTY_TOC_SEARCH_SUMMARY,
    rankedMatches: [],
    advisor: EMPTY_TOC_SEARCH_ADVISOR,
  };
}

function sortTocMatches(matches: TocSearchMatch[]): void {
  matches.sort((left, right) => {
    if (left.score !== right.score) return right.score - left.score;
    if (left.filePath !== right.filePath) return left.filePath.localeCompare(right.filePath);
    if (left.lineStart !== right.lineStart) return left.lineStart - right.lineStart;
    return left.name.localeCompare(right.name);
  });
}

function rankWithSearchAdvisor(input: {
  runtime?: BrewvaToolRuntime;
  sessionId?: string;
  baseDir: string;
  queryText: string;
  matches: TocSearchMatch[];
}): {
  rankedMatches: AdvisorRankedTocMatch[];
  advisor: TocSearchCoreAdvisor;
} {
  const advisorSnapshot = buildSearchAdvisorSnapshot({
    runtime: input.runtime,
    sessionId: input.sessionId,
  });
  const rankedMatches: AdvisorRankedTocMatch[] = input.matches.map((match, originalOrder) => {
    const advisorPath = normalizeSearchAdvisorPath(input.baseDir, match.filePath) ?? match.filePath;
    const advisorScore = advisorSnapshot.scoreFile({
      toolName: "toc_search",
      query: input.queryText,
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

  const comboMatch = advisorSnapshot.getComboMatch({
    toolName: "toc_search",
    query: input.queryText,
  });
  const comboMatchCount = Math.max(
    comboMatch?.hitCount ?? 0,
    ...rankedMatches.map((item) => item.comboMatches),
  );
  const advisorStatus =
    advisorSnapshot.signalFiles > 0 || comboMatchCount > 0 ? "applied" : "skipped";

  return {
    rankedMatches,
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
  const tokens = tokenizeSearchQuery(query, { minLength: 2 });

  if (tokens.length === 0) {
    return buildEmptyTocSearchResult({ queryText, query, tokens });
  }

  const maxCandidateFiles = input.maxCandidateFiles ?? MAX_TOC_SEARCH_CANDIDATE_FILES;
  const maxIndexedBytes = input.maxIndexedBytes ?? MAX_TOC_SEARCH_INDEXED_BYTES;
  const walk = walkTocFiles(input.roots, maxCandidateFiles);
  if (walk.scopeOverflow) {
    return buildEmptyTocSearchResult({
      queryText,
      query,
      tokens,
      scopeOverflow: true,
      scopedFileCount: walk.files.length,
    });
  }

  const files = walk.files;
  if (files.length === 0) {
    return buildEmptyTocSearchResult({
      queryText,
      query,
      tokens,
      noSupportedFiles: true,
    });
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
      const signature = `${stats.mtimeMs}:${stats.size}`;
      const source = readSourceTextWithCache({
        sessionId: input.sessionId,
        absolutePath: filePath,
        signature,
      });
      const lookup = lookupTocDocument({
        cacheStore: input.cacheStore,
        sessionKey,
        absolutePath: filePath,
        signature,
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
    return buildEmptyTocSearchResult({
      queryText,
      query,
      tokens,
      scopedFileCount: files.length,
      noAccessibleFiles: oversizedFiles === 0,
      noIndexableFiles: oversizedFiles > 0,
      budgetExceeded,
      summary,
    });
  }

  sortTocMatches(allMatches);
  const { rankedMatches, advisor } = rankWithSearchAdvisor({
    runtime: input.runtime,
    sessionId: input.sessionId,
    baseDir: input.baseDir,
    queryText,
    matches: allMatches,
  });

  const candidateFiles = new Set(allMatches.map((match) => match.filePath)).size;
  summary.candidateFiles = candidateFiles;

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
    advisor,
  };
}
