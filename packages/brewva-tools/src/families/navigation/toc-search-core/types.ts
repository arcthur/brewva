import type { LRUCache } from "lru-cache";

export type TocDeclarationKind = "interface" | "type_alias" | "enum";
export type TocSymbolKind =
  | "function"
  | "const_function"
  | "class"
  | TocDeclarationKind
  | "method"
  | "getter"
  | "setter";
export type TocSearchMatchKind = TocSymbolKind | "module" | "import";

export interface TocImportEntry {
  source: string;
  clause: string | null;
  lineStart: number;
  lineEnd: number;
}

export interface TocMethodEntry {
  kind: "method" | "getter" | "setter";
  name: string;
  static: boolean;
  lineStart: number;
  lineEnd: number;
  signature: string;
  summary: string | null;
}

export interface TocFunctionEntry {
  kind: "function" | "const_function";
  name: string;
  exported: boolean;
  lineStart: number;
  lineEnd: number;
  signature: string;
  summary: string | null;
}

export interface TocClassEntry {
  kind: "class";
  name: string;
  exported: boolean;
  lineStart: number;
  lineEnd: number;
  signature: string;
  summary: string | null;
  methods: TocMethodEntry[];
}

export interface TocDeclarationEntry {
  kind: TocDeclarationKind;
  name: string;
  exported: boolean;
  lineStart: number;
  lineEnd: number;
  signature: string;
  summary: string | null;
}

export interface TocDocument {
  filePath: string;
  language: string;
  moduleSummary: string | null;
  imports: TocImportEntry[];
  functions: TocFunctionEntry[];
  classes: TocClassEntry[];
  declarations: TocDeclarationEntry[];
}

export interface TocSearchMatch {
  filePath: string;
  kind: TocSearchMatchKind;
  name: string;
  score: number;
  lineStart: number;
  lineEnd: number;
  signature: string | null;
  summary: string | null;
  parentName: string | null;
}

export interface TocCacheEntry {
  signature: string;
  toc: TocDocument;
}

export interface TocLookupResult {
  toc: TocDocument;
  cacheHit: boolean;
}

export interface TocSearchSummary {
  indexedFiles: number;
  candidateFiles: number;
  cacheHits: number;
  cacheMisses: number;
  skippedFiles: number;
  oversizedFiles: number;
  indexedBytes: number;
}

export interface TocSearchCoreAdvisor {
  status: "applied" | "skipped";
  signalFiles: number;
  reorderedMatches: number;
  comboMatches: number;
  scoringMode: "multiplicative";
  hotFiles: string[];
  comboSuggestion?: string;
}

export interface TocSearchCoreResult {
  queryText: string;
  query: string;
  tokens: string[];
  scopeOverflow: boolean;
  scopedFileCount: number;
  noSupportedFiles: boolean;
  noAccessibleFiles: boolean;
  noIndexableFiles: boolean;
  budgetExceeded: boolean;
  broadQuery: boolean;
  summary: TocSearchSummary;
  rankedMatches: TocSearchMatch[];
  advisor: TocSearchCoreAdvisor;
}

export interface AdvisorRankedTocMatch {
  match: TocSearchMatch;
  originalOrder: number;
  finalScore: number;
  comboMatches: number;
}

export type TocFileCache = LRUCache<string, TocCacheEntry>;
export type TocSearchSessionCacheStore = LRUCache<string, TocFileCache>;
