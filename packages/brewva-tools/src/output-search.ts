import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";
import type { BrewvaEventRecord } from "@brewva/brewva-runtime";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import Fuse from "fuse.js";
import { LRUCache } from "lru-cache";
import { tokenizeSearchTerms } from "./shared/query.js";
import type { BrewvaToolOptions } from "./types.js";
import { inconclusiveTextResult, textResult } from "./utils/result.js";
import { getSessionId } from "./utils/session.js";
import { defineBrewvaTool } from "./utils/tool.js";

const DEFAULT_RESULTS_PER_QUERY = 2;
const DEFAULT_ARTIFACT_EVENTS = 120;
const DEFAULT_MAX_ARTIFACT_BYTES = 1_000_000;
const DEFAULT_MAX_OUTPUT_CHARS = 12_000;
const SEARCH_THROTTLE_WINDOW_MS = 90_000;
const SEARCH_THROTTLE_REDUCE_AFTER = 4;
const SEARCH_THROTTLE_BLOCK_AFTER = 10;
const SEARCH_THROTTLE_EVENT_LOOKBACK = 120;
const MAX_RESULTS_PER_QUERY = 5;
const MAX_ARTIFACT_EVENTS = 500;
const MAX_ARTIFACT_BYTES = 10_000_000;
const MAX_OUTPUT_CHARS = 36_000;
const MAX_ARTIFACT_CACHE_ENTRIES = 256;
const MAX_ARTIFACT_CACHE_BYTES = 32 * 1024 * 1024;
const SEARCH_LAYERS: readonly SearchLayer[] = ["exact", "partial", "fuzzy"];
const LINE_FUSE_THRESHOLD = 0.45;
const TOKEN_FUSE_THRESHOLD = 0.3;
const MAX_LINE_FUSE_RESULTS = 12;
const EXACT_QUERY_BONUS = 160;
const EXACT_TOKEN_BONUS = 90;
const EXACT_LINE_HIT_BONUS = 14;
const PARTIAL_TOKEN_BONUS = 26;
const PARTIAL_PREFIX_BONUS = 12;
const MIN_FUZZY_TOKEN_COVERAGE = 0.5;
const MAX_CONFIDENT_FUZZY_TOKEN_SCORE = 0.12;
const MAX_CONFIDENT_FUZZY_LINE_SCORE = 0.35;
const FUSE_SCORE_SCALE = 100;

type ArtifactCandidate = {
  artifactRef: string;
  absolutePath: string;
  toolName: string;
  timestamp: number;
  rawBytes: number | null;
};

type QueryMatch = {
  artifactRef: string;
  toolName: string;
  score: number;
  timestamp: number;
  snippet: string;
  matchedLineCount: number;
  layer: SearchLayer;
  fuzzyTokenCoverage: number | null;
  bestFuseScore: number | null;
  bestFuzzyTokenScore: number | null;
};

type SearchLayer = "exact" | "partial" | "fuzzy";
type SearchThrottleLevel = "normal" | "limited" | "blocked";

type QueryProfile = {
  normalizedQuery: string;
  tokens: string[];
  partialTokens: string[];
  fuzzyTokens: string[];
};

type SearchThrottleState = {
  level: SearchThrottleLevel;
  effectiveLimit: number;
  recentSingleQueryCalls: number;
};

type SearchableLine = {
  lineIndex: number;
  lowerText: string;
  tokens: string[];
  tokenSet: ReadonlySet<string>;
  tokenString: string;
};

type SearchableToken = {
  lineIndex: number;
  token: string;
};

type ArtifactSearchMatch = {
  score: number;
  snippet: string;
  matchedLineCount: number;
  fuzzyTokenCoverage: number | null;
  bestFuseScore: number | null;
  bestFuzzyTokenScore: number | null;
};

type PreparedArtifact = {
  lines: string[];
  searchableLines: SearchableLine[];
  lineFuse: Fuse<SearchableLine>;
  tokenFuse: Fuse<SearchableToken>;
};

type ArtifactSearchResult = {
  exact: ArtifactSearchMatch | null;
  partial: ArtifactSearchMatch | null;
  fuzzy: ArtifactSearchMatch | null;
};

type ArtifactCacheEntry = {
  size: number;
  mtimeMs: number;
  estimatedBytes: number;
  prepared: PreparedArtifact;
};

