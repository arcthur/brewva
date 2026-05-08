export interface BrewvaContextCompactionUsage {
  tokens: number | null;
  contextWindow: number;
  percent?: number | null;
}

export interface BrewvaContextCompactionThresholdOptions {
  thresholdRatio?: number;
  minTokens?: number;
}

const DEFAULT_COMPACTION_THRESHOLD_RATIO = 0.8;

export function shouldCompactBrewvaContext(
  usage: BrewvaContextCompactionUsage | undefined,
  options: BrewvaContextCompactionThresholdOptions = {},
): boolean {
  if (!usage || usage.tokens === null || usage.contextWindow <= 0) {
    return false;
  }

  const thresholdRatio = options.thresholdRatio ?? DEFAULT_COMPACTION_THRESHOLD_RATIO;
  if (options.minTokens !== undefined && usage.tokens < options.minTokens) {
    return false;
  }

  return usage.tokens / usage.contextWindow >= thresholdRatio;
}
