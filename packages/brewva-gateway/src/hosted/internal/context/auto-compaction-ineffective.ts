import { readAutoCompactionIneffective } from "@brewva/brewva-substrate/context-budget";

interface CompactionReceiptEventLike {
  readonly turn?: number;
  readonly timestamp?: number;
  readonly payload?: unknown;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readPayloadNumber(payload: unknown, key: string): number | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  return finiteNumber((payload as Record<string, unknown>)[key]);
}

/**
 * Derive the auto-compaction thrash signal from committed
 * `session.compaction.committed` receipt events: map each to its
 * (`fromTokens`, `toTokens`) pair, order newest-first, and apply the pure
 * substrate guard {@link readAutoCompactionIneffective}. Shared by both
 * auto-compaction eligibility surfaces — the live controller path and the
 * `resolveEligibility` port op — so the receipt-to-verdict derivation lives in
 * exactly one place (each caller only supplies its own event query).
 */
export function deriveAutoCompactionIneffectiveFromReceipts(
  events: readonly CompactionReceiptEventLike[],
  minShrinkRatio: number,
  minAttempts: number,
): boolean {
  const receipts = events
    .map((event) => ({
      turn:
        finiteNumber(event.turn) ??
        readPayloadNumber(event.payload, "sourceTurn") ??
        readPayloadNumber(event.payload, "turn") ??
        finiteNumber(event.timestamp) ??
        0,
      timestamp: finiteNumber(event.timestamp) ?? 0,
      fromTokens: readPayloadNumber(event.payload, "fromTokens"),
      toTokens: readPayloadNumber(event.payload, "toTokens"),
    }))
    .toSorted((left, right) => right.turn - left.turn || right.timestamp - left.timestamp);
  return readAutoCompactionIneffective(receipts, minShrinkRatio, minAttempts);
}
