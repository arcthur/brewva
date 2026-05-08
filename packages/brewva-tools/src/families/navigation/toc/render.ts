import {
  MAX_TOC_SEARCH_CANDIDATE_FILES,
  MAX_TOC_SEARCH_INDEXED_BYTES,
  formatLineSpan,
  normalizeRelativePath,
  type TocDocument,
  type TocSearchMatch,
  type TocSearchSummary,
} from "../toc-search-core.js";

export const TOC_UNAVAILABLE_STATUS = "unavailable";

export function buildDocumentText(toc: TocDocument, baseDir: string): string {
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

export function summarizeSearch(
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

export function summarizeBroadQuery(input: {
  query: string;
  preview: TocSearchMatch[];
  summary: TocSearchSummary;
  baseDir: string;
}): string {
  const lines: string[] = [
    "[TOCSearch]",
    `query: ${input.query}`,
    `status: ${TOC_UNAVAILABLE_STATUS}`,
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

export function summarizeScopeOverflow(input: {
  query: string;
  candidateFiles: number;
  baseDir: string;
}): string {
  return [
    "[TOCSearch]",
    `query: ${input.query}`,
    `status: ${TOC_UNAVAILABLE_STATUS}`,
    "reason: search_scope_too_large",
    `candidate_files_scanned: ${input.candidateFiles}`,
    `walk_limit: ${MAX_TOC_SEARCH_CANDIDATE_FILES}`,
    `workspace_root: ${input.baseDir}`,
    "next_step: Narrow paths to a package/folder first, then retry toc_search.",
  ].join("\n");
}

export function summarizeIndexBudgetExceeded(input: {
  query: string;
  preview: TocSearchMatch[];
  summary: TocSearchSummary;
  baseDir: string;
}): string {
  const lines: string[] = [
    "[TOCSearch]",
    `query: ${input.query}`,
    `status: ${TOC_UNAVAILABLE_STATUS}`,
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

export function summarizeNoMatchWithSuggestions(input: {
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
    `status: ${TOC_UNAVAILABLE_STATUS}`,
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
