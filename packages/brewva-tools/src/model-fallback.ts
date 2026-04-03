import type { ModelRegistry } from "@mariozechner/pi-coding-agent";

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

export function selectBrewvaFallbackModel(input: {
  currentModel: RegisteredModel;
  availableModels: readonly RegisteredModel[];
}): RegisteredModel | undefined {
  const currentTokens = tokenizeModelId(input.currentModel.id);
  const currentStem = findAffinityStem(currentTokens);
  const currentHasReliableFallbackToken = hasAnyToken(currentTokens, RELIABLE_FALLBACK_TOKENS);

  const ranked = input.availableModels
    .filter(
      (candidate) =>
        candidate.provider === input.currentModel.provider &&
        candidate.id !== input.currentModel.id,
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
