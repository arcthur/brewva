import { readFileSync, statSync } from "node:fs";
import { sha256Hex } from "@brewva/brewva-std/hash";
import { LRUCache } from "lru-cache";
import type { SourceDocument, SourceGraph, SourceLanguage } from "./ir.js";

export const SOURCE_INTELLIGENCE_PARSER_VERSION = "source-intelligence-ir-v1";

export interface CachedSourceText {
  readonly sourceText: string;
  readonly sourceHash: string;
  readonly mtimeMs: number;
  readonly size: number;
  readonly cacheHit: boolean;
}

const SOURCE_TEXT_CACHE = new LRUCache<string, Omit<CachedSourceText, "cacheHit">>({
  max: 512,
});

const FILE_PARSE_CACHE = new LRUCache<string, SourceDocument>({
  max: 512,
});

const DERIVED_GRAPH_CACHE = new LRUCache<string, SourceGraph>({
  max: 64,
});

export function sha256Text(input: string): string {
  return sha256Hex(input);
}

export function readSourceTextCached(filePath: string): CachedSourceText {
  const stats = statSync(filePath);
  const signature = `${filePath}\0${stats.mtimeMs}\0${stats.size}`;
  const cached = SOURCE_TEXT_CACHE.get(signature);
  if (cached) {
    return { ...cached, cacheHit: true };
  }
  const sourceText = readFileSync(filePath, "utf8");
  const sourceHash = sha256Text(sourceText);
  const entry = {
    sourceText,
    sourceHash,
    mtimeMs: stats.mtimeMs,
    size: stats.size,
  };
  SOURCE_TEXT_CACHE.set(signature, entry);
  return { ...entry, cacheHit: false };
}

export function buildParseCacheKey(input: {
  root: string;
  filePath: string;
  language: SourceLanguage;
  parserVersion: string;
  grammarVersion: string;
  sourceHash: string;
}): string {
  return [
    input.root,
    input.filePath,
    input.language,
    input.parserVersion,
    input.grammarVersion,
    input.sourceHash,
  ].join("\0");
}

export function getCachedSourceDocument(key: string): SourceDocument | undefined {
  return FILE_PARSE_CACHE.get(key);
}

export function setCachedSourceDocument(key: string, document: SourceDocument): void {
  FILE_PARSE_CACHE.set(key, document);
}

export function getCachedSourceGraph(key: string): SourceGraph | undefined {
  return DERIVED_GRAPH_CACHE.get(key);
}

export function setCachedSourceGraph(key: string, graph: SourceGraph): void {
  DERIVED_GRAPH_CACHE.set(key, graph);
}

export function clearSourceIntelligenceCaches(): void {
  SOURCE_TEXT_CACHE.clear();
  FILE_PARSE_CACHE.clear();
  DERIVED_GRAPH_CACHE.clear();
}
