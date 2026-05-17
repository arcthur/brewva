import { tokenizeSearchContent, tokenizeSearchQuery } from "../tokenization/tokenizer.js";

export interface TfIdfSearchDocument<TMetadata = unknown> {
  id: string;
  text: string;
  metadata?: TMetadata;
}

export interface TfIdfSearchResult<TMetadata = unknown> {
  document: TfIdfSearchDocument<TMetadata>;
  score: number;
  matchedTokens: string[];
}

export interface TfIdfSearchOptions {
  limit?: number;
  minScore?: number;
}

interface IndexedDocument<TMetadata> {
  document: TfIdfSearchDocument<TMetadata>;
  termFrequency: Map<string, number>;
  maxTermFrequency: number;
}

function indexDocument<TMetadata>(
  document: TfIdfSearchDocument<TMetadata>,
): IndexedDocument<TMetadata> {
  const termFrequency = new Map<string, number>();
  for (const token of tokenizeSearchContent(document.text, { minLength: 2 })) {
    termFrequency.set(token, (termFrequency.get(token) ?? 0) + 1);
  }
  return {
    document,
    termFrequency,
    maxTermFrequency: Math.max(1, ...termFrequency.values()),
  };
}

function buildDocumentFrequency<TMetadata>(
  indexed: readonly IndexedDocument<TMetadata>[],
): Map<string, number> {
  const out = new Map<string, number>();
  for (const document of indexed) {
    for (const token of document.termFrequency.keys()) {
      out.set(token, (out.get(token) ?? 0) + 1);
    }
  }
  return out;
}

function roundScore(value: number): number {
  return Number(value.toFixed(6));
}

export function scoreDocumentsByTfIdf<TMetadata = unknown>(
  query: string,
  documents: readonly TfIdfSearchDocument<TMetadata>[],
  options: TfIdfSearchOptions = {},
): TfIdfSearchResult<TMetadata>[] {
  const queryTokens = tokenizeSearchQuery(query, { minLength: 2 });
  if (queryTokens.length === 0 || documents.length === 0) {
    return [];
  }

  const indexed = documents.map(indexDocument);
  const documentFrequency = buildDocumentFrequency(indexed);
  const totalDocuments = indexed.length;
  const minScore = options.minScore ?? 0;
  const results: TfIdfSearchResult<TMetadata>[] = [];

  for (const entry of indexed) {
    let score = 0;
    const matchedTokens: string[] = [];
    for (const token of queryTokens) {
      const rawFrequency = entry.termFrequency.get(token) ?? 0;
      if (rawFrequency === 0) {
        continue;
      }
      const termFrequency = rawFrequency / entry.maxTermFrequency;
      const inverseDocumentFrequency =
        Math.log((1 + totalDocuments) / (1 + (documentFrequency.get(token) ?? 0))) + 1;
      score += termFrequency * inverseDocumentFrequency;
      matchedTokens.push(token);
    }
    if (score <= minScore) {
      continue;
    }
    results.push({
      document: entry.document,
      score: roundScore(score),
      matchedTokens,
    });
  }

  const sorted = results.toSorted(
    (left, right) => right.score - left.score || left.document.id.localeCompare(right.document.id),
  );
  return typeof options.limit === "number" ? sorted.slice(0, options.limit) : sorted;
}
