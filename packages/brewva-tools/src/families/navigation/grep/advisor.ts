import { statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { BrewvaToolOptions } from "../../../contracts/index.js";
import { buildSearchAdvisorSnapshot, normalizeSearchAdvisorPath } from "../search-advisor.js";
import {
  formatLineSpan,
  normalizeRelativePath,
  runTocSearchCore,
  type TocSearchSessionCacheStore,
} from "../toc-search-core.js";
import type {
  GrepAdvisorDetails,
  GrepGroupedLines,
  GrepSuggestionItem,
  GrepSuggestionMode,
} from "./types.js";

const GREP_LOCATION_PATTERN = /^([^:\n]+):\d+(?::\d+)?(?:\s|:|$)/u;
const GREP_TOC_SUGGESTION_LIMIT = 3;
const GREP_TOC_SUGGESTION_MAX_FILES = 400;
const GREP_TOC_SUGGESTION_MAX_INDEXED_BYTES = 2_000_000;
const GREP_MAX_SUGGESTIONS = 5;

function groupLocationLines(baseCwd: string, lines: string[]): GrepGroupedLines[] {
  const groups: GrepGroupedLines[] = [];
  let current: GrepGroupedLines | undefined;
  let hasUnparsedLine = false;

  for (const line of lines) {
    const match = GREP_LOCATION_PATTERN.exec(line.trim());
    const normalizedPath = match?.[1] ? normalizeSearchAdvisorPath(baseCwd, match[1]) : undefined;
    if (!normalizedPath) {
      hasUnparsedLine = true;
      groups.push({
        lines: [line],
        originalOrder: groups.length,
      });
      current = undefined;
      continue;
    }
    if (current?.path === normalizedPath) {
      current.lines.push(line);
      continue;
    }
    current = {
      path: normalizedPath,
      lines: [line],
      originalOrder: groups.length,
    };
    groups.push(current);
  }

  if (hasUnparsedLine) {
    return groups;
  }
  return groups;
}

export function rerankGroupedLines(input: {
  baseCwd: string;
  query: string;
  lines: string[];
  runtime?: BrewvaToolOptions["runtime"];
  sessionId?: string;
}): {
  lines: string[];
  candidatePaths: string[];
  advisor: GrepAdvisorDetails;
} {
  const snapshot = buildSearchAdvisorSnapshot({
    runtime: input.runtime,
    sessionId: input.sessionId,
  });
  const groups = groupLocationLines(input.baseCwd, input.lines);
  if (groups.some((group) => !group.path)) {
    return {
      lines: input.lines,
      candidatePaths: [],
      advisor: {
        status: snapshot.signalFiles > 0 ? "applied" : "skipped",
        signalFiles: snapshot.signalFiles,
        reorderedFiles: 0,
        comboMatches: 0,
      },
    };
  }

  const ranked = groups.map((group) => {
    const score = snapshot.scoreFile({
      toolName: "grep",
      query: input.query,
      filePath: group.path ?? "",
    });
    return {
      path: group.path,
      lines: group.lines,
      originalOrder: group.originalOrder,
      score,
    };
  });

  ranked.sort((left, right) => {
    if (left.score.comboThresholdHit !== right.score.comboThresholdHit) {
      return left.score.comboThresholdHit ? -1 : 1;
    }
    if (left.score.comboBias !== right.score.comboBias) {
      return right.score.comboBias - left.score.comboBias;
    }
    if (left.score.pathScore !== right.score.pathScore) {
      return right.score.pathScore - left.score.pathScore;
    }
    return left.originalOrder - right.originalOrder;
  });

  const reorderedFiles = ranked.filter((group, index) => group.originalOrder !== index).length;
  const candidatePaths = ranked
    .map((group) => group.path)
    .filter((path): path is string => Boolean(path));
  return {
    lines: ranked.flatMap((group) => group.lines),
    candidatePaths,
    advisor: {
      status:
        reorderedFiles > 0 ||
        snapshot.signalFiles > 0 ||
        ranked.some((group) => group.score.comboHits > 0)
          ? "applied"
          : "skipped",
      signalFiles: snapshot.signalFiles,
      reorderedFiles,
      comboMatches: Math.max(0, ...ranked.map((group) => group.score.comboHits)),
    },
  };
}

export function deriveBroadenedPaths(cwd: string, paths: string[]): string[] {
  const broadened = new Set<string>();
  for (const path of paths) {
    const normalized = path.replaceAll("\\", "/");
    if (normalized === ".") {
      broadened.add(".");
      continue;
    }
    const absolutePath = isAbsolute(path) ? path : resolve(cwd, path);
    let broadenedPath = dirname(absolutePath);
    try {
      const stats = statSync(absolutePath);
      if (stats.isDirectory()) {
        broadenedPath = dirname(absolutePath);
      }
    } catch {
      broadenedPath = dirname(absolutePath);
    }
    const relativePath = relative(cwd, broadenedPath).replaceAll("\\", "/");
    broadened.add(relativePath.length === 0 ? "." : relativePath);
  }
  return [...broadened];
}

export function buildAdvisorHeader(header: string[], advisor: GrepAdvisorDetails): string[] {
  const nextHeader = [...header];
  nextHeader.push(`- advisor_status: ${advisor.status}`);
  nextHeader.push(`- advisor_signal_files: ${advisor.signalFiles}`);
  nextHeader.push(`- advisor_reordered_files: ${advisor.reorderedFiles}`);
  if (advisor.autoBroaden) {
    nextHeader.push(`- auto_broadened_from: ${advisor.autoBroaden.from.join(", ")}`);
    nextHeader.push(`- auto_broadened_to: ${advisor.autoBroaden.to.join(", ")}`);
  }
  if (advisor.fuzzyRetry) {
    nextHeader.push(`- fuzzy_retry_from: ${advisor.fuzzyRetry.from}`);
    nextHeader.push(`- fuzzy_retry_to: ${advisor.fuzzyRetry.to}`);
  }
  return nextHeader;
}

export function buildGrepTocSuggestions(input: {
  runtime?: BrewvaToolOptions["runtime"];
  sessionId?: string;
  baseCwd: string;
  roots: string[];
  query: string;
  cacheStore: TocSearchSessionCacheStore;
}): GrepSuggestionItem[] {
  const core = runTocSearchCore({
    runtime: input.runtime,
    sessionId: input.sessionId,
    baseDir: input.baseCwd,
    roots: input.roots,
    queryText: input.query,
    limit: GREP_TOC_SUGGESTION_LIMIT,
    cacheStore: input.cacheStore,
    maxCandidateFiles: GREP_TOC_SUGGESTION_MAX_FILES,
    maxIndexedBytes: GREP_TOC_SUGGESTION_MAX_INDEXED_BYTES,
  });
  if (
    core.tokens.length === 0 ||
    core.scopeOverflow ||
    core.noSupportedFiles ||
    core.noAccessibleFiles ||
    core.noIndexableFiles ||
    core.rankedMatches.length === 0
  ) {
    return [];
  }
  return core.rankedMatches.slice(0, GREP_TOC_SUGGESTION_LIMIT).map((match) => {
    const displayPath = normalizeRelativePath(input.baseCwd, match.filePath);
    return {
      path: normalizeSearchAdvisorPath(input.baseCwd, match.filePath) ?? displayPath,
      text: `${displayPath} (toc ${match.kind} ${match.name} @ ${formatLineSpan(match.lineStart, match.lineEnd)})`,
      source: "toc",
    };
  });
}

export function finalizeSuggestionItems(input: {
  comboPath?: string;
  hotFiles: string[];
  tocSuggestions: GrepSuggestionItem[];
}): GrepSuggestionItem[] {
  const items: GrepSuggestionItem[] = [];
  if (input.comboPath) {
    items.push({
      path: input.comboPath,
      text: input.comboPath,
      source: "combo",
    });
  }
  items.push(...input.tocSuggestions);
  for (const hotFile of input.hotFiles) {
    items.push({
      path: hotFile,
      text: hotFile,
      source: "path",
    });
  }

  const unique: GrepSuggestionItem[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (!item.path || seen.has(item.path)) {
      continue;
    }
    seen.add(item.path);
    unique.push(item);
    if (unique.length >= GREP_MAX_SUGGESTIONS) {
      break;
    }
  }
  return unique;
}

export function resolveSuggestionMode(items: GrepSuggestionItem[]): GrepSuggestionMode {
  const sources = [...new Set(items.map((item) => item.source))];
  const primarySource = sources[0];
  if (!primarySource) {
    return "path";
  }
  return sources.length === 1 ? primarySource : "hybrid";
}
