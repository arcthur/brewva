import { statSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { scoreDocumentsByTfIdf, type TfIdfSearchDocument } from "@brewva/brewva-search";
import { relativePosixPath } from "@brewva/brewva-std/node/fs";
import { toPosixPath } from "@brewva/brewva-std/text";
import type { BrewvaToolOptions } from "../../../contracts/index.js";
import { buildSearchAdvisorSnapshot, normalizeSearchAdvisorPath } from "../search-advisor.js";
import { createSourceIntelligenceEngine } from "../source-intelligence/engine.js";
import type { SourceDocument } from "../source-intelligence/ir.js";
import type {
  GrepAdvisorDetails,
  GrepGroupedLines,
  GrepSuggestionItem,
  GrepSuggestionMode,
} from "./types.js";

const GREP_LOCATION_PATTERN = /^([^:\n]+):(?:L)?\d+(?:@[A-Za-z0-9_-]+)?(?::|\||\s|$)/u;
const GREP_SOURCE_SUGGESTION_LIMIT = 3;
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
      rawPath: match?.[1],
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
  /** Engine-provided cross-session frecency, keyed by raw match-line path. Used
   * only as a tiebreaker after the session-local combo/path signals. */
  frecencyByPath?: ReadonlyMap<string, number>;
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
      rawPath: group.rawPath,
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
    const leftFrecency = input.frecencyByPath?.get(left.rawPath ?? "") ?? 0;
    const rightFrecency = input.frecencyByPath?.get(right.rawPath ?? "") ?? 0;
    if (leftFrecency !== rightFrecency) {
      return rightFrecency - leftFrecency;
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
    const normalized = toPosixPath(path);
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
    const relativePath = relativePosixPath(cwd, broadenedPath);
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

function documentSearchText(document: SourceDocument): string {
  return [
    document.filePath,
    document.language,
    ...document.imports.map((entry) => entry.rawSpecifier),
    ...document.declarations.map((entry) => `${entry.kind} ${entry.name}`),
    ...document.calls.map((entry) => entry.callee),
  ].join("\n");
}

function formatLineSpan(startLine: number, endLine: number): string {
  return startLine === endLine ? `L${startLine}` : `L${startLine}-L${endLine}`;
}

export async function buildGrepSourceSuggestions(input: {
  baseCwd: string;
  roots: string[];
  query: string;
}): Promise<GrepSuggestionItem[]> {
  const engine = createSourceIntelligenceEngine({ workspaceRoot: input.baseCwd, maxFiles: 400 });
  const graph = await engine.buildGraph(input.roots);
  const results = scoreDocumentsByTfIdf(
    input.query,
    graph.documents.map<TfIdfSearchDocument<SourceDocument>>((document) => ({
      id: document.filePath,
      text: documentSearchText(document),
      metadata: document,
    })),
    { limit: GREP_SOURCE_SUGGESTION_LIMIT },
  );
  if (results.length === 0) {
    return [];
  }
  return results.flatMap((result) => {
    const document = result.document.metadata;
    if (!document) return [];
    const displayPath = relativePosixPath(input.baseCwd, document.filePath);
    const declaration = document.declarations[0];
    const declarationText = declaration
      ? `source ${declaration.kind} ${declaration.name} @ ${formatLineSpan(
          declaration.selectionSpan.startLine,
          declaration.selectionSpan.endLine,
        )}`
      : `source ${document.language}`;
    return {
      path: normalizeSearchAdvisorPath(input.baseCwd, document.filePath) ?? displayPath,
      text: `${displayPath} (${declarationText})`,
      source: "source",
    };
  });
}

export function finalizeSuggestionItems(input: {
  comboPath?: string;
  hotFiles: string[];
  sourceSuggestions: GrepSuggestionItem[];
}): GrepSuggestionItem[] {
  const items: GrepSuggestionItem[] = [];
  if (input.comboPath) {
    items.push({
      path: input.comboPath,
      text: input.comboPath,
      source: "combo",
    });
  }
  items.push(...input.sourceSuggestions);
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
