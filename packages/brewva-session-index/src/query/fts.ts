// Shared helpers for FTS5 bm25-ranked queries (session_fts / event_fts).
//
// SQLite FTS5 bm25() is unbounded and NEGATIVE for matches — the more negative,
// the better the match — and is only defined inside a MATCH query. The public
// SessionIndex contract exposes a bounded `tokenScore` in (0, 1], higher = better,
// so we map bm25 through the logistic 1/(1+exp(bm25)). A row with no match (e.g.
// the currentSessionId fallback joined via LEFT JOIN) has a null/undefined score
// and maps to 0, preserving the old "no token match -> score 0" semantics.
//
// Ranking-semantics caveats (this is the reasonable default, NOT yet tuned):
//   - bm25() runs with FTS5's default parameters, including b=0.75 length
//     normalization. A session_fts row aggregates ALL of a session's tokens into
//     one `body`, so a long-running session is a long document and is penalized
//     relative to a short one — a real shift from the old hand-rolled coverage
//     score, which had no length penalty.
//   - The logistic map is order-preserving WITHIN a single query, but its
//     absolute value is not comparable across corpora/queries: bm25's IDF term is
//     corpus-dependent, so the same raw match can map to different tokenScores in
//     different indexes. Treat tokenScore as a within-query rank signal, not an
//     absolute relevance.
// Tuning the bm25 `b` parameter and re-checking the recall broker's blend weights
// against these scores belong to the deferred recall-quality evaluation harness,
// not this engine migration.

export interface Bm25ScoredRow {
  bm25_score: number | null;
}

export function logisticBm25Score(bm25: number | null | undefined): number {
  if (bm25 === null || bm25 === undefined || !Number.isFinite(bm25)) {
    return 0;
  }
  return 1 / (1 + Math.exp(bm25));
}