type ArtifactLoadStats = {
  cacheHits: number;
  cacheMisses: number;
  localCacheHits: number;
  globalCacheHits: number;
};

const artifactCache = new LRUCache<string, ArtifactCacheEntry>({
  max: MAX_ARTIFACT_CACHE_ENTRIES,
  maxSize: MAX_ARTIFACT_CACHE_BYTES,
  sizeCalculation: (entry) => entry.estimatedBytes,
});

function normalizeText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function normalizePositiveInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function normalizeOptionalQueryList(params: { query?: unknown; queries?: unknown }): string[] {
  const queryList: string[] = [];
  const single = normalizeText(params.query);
  if (single) queryList.push(single);

  if (Array.isArray(params.queries)) {
    for (const item of params.queries) {
      const value = normalizeText(item);
      if (value) queryList.push(value);
    }
  }

  return [...new Set(queryList)];
}

function normalizeToolName(value: string): string {
  return value.trim().toLowerCase();
}

function isPathInsideRoot(path: string, root: string): boolean {
  const resolvedPath = resolve(path);
  const resolvedRoot = resolve(root);
  if (resolvedPath === resolvedRoot) return true;
  const rootPrefix = resolvedRoot.endsWith(sep) ? resolvedRoot : `${resolvedRoot}${sep}`;
  return resolvedPath.startsWith(rootPrefix);
}

function buildArtifactCacheKey(cacheScope: string, absolutePath: string): string {
  return `${cacheScope}::${absolutePath}`;
}

function resolveArtifactPath(artifactRef: string, roots: string[]): string | undefined {
  if (isAbsolute(artifactRef)) {
    return existsSync(artifactRef) ? artifactRef : undefined;
  }

  for (const root of roots) {
    const absolutePath = resolve(root, artifactRef);
    if (!isPathInsideRoot(absolutePath, root)) continue;
    if (existsSync(absolutePath)) return absolutePath;
  }
  return undefined;
}

function extractArtifactCandidates(input: {
  events: BrewvaEventRecord[];
  roots: string[];
  maxCandidates: number;
  toolFilter?: string;
}): ArtifactCandidate[] {
  const toolFilter = input.toolFilter ? normalizeToolName(input.toolFilter) : undefined;
  const seenRefs = new Set<string>();
  const candidates: ArtifactCandidate[] = [];

  for (let index = input.events.length - 1; index >= 0; index -= 1) {
    const event = input.events[index];
    if (!event) continue;

    const payload = event.payload ?? {};
    const artifactRef = normalizeText(payload.artifactRef);
    if (!artifactRef || seenRefs.has(artifactRef)) continue;

    const toolName = normalizeText(payload.toolName) ?? "unknown";
    if (toolFilter && normalizeToolName(toolName) !== toolFilter) continue;

    const absolutePath = resolveArtifactPath(artifactRef, input.roots);
    if (!absolutePath) continue;

    const rawBytes =
      typeof payload.rawBytes === "number" && Number.isFinite(payload.rawBytes)
        ? Math.max(0, Math.floor(payload.rawBytes))
        : null;

    seenRefs.add(artifactRef);
    candidates.push({
      artifactRef,
      absolutePath,
      toolName,
      timestamp: event.timestamp,
      rawBytes,
    });
    if (candidates.length >= input.maxCandidates) break;
  }

  return candidates;
}

function tokenizeLineWords(line: string): string[] {
  return tokenizeSearchTerms(line, { minLength: 3 });
}

function createQueryProfile(query: string): QueryProfile | null {
  const tokens = tokenizeSearchTerms(query);
  if (tokens.length === 0) return null;

  const partialTokens = [
    ...new Set(
      tokens
        .filter((token) => token.length >= 4)
        .map((token) => token.slice(0, Math.max(3, token.length - 1))),
    ),
  ];
  const fuzzyTokens = tokens.filter((token) => token.length >= 6);

  return {
    normalizedQuery: query.toLowerCase(),
    tokens,
    partialTokens,
    fuzzyTokens,
  };
}

function createSearchableLine(line: string, lineIndex: number): SearchableLine {
  const lowerText = line.toLowerCase();
  const tokens = tokenizeLineWords(lowerText);
  return {
    lineIndex,
    lowerText,
    tokens,
    tokenSet: new Set(tokens),
    tokenString: tokens.join(" "),
  };
}

