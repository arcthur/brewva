import type Fuse from "fuse.js";

export type ArtifactCandidate = {
  artifactRef: string;
  absolutePath: string;
  toolName: string;
  timestamp: number;
  rawBytes: number | null;
};

export type QueryMatch = {
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

export type SearchLayer = "exact" | "partial" | "fuzzy";
export type SearchThrottleLevel = "normal" | "limited" | "blocked";

export type QueryProfile = {
  normalizedQuery: string;
  tokens: string[];
  partialTokens: string[];
  fuzzyTokens: string[];
};

export type SearchThrottleState = {
  level: SearchThrottleLevel;
  effectiveLimit: number;
  recentSingleQueryCalls: number;
};

export type SearchableLine = {
  lineIndex: number;
  lowerText: string;
  tokens: string[];
  tokenSet: ReadonlySet<string>;
  tokenString: string;
};

export type SearchableToken = {
  lineIndex: number;
  token: string;
};

export type ArtifactSearchMatch = {
  score: number;
  snippet: string;
  matchedLineCount: number;
  fuzzyTokenCoverage: number | null;
  bestFuseScore: number | null;
  bestFuzzyTokenScore: number | null;
};

export type PreparedArtifact = {
  lines: string[];
  searchableLines: SearchableLine[];
  lineFuse: Fuse<SearchableLine>;
  tokenFuse: Fuse<SearchableToken>;
};

export type ArtifactSearchResult = {
  exact: ArtifactSearchMatch | null;
  partial: ArtifactSearchMatch | null;
  fuzzy: ArtifactSearchMatch | null;
};

export type ArtifactCacheEntry = {
  size: number;
  mtimeMs: number;
  estimatedBytes: number;
  prepared: PreparedArtifact;
};

export type ArtifactLoadStats = {
  cacheHits: number;
  cacheMisses: number;
  localCacheHits: number;
  globalCacheHits: number;
};
