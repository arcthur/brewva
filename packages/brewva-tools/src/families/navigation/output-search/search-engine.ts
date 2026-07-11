import { tokenizeSearchQuery } from "@brewva/brewva-search";
import { clamp01 } from "@brewva/brewva-std/math";
import Fuse from "fuse.js";
import {
  EXACT_LINE_HIT_BONUS,
  EXACT_QUERY_BONUS,
  EXACT_TOKEN_BONUS,
  FUSE_SCORE_SCALE,
  LINE_FUSE_THRESHOLD,
  MAX_CONFIDENT_FUZZY_LINE_SCORE,
  MAX_CONFIDENT_FUZZY_TOKEN_SCORE,
  MAX_LINE_FUSE_RESULTS,
  MIN_FUZZY_TOKEN_COVERAGE,
  PARTIAL_PREFIX_BONUS,
  PARTIAL_TOKEN_BONUS,
  TOKEN_FUSE_THRESHOLD,
} from "./constants.js";
import type {
  ArtifactSearchMatch,
  ArtifactSearchResult,
  PreparedArtifact,
  QueryMatch,
  QueryProfile,
  SearchableLine,
  SearchableToken,
} from "./types.js";

function tokenizeLineWords(line: string): string[] {
  return tokenizeSearchQuery(line, { minLength: 3 });
}

export function createQueryProfile(query: string): QueryProfile | null {
  const tokens = tokenizeSearchQuery(query, { minLength: 2 });
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
  const bounded = clamp01(score);
  return (1 - bounded) * scale;
}

export function prepareArtifact(content: string): PreparedArtifact {
  const lines = content.split(/\r?\n/u);
  const searchableLines = lines.map((line, lineIndex) => createSearchableLine(line, lineIndex));
  return {
    lines,
    searchableLines,
    lineFuse: createLineFuse(searchableLines),
    tokenFuse: createTokenFuse(searchableLines),
  };
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

export function searchArtifact(input: {
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

export function isConfidentFuzzyMatch(match: QueryMatch): boolean {
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