function createLineFuse(searchableLines: readonly SearchableLine[]): Fuse<SearchableLine> {
  return new Fuse(searchableLines, {
    includeScore: true,
    ignoreLocation: true,
    threshold: LINE_FUSE_THRESHOLD,
    minMatchCharLength: 2,
    keys: [
      { name: "lowerText", weight: 2.4 },
      { name: "tokenString", weight: 1.8 },
    ],
  });
}

function createTokenFuse(searchableLines: readonly SearchableLine[]): Fuse<SearchableToken> {
  return new Fuse(
    searchableLines.flatMap((line) =>
      line.tokens.map((token) => ({ lineIndex: line.lineIndex, token })),
    ),
    {
      includeScore: true,
      ignoreLocation: true,
      threshold: TOKEN_FUSE_THRESHOLD,
      minMatchCharLength: 3,
      keys: ["token"],
    },
  );
}

function countExactTokenHits(line: SearchableLine, tokens: readonly string[]): number {
  let matches = 0;
  for (const token of tokens) {
    if (line.tokenSet.has(token)) {
      matches += 1;
    }
  }
  return matches;
}

function countSubstringHits(lowerLine: string, tokens: readonly string[]): number {
  let matches = 0;
  for (const token of tokens) {
    if (lowerLine.includes(token)) {
      matches += 1;
    }
  }
  return matches;
}

function scoreFuseResult(score: number | undefined, scale = FUSE_SCORE_SCALE): number {
  if (typeof score !== "number" || !Number.isFinite(score)) {
    return 0;
  }
  const bounded = Math.max(0, Math.min(1, score));
  return (1 - bounded) * scale;
}

function computeSearchThrottle(input: {
  events: BrewvaEventRecord[];
  queryCount: number;
  requestedLimit: number;
  now?: number;
}): SearchThrottleState {
  if (input.queryCount !== 1) {
    return {
      level: "normal",
      effectiveLimit: input.requestedLimit,
      recentSingleQueryCalls: 0,
    };
  }

  const now = input.now ?? Date.now();
  let recentSingleQueryCalls = 0;

  for (const event of input.events) {
    if (!event) continue;
    if (now - event.timestamp > SEARCH_THROTTLE_WINDOW_MS) continue;

    const payload = event.payload ?? {};
    const previousQueryCount =
      typeof payload.queryCount === "number" && Number.isFinite(payload.queryCount)
        ? Math.max(0, Math.floor(payload.queryCount))
        : 0;
    if (previousQueryCount === 1) {
      recentSingleQueryCalls += 1;
    }
  }

  const projectedSingleQueryCalls = recentSingleQueryCalls + 1;
  if (projectedSingleQueryCalls > SEARCH_THROTTLE_BLOCK_AFTER) {
    return {
      level: "blocked",
      effectiveLimit: 0,
      recentSingleQueryCalls,
    };
  }

  if (projectedSingleQueryCalls > SEARCH_THROTTLE_REDUCE_AFTER) {
    return {
      level: "limited",
      effectiveLimit: Math.min(input.requestedLimit, 1),
      recentSingleQueryCalls,
    };
  }

  return {
    level: "normal",
    effectiveLimit: input.requestedLimit,
    recentSingleQueryCalls,
  };
}

function prepareArtifact(content: string): PreparedArtifact {
  const lines = content.split(/\r?\n/u);
  const searchableLines = lines.map((line, lineIndex) => createSearchableLine(line, lineIndex));
  return {
    lines,
    searchableLines,
    lineFuse: createLineFuse(searchableLines),
    tokenFuse: createTokenFuse(searchableLines),
  };
}

function estimateCacheEntryBytes(rawBytes: number): number {
  return Math.max(rawBytes, rawBytes * 4);
}

