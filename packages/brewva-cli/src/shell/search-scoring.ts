export function normalizeSearchQuery(query: string): string {
  return query.trim().replace(/^\//u, "").toLowerCase();
}

export function fuzzyScore(query: string, target: string): number | null {
  const normalizedQuery = normalizeSearchQuery(query);
  const normalizedTarget = target.toLowerCase();
  if (normalizedQuery.length === 0) {
    return 0;
  }
  if (normalizedTarget.startsWith(normalizedQuery)) {
    return 1000 - normalizedTarget.length;
  }

  let queryIndex = 0;
  let score = 0;
  let lastMatchIndex = -2;
  for (
    let targetIndex = 0;
    targetIndex < normalizedTarget.length && queryIndex < normalizedQuery.length;
    targetIndex++
  ) {
    if (normalizedTarget[targetIndex] === normalizedQuery[queryIndex]) {
      score += lastMatchIndex === targetIndex - 1 ? 10 : 1;
      lastMatchIndex = targetIndex;
      queryIndex++;
    }
  }
  return queryIndex < normalizedQuery.length ? null : score;
}
