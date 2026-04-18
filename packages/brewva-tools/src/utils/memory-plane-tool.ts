import { shouldInvokeSemanticRerank } from "../semantic-reranker.js";

export interface MemoryToolSemanticRerankCandidate {
  id: string;
  title: string;
  summary: string;
  content: string;
  kind: string;
  scope: string;
}

export function readMemoryToolString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

export function resolveMemoryToolLimit(
  value: number | undefined,
  options: {
    defaultLimit?: number;
    minLimit?: number;
    maxLimit?: number;
  } = {},
): number {
  const defaultLimit = options.defaultLimit ?? 10;
  const minLimit = options.minLimit ?? 1;
  const maxLimit = options.maxLimit ?? 20;
  return Math.max(minLimit, Math.min(maxLimit, value ?? defaultLimit));
}

export async function rerankMemoryToolRetrievals<
  TEntry,
  TRerankResult extends { orderedIds: readonly string[] } | null | undefined,
>(input: {
  retrievals: readonly TEntry[];
  getId: (entry: TEntry) => string;
  getScore: (entry: TEntry) => number;
  toCandidate: (entry: TEntry) => MemoryToolSemanticRerankCandidate;
  rerank?: (candidates: readonly MemoryToolSemanticRerankCandidate[]) => Promise<TRerankResult>;
}): Promise<TEntry[]> {
  const { retrievals } = input;
  if (
    retrievals.length < 3 ||
    !input.rerank ||
    !shouldInvokeSemanticRerank(retrievals.map((entry) => input.getScore(entry)))
  ) {
    return [...retrievals];
  }

  const candidates = retrievals.map((entry) => input.toCandidate(entry));
  const reranked = await input.rerank(candidates);
  if (!reranked) {
    return [...retrievals];
  }

  const byId = new Map(retrievals.map((entry) => [input.getId(entry), entry] as const));
  return reranked.orderedIds
    .map((id) => byId.get(id))
    .filter((entry): entry is TEntry => Boolean(entry));
}