function getPreparedArtifact(input: {
  cacheScope: string;
  absolutePath: string;
  maxArtifactBytes: number;
  localCache: Map<string, PreparedArtifact>;
  skippedLargePaths: Set<string>;
  readFailurePaths: Set<string>;
  stats: ArtifactLoadStats;
}): PreparedArtifact | undefined {
  const local = input.localCache.get(input.absolutePath);
  if (local) {
    input.stats.cacheHits += 1;
    input.stats.localCacheHits += 1;
    return local;
  }

  try {
    const fileStat = statSync(input.absolutePath);
    if (fileStat.size > input.maxArtifactBytes) {
      input.skippedLargePaths.add(input.absolutePath);
      return undefined;
    }

    const cacheKey = buildArtifactCacheKey(input.cacheScope, input.absolutePath);
    const cached = artifactCache.get(cacheKey);
    if (cached && cached.size === fileStat.size && cached.mtimeMs === fileStat.mtimeMs) {
      input.localCache.set(input.absolutePath, cached.prepared);
      input.stats.cacheHits += 1;
      input.stats.globalCacheHits += 1;
      return cached.prepared;
    }

    const content = readFileSync(input.absolutePath, "utf8");
    const prepared = prepareArtifact(content);
    artifactCache.set(cacheKey, {
      size: fileStat.size,
      mtimeMs: fileStat.mtimeMs,
      estimatedBytes: estimateCacheEntryBytes(Buffer.byteLength(content, "utf8")),
      prepared,
    });
    input.localCache.set(input.absolutePath, prepared);
    input.stats.cacheMisses += 1;
    return prepared;
  } catch {
    input.readFailurePaths.add(input.absolutePath);
    return undefined;
  }
}

function buildSnippet(lines: string[], hitIndexes: number[], maxChars: number): string {
  const ranges: Array<{ start: number; end: number }> = [];
  for (const index of hitIndexes.slice(0, 3)) {
    const start = Math.max(0, index - 2);
    const end = Math.min(lines.length - 1, index + 2);
    ranges.push({ start, end });
  }

  const sortedRanges = ranges.toSorted((left, right) => left.start - right.start);
  const merged: Array<{ start: number; end: number }> = [];
  for (const range of sortedRanges) {
    const last = merged[merged.length - 1];
    if (!last || range.start > last.end + 1) {
      merged.push({ ...range });
      continue;
    }
    last.end = Math.max(last.end, range.end);
  }

  const blocks: string[] = [];
  for (const range of merged) {
    const blockLines: string[] = [];
    for (let lineIndex = range.start; lineIndex <= range.end; lineIndex += 1) {
      const line = lines[lineIndex] ?? "";
      blockLines.push(`L${lineIndex + 1}: ${line}`);
    }
    blocks.push(blockLines.join("\n"));
  }

  const combined = blocks.join("\n...\n");
  if (combined.length <= maxChars) return combined;
  const keep = Math.max(16, maxChars - 3);
  return `${combined.slice(0, keep)}...`;
}

function buildArtifactSearchMatch(input: {
  lines: string[];
  hits: Array<{ lineIndex: number; score: number }>;
  snippetMaxChars: number;
  fuzzyTokenCoverage?: number | null;
  bestFuseScore?: number | null;
  bestFuzzyTokenScore?: number | null;
}): ArtifactSearchMatch | null {
  if (input.hits.length === 0) {
    return null;
  }

  const hits = [...input.hits].toSorted(
    (left, right) => right.score - left.score || left.lineIndex - right.lineIndex,
  );
  const topLineIndexes = hits.slice(0, 3).map((hit) => hit.lineIndex);
  return {
    score: (hits[0]?.score ?? 0) + Math.min(hits.length, 6) * 3,
    snippet: buildSnippet(input.lines, topLineIndexes, input.snippetMaxChars),
    matchedLineCount: hits.length,
    fuzzyTokenCoverage: input.fuzzyTokenCoverage ?? null,
    bestFuseScore: input.bestFuseScore ?? null,
    bestFuzzyTokenScore: input.bestFuzzyTokenScore ?? null,
  };
}

function collectFuzzySignal(
  prepared: PreparedArtifact,
  queryProfile: QueryProfile,
): { coverage: number; bestTokenScore: number | null } | null {
  if (queryProfile.fuzzyTokens.length === 0) {
    return null;
  }

  let matchedTokens = 0;
  let bestTokenScore = Number.POSITIVE_INFINITY;
  for (const token of queryProfile.fuzzyTokens) {
    const bestMatch = prepared.tokenFuse.search(token, { limit: 1 })[0];
    if (
      bestMatch &&
      typeof bestMatch.score === "number" &&
      bestMatch.score <= MAX_CONFIDENT_FUZZY_TOKEN_SCORE
    ) {
      matchedTokens += 1;
      bestTokenScore = Math.min(bestTokenScore, bestMatch.score);
    }
  }

  return {
    coverage: matchedTokens / queryProfile.fuzzyTokens.length,
    bestTokenScore: Number.isFinite(bestTokenScore) ? bestTokenScore : null,
  };
}

