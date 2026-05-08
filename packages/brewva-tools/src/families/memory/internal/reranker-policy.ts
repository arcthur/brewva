export function shouldInvokeSemanticRerank(
  scores: readonly number[],
  options: {
    minimumTopK?: number;
    marginThreshold?: number;
  } = {},
): boolean {
  const minimumTopK = Math.max(2, options.minimumTopK ?? 3);
  if (scores.length < minimumTopK) {
    return false;
  }
  const sorted = [...scores].toSorted((left, right) => right - left);
  const first = sorted[0] ?? 0;
  const second = sorted[1] ?? 0;
  return first - second <= Math.max(0, options.marginThreshold ?? 0.08);
}
