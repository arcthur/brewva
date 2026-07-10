import type { BrewvaModelCatalog as ModelRegistry } from "@brewva/brewva-substrate/provider";

type RegisteredModel = ReturnType<ModelRegistry["getAll"]>[number];

const RELIABLE_FALLBACK_TOKENS = new Set(["mini", "flash", "haiku", "lite", "small", "nano"]);
const HEAVY_MODEL_TOKENS = new Set(["opus", "pro", "max", "ultra", "large"]);
const NEUTRAL_TOKENS = new Set(["preview", "latest", "exp", "experimental", "reasoning"]);

function tokenizeModelId(id: string): string[] {
  return id
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .map((token) => token.trim())
    .filter((token) => token.length > 0 && !NEUTRAL_TOKENS.has(token));
}

function countIntersection(left: readonly string[], right: readonly string[]): number {
  const rightSet = new Set(right);
  let count = 0;
  for (const token of left) {
    if (rightSet.has(token)) {
      count += 1;
    }
  }
  return count;
}

function findAffinityStem(tokens: readonly string[]): string | null {
  for (const token of tokens) {
    if (!RELIABLE_FALLBACK_TOKENS.has(token) && !HEAVY_MODEL_TOKENS.has(token)) {
      return token;
    }
  }
  return tokens[0] ?? null;
}

function hasAnyToken(tokens: readonly string[], candidates: ReadonlySet<string>): boolean {
  return tokens.some((token) => candidates.has(token));
}

function compareCandidates(
  left: { score: number; model: RegisteredModel },
  right: { score: number; model: RegisteredModel },
): number {
  if (left.score !== right.score) {
    return right.score - left.score;
  }
  const leftKey = `${left.model.provider}/${left.model.id}`;
  const rightKey = `${right.model.provider}/${right.model.id}`;
  return leftKey.localeCompare(rightKey);
}

/**
 * Pick a same-provider sibling with a strictly LARGER context window, for
 * promotion on a context-overflow failure before falling back to a generic
 * (possibly-smaller) model or compacting. Chooses the SMALLEST strictly-larger
 * window (least cost/latency escalation), tie-broken by token affinity to the
 * current model, then by key for determinism. Returns undefined when no larger
 * sibling exists — the caller then proceeds to generic fallback / compaction.
 */
export function selectLargerContextModel(input: {
  currentModel: RegisteredModel;
  availableModels: readonly RegisteredModel[];
  excludeModelKeys?: ReadonlySet<string>;
}): RegisteredModel | undefined {
  const currentWindow = input.currentModel.contextWindow;
  if (typeof currentWindow !== "number" || currentWindow <= 0) {
    return undefined;
  }
  const currentTokens = tokenizeModelId(input.currentModel.id);
  const larger = input.availableModels.filter(
    (candidate) =>
      candidate.provider === input.currentModel.provider &&
      candidate.id !== input.currentModel.id &&
      input.excludeModelKeys?.has(`${candidate.provider}/${candidate.id}`) !== true &&
      typeof candidate.contextWindow === "number" &&
      candidate.contextWindow > currentWindow,
  );
  if (larger.length === 0) {
    return undefined;
  }
  return larger.toSorted((left, right) => {
    const leftWindow = left.contextWindow;
    const rightWindow = right.contextWindow;
    if (leftWindow !== rightWindow) {
      return leftWindow - rightWindow;
    }
    const leftAffinity = countIntersection(currentTokens, tokenizeModelId(left.id));
    const rightAffinity = countIntersection(currentTokens, tokenizeModelId(right.id));
    if (leftAffinity !== rightAffinity) {
      return rightAffinity - leftAffinity;
    }
    return `${left.provider}/${left.id}`.localeCompare(`${right.provider}/${right.id}`);
  })[0];
}

export function selectBrewvaFallbackModel(input: {
  currentModel: RegisteredModel;
  availableModels: readonly RegisteredModel[];
  // `provider/id` keys the caller has already attempted or knows to be
  // unavailable. Excluding them HERE (not after ranking) matters: taking the
  // top-ranked candidate and then dropping it post-hoc reads as exhaustion even
  // while viable lower-ranked candidates remain.
  excludeModelKeys?: ReadonlySet<string>;
}): RegisteredModel | undefined {
  const currentTokens = tokenizeModelId(input.currentModel.id);
  const currentStem = findAffinityStem(currentTokens);
  const currentHasReliableFallbackToken = hasAnyToken(currentTokens, RELIABLE_FALLBACK_TOKENS);

  const ranked = input.availableModels
    .filter(
      (candidate) =>
        candidate.provider === input.currentModel.provider &&
        candidate.id !== input.currentModel.id &&
        input.excludeModelKeys?.has(`${candidate.provider}/${candidate.id}`) !== true,
    )
    .map((candidate) => {
      const candidateTokens = tokenizeModelId(candidate.id);
      const candidateStem = findAffinityStem(candidateTokens);
      const candidateHasReliableFallbackToken = hasAnyToken(
        candidateTokens,
        RELIABLE_FALLBACK_TOKENS,
      );
      const candidateHasHeavyToken = hasAnyToken(candidateTokens, HEAVY_MODEL_TOKENS);
      const sharedTokens = countIntersection(currentTokens, candidateTokens);
      const contextRatio =
        typeof input.currentModel.contextWindow === "number" &&
        input.currentModel.contextWindow > 0 &&
        typeof candidate.contextWindow === "number" &&
        candidate.contextWindow > 0
          ? candidate.contextWindow / input.currentModel.contextWindow
          : null;

      let score = 0;
      score += sharedTokens * 8;
      if (currentStem && candidateStem && currentStem === candidateStem) {
        score += 18;
      }
      if (candidateHasReliableFallbackToken && !currentHasReliableFallbackToken) {
        score += 24;
      } else if (candidateHasReliableFallbackToken) {
        score += 8;
      }
      if (candidateHasHeavyToken && !currentHasReliableFallbackToken) {
        score -= 18;
      }
      if (contextRatio !== null) {
        if (contextRatio >= 1) {
          score += 6;
        } else if (contextRatio >= 0.5) {
          score += 2;
        } else if (contextRatio < 0.25) {
          score -= 10;
        }
      }
      if (typeof candidate.maxTokens === "number" && candidate.maxTokens > 0) {
        if (
          typeof input.currentModel.maxTokens === "number" &&
          input.currentModel.maxTokens > 0 &&
          candidate.maxTokens >= Math.floor(input.currentModel.maxTokens * 0.75)
        ) {
          score += 4;
        } else if (candidate.maxTokens < 1024) {
          score -= 6;
        }
      }

      return {
        score,
        model: candidate,
      };
    })
    .toSorted(compareCandidates);

  return ranked[0]?.model;
}