function searchArtifact(input: {
  prepared: PreparedArtifact;
  queryProfile: QueryProfile;
  snippetMaxChars: number;
}): ArtifactSearchResult {
  const lines = input.prepared.lines;
  if (input.queryProfile.tokens.length === 0) {
    return {
      exact: null,
      partial: null,
      fuzzy: null,
    };
  }

  const exactHits: Array<{ lineIndex: number; score: number }> = [];
  for (const line of input.prepared.searchableLines) {
    const exactQueryMatch =
      input.queryProfile.normalizedQuery.length >= 3 &&
      line.lowerText.includes(input.queryProfile.normalizedQuery);
    const exactTokenHits = countExactTokenHits(line, input.queryProfile.tokens);
    const allExactTokensMatch =
      input.queryProfile.tokens.length > 0 && exactTokenHits === input.queryProfile.tokens.length;
    if (!exactQueryMatch && !allExactTokensMatch) {
      continue;
    }

    let score = 0;
    if (exactQueryMatch) score += EXACT_QUERY_BONUS;
    if (allExactTokensMatch) score += EXACT_TOKEN_BONUS;
    score += exactTokenHits * EXACT_LINE_HIT_BONUS;
    exactHits.push({ lineIndex: line.lineIndex, score });
  }

  const lineResults = input.prepared.lineFuse.search(input.queryProfile.normalizedQuery, {
    limit: MAX_LINE_FUSE_RESULTS,
  });
  const partialHits: Array<{ lineIndex: number; score: number }> = [];
  const fuzzyHits: Array<{ lineIndex: number; score: number }> = [];
  for (const result of lineResults) {
    const line = result.item;
    const exactTokenHits = countExactTokenHits(line, input.queryProfile.tokens);
    const partialTokenHits = countSubstringHits(line.lowerText, input.queryProfile.partialTokens);
    const baseScore = scoreFuseResult(result.score);

    if (exactTokenHits > 0 || partialTokenHits > 0) {
      partialHits.push({
        lineIndex: line.lineIndex,
        score:
          baseScore +
          exactTokenHits * PARTIAL_TOKEN_BONUS +
          partialTokenHits * PARTIAL_PREFIX_BONUS,
      });
    }

    fuzzyHits.push({
      lineIndex: line.lineIndex,
      score: baseScore,
    });
  }

  return {
    exact: buildArtifactSearchMatch({
      lines,
      hits: exactHits,
      snippetMaxChars: input.snippetMaxChars,
    }),
    partial: buildArtifactSearchMatch({
      lines,
      hits: partialHits,
      snippetMaxChars: input.snippetMaxChars,
      bestFuseScore: lineResults[0]?.score ?? null,
    }),
    fuzzy: (() => {
      const fuzzySignal = collectFuzzySignal(input.prepared, input.queryProfile);
      if (!fuzzySignal) {
        return null;
      }
      return buildArtifactSearchMatch({
        lines,
        hits: fuzzyHits,
        snippetMaxChars: input.snippetMaxChars,
        fuzzyTokenCoverage: fuzzySignal.coverage,
        bestFuseScore: lineResults[0]?.score ?? null,
        bestFuzzyTokenScore: fuzzySignal.bestTokenScore,
      });
    })(),
  };
}

function isConfidentFuzzyMatch(match: QueryMatch): boolean {
  if (match.layer !== "fuzzy") return true;
  const coverage = match.fuzzyTokenCoverage ?? 0;
  const bestFuseScore = match.bestFuseScore ?? 1;
  const bestFuzzyTokenScore = match.bestFuzzyTokenScore ?? 1;
  return (
    coverage >= MIN_FUZZY_TOKEN_COVERAGE &&
    bestFuseScore <= MAX_CONFIDENT_FUZZY_LINE_SCORE &&
    bestFuzzyTokenScore <= MAX_CONFIDENT_FUZZY_TOKEN_SCORE
  );
}

function clampOutput(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const keep = Math.max(32, maxChars - 64);
  return `${text.slice(0, keep)}\n...[output truncated due to max_output_chars]`;
}

export function createOutputSearchTool(options: BrewvaToolOptions): ToolDefinition {
  return defineBrewvaTool({
    name: "output_search",
    label: "Output Search",
    description:
      "Search persisted tool output artifacts for the current session and return compact snippets by query.",
    promptSnippet: "Search persisted tool-output artifacts before rerunning expensive commands.",
    promptGuidelines: [
      "Prefer this when prior command output, logs, or verification artifacts may already exist in the session.",
    ],
    parameters: Type.Object({
      query: Type.Optional(Type.String({ minLength: 1 })),
      queries: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1 })),
      tool: Type.Optional(Type.String({ minLength: 1 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_RESULTS_PER_QUERY })),
      artifacts_last: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_ARTIFACT_EVENTS })),
      max_artifact_bytes: Type.Optional(
        Type.Integer({ minimum: 1024, maximum: MAX_ARTIFACT_BYTES }),
      ),
      max_output_chars: Type.Optional(Type.Integer({ minimum: 400, maximum: MAX_OUTPUT_CHARS })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const sessionId = getSessionId(ctx);
      const queryList = normalizeOptionalQueryList({
        query: params.query,
        queries: params.queries,
      });
      const limit = normalizePositiveInt(
        params.limit,
        DEFAULT_RESULTS_PER_QUERY,
        1,
        MAX_RESULTS_PER_QUERY,
      );
      const artifactsLast = normalizePositiveInt(
        params.artifacts_last,
        DEFAULT_ARTIFACT_EVENTS,
        1,
        MAX_ARTIFACT_EVENTS,
      );
      const maxArtifactBytes = normalizePositiveInt(
        params.max_artifact_bytes,
        DEFAULT_MAX_ARTIFACT_BYTES,
        1024,
        MAX_ARTIFACT_BYTES,
      );
      const maxOutputChars = normalizePositiveInt(
        params.max_output_chars,
        DEFAULT_MAX_OUTPUT_CHARS,
        400,
        MAX_OUTPUT_CHARS,
      );

      const roots = [
        normalizeText((ctx as { cwd?: unknown }).cwd),
        normalizeText(options.runtime.cwd),
      ].filter((value): value is string => Boolean(value));
      const uniqueRoots = [...new Set(roots.map((root) => resolve(root)))];
      const recordSearchEvent = (payload: Record<string, unknown>) => {
        options.runtime.events.record?.({
          sessionId,
          type: "tool_output_search",
          payload,
        });
      };
      const recentSearchEvents =
        queryList.length > 0
          ? options.runtime.events.list(sessionId, {
              type: "tool_output_search",
              last: SEARCH_THROTTLE_EVENT_LOOKBACK,
            })
          : [];
      const throttleState =
        queryList.length > 0
          ? computeSearchThrottle({
              events: recentSearchEvents,
              queryCount: queryList.length,
              requestedLimit: limit,
            })
          : {
              level: "normal" as const,
              effectiveLimit: limit,
              recentSingleQueryCalls: 0,
            };
      const effectiveLimit = Math.max(1, throttleState.effectiveLimit);

      const events = options.runtime.events.list(sessionId, {
        type: "tool_output_artifact_persisted",
        last: Math.min(MAX_ARTIFACT_EVENTS * 4, Math.max(artifactsLast * 4, 60)),
      });
      const candidates = extractArtifactCandidates({
        events,
        roots: uniqueRoots,
        maxCandidates: artifactsLast,
        toolFilter: normalizeText(params.tool),
      });

      if (candidates.length === 0) {
        return textResult("[OutputSearch]\nNo artifact candidates found for current session.", {
          sessionId,
          artifactsScanned: 0,
          queries: queryList,
        });
      }

      if (queryList.length > 0 && throttleState.level === "blocked") {
        const blockedText = [
          "[OutputSearch]",
          "Blocked due to high-frequency single-query search calls.",
          `Window: ${Math.round(SEARCH_THROTTLE_WINDOW_MS / 1000)}s`,
          `Recent single-query calls: ${throttleState.recentSingleQueryCalls + 1}`,
          `Artifacts considered: ${candidates.length}`,
          "Use queries=[...] to batch related questions in one call.",
        ].join("\n");

        recordSearchEvent({
          queryCount: queryList.length,
          artifactsConsidered: candidates.length,
          artifactsLoaded: 0,
          cacheHits: 0,
          cacheMisses: 0,
          localCacheHits: 0,
          globalCacheHits: 0,
          skippedLarge: 0,
          readFailures: 0,
          resultCount: 0,
          toolFilter: normalizeText(params.tool) ?? null,
          requestedLimit: limit,
          effectiveLimit: 0,
          throttleLevel: throttleState.level,
          throttleWindowMs: SEARCH_THROTTLE_WINDOW_MS,
          recentSingleQueryCalls: throttleState.recentSingleQueryCalls,
          blocked: true,
        });

        return inconclusiveTextResult(clampOutput(blockedText, maxOutputChars), {
          sessionId,
          queryCount: queryList.length,
          artifactsConsidered: candidates.length,
          throttleLevel: throttleState.level,
          recentSingleQueryCalls: throttleState.recentSingleQueryCalls,
          blocked: true,
        });
      }

      if (queryList.length === 0) {
        const lines = ["[OutputSearch]", "Mode: inventory", `Artifacts: ${candidates.length}`];
        for (const [index, candidate] of candidates.slice(0, 24).entries()) {
          const size = candidate.rawBytes !== null ? `${candidate.rawBytes}B` : "unknown";
          lines.push(
            `${index + 1}. tool=${candidate.toolName} bytes=${size} ref=${candidate.artifactRef}`,
          );
        }
        if (candidates.length > 24) {
          lines.push(`... (${candidates.length - 24} more artifacts omitted)`);
        }
        return textResult(clampOutput(lines.join("\n"), maxOutputChars), {
          sessionId,
          mode: "inventory",
          artifactsScanned: candidates.length,
        });
      }

      const contentCache = new Map<string, PreparedArtifact>();
      const cacheScope = resolve(options.runtime.workspaceRoot ?? options.runtime.cwd ?? ".");
      const skippedLargePaths = new Set<string>();
      const readFailurePaths = new Set<string>();
      const loadStats: ArtifactLoadStats = {
        cacheHits: 0,
        cacheMisses: 0,
        localCacheHits: 0,
        globalCacheHits: 0,
      };
      const querySections: string[] = [];
      const matchCounts: Record<string, number> = {};
      const matchLayers: Record<string, SearchLayer | "none"> = {};

      for (const query of queryList) {
        const lines: string[] = [`## ${query}`];
        const queryProfile = createQueryProfile(query);
        if (!queryProfile) {
          lines.push("No valid query tokens found.");
          querySections.push(lines.join("\n"));
          matchCounts[query] = 0;
          matchLayers[query] = "none";
          continue;
        }

        let matches: QueryMatch[] = [];
        let matchedLayer: SearchLayer | "none" = "none";
        const layeredMatchesByLayer: Record<SearchLayer, QueryMatch[]> = {
          exact: [],
          partial: [],
          fuzzy: [],
        };

        for (const candidate of candidates) {
          const prepared = getPreparedArtifact({
            cacheScope,
            absolutePath: candidate.absolutePath,
            maxArtifactBytes,
            localCache: contentCache,
            skippedLargePaths,
            readFailurePaths,
            stats: loadStats,
          });
          if (!prepared) continue;

          const searched = searchArtifact({
            prepared,
            queryProfile,
            snippetMaxChars: 1_500,
          });
          for (const layer of SEARCH_LAYERS) {
            const layerMatch = searched[layer];
            if (!layerMatch) continue;

            layeredMatchesByLayer[layer].push({
              artifactRef: candidate.artifactRef,
              toolName: candidate.toolName,
              score: layerMatch.score,
              timestamp: candidate.timestamp,
              snippet: layerMatch.snippet,
              matchedLineCount: layerMatch.matchedLineCount,
              layer,
              fuzzyTokenCoverage: layerMatch.fuzzyTokenCoverage,
              bestFuseScore: layerMatch.bestFuseScore,
              bestFuzzyTokenScore: layerMatch.bestFuzzyTokenScore,
            });
          }
        }

        for (const layer of SEARCH_LAYERS) {
          const layeredMatches = layeredMatchesByLayer[layer];
          if (layer === "fuzzy") {
            const confidentFuzzyMatches = layeredMatches.filter((match) =>
              isConfidentFuzzyMatch(match),
            );
            if (confidentFuzzyMatches.length > 0) {
              matches = confidentFuzzyMatches;
              matchedLayer = layer;
              break;
            }
            continue;
          }

          if (layeredMatches.length > 0) {
            matches = layeredMatches;
            matchedLayer = layer;
            break;
          }
        }

        const topMatches = matches
          .toSorted((left, right) => right.score - left.score || right.timestamp - left.timestamp)
          .slice(0, effectiveLimit);
        matchCounts[query] = topMatches.length;
        matchLayers[query] = matchedLayer;

        if (matchedLayer !== "none") {
          lines.push(`Match layer: ${matchedLayer}`);
        }
        if (topMatches.length === 0) {
          lines.push("No matches found across exact/partial/fuzzy layers.");
          querySections.push(lines.join("\n"));
          continue;
        }

        for (const [index, match] of topMatches.entries()) {
          lines.push(
            `${index + 1}. tool=${match.toolName} layer=${match.layer} score=${match.score.toFixed(2)} lines=${match.matchedLineCount}`,
          );
          lines.push(`   ref=${match.artifactRef}`);
          lines.push(match.snippet);
        }
        querySections.push(lines.join("\n"));
      }

      const loadedArtifacts = contentCache.size;
      const skippedLarge = skippedLargePaths.size;
      const readFailures = readFailurePaths.size;

      const summary = [
        "[OutputSearch]",
        `Session: ${sessionId}`,
        `Queries: ${queryList.length}`,
        `Artifacts considered: ${candidates.length}`,
        `Artifacts loaded: ${loadedArtifacts}`,
        `Cache hits/misses: ${loadStats.cacheHits}/${loadStats.cacheMisses} (local/global: ${loadStats.localCacheHits}/${loadStats.globalCacheHits})`,
        `Skipped large: ${skippedLarge}`,
        `Read failures: ${readFailures}`,
        `Throttle: ${throttleState.level}`,
        `Result limit: ${effectiveLimit}/${limit}`,
        "",
        ...querySections,
      ].join("\n");
      const throttleWarning =
        throttleState.level === "limited"
          ? `\n\n[Throttle] single-query calls in ${Math.round(SEARCH_THROTTLE_WINDOW_MS / 1000)}s window exceeded ${SEARCH_THROTTLE_REDUCE_AFTER}; results limited to ${effectiveLimit}/query. Use queries=[...] to batch.`
          : "";

      recordSearchEvent({
        queryCount: queryList.length,
        artifactsConsidered: candidates.length,
        artifactsLoaded: loadedArtifacts,
        cacheHits: loadStats.cacheHits,
        cacheMisses: loadStats.cacheMisses,
        localCacheHits: loadStats.localCacheHits,
        globalCacheHits: loadStats.globalCacheHits,
        skippedLarge,
        readFailures,
        resultCount: Object.values(matchCounts).reduce((sum, count) => sum + count, 0),
        toolFilter: normalizeText(params.tool) ?? null,
        requestedLimit: limit,
        effectiveLimit,
        throttleLevel: throttleState.level,
        throttleWindowMs: SEARCH_THROTTLE_WINDOW_MS,
        recentSingleQueryCalls: throttleState.recentSingleQueryCalls,
        blocked: false,
        matchLayers,
      });

      return textResult(clampOutput(`${summary}${throttleWarning}`, maxOutputChars), {
        sessionId,
        queryCount: queryList.length,
        artifactsConsidered: candidates.length,
        artifactsLoaded: loadedArtifacts,
        cacheHits: loadStats.cacheHits,
        cacheMisses: loadStats.cacheMisses,
        localCacheHits: loadStats.localCacheHits,
        globalCacheHits: loadStats.globalCacheHits,
        skippedLarge,
        readFailures,
        requestedLimit: limit,
        effectiveLimit,
        throttleLevel: throttleState.level,
        recentSingleQueryCalls: throttleState.recentSingleQueryCalls,
        matchCounts,
        matchLayers,
      });
    },
  });
}
