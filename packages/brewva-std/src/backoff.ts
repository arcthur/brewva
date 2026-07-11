export interface BackoffOptions {
  /** Delay in ms for attempt 0, before the exponential factor is applied. */
  readonly baseMs: number;
  /** Per-attempt growth factor (2 = doubling each attempt). */
  readonly factor: number;
  /** Upper bound in ms. Omit for an uncapped schedule. */
  readonly maxMs?: number;
}

/**
 * Exponential backoff delay for a 0-based `attempt`: `baseMs * factor ** attempt`,
 * capped at `maxMs` when provided. The exponent is clamped to `>= 0`, so a
 * negative `attempt` — e.g. a 1-based caller passing `attempt - 1` on its first
 * try — collapses to `baseMs` rather than dipping below it (every hand-written
 * site this centralizes applied the same `Math.max(0, …)` clamp).
 *
 * Pure and jitter-free by design: it is only the scalar delay math. Retry-After
 * overrides, jitter policy, the attempt-index base, and the retry loop itself all
 * legitimately diverge across call sites and stay with the caller.
 */
export function computeBackoffMs(attempt: number, options: BackoffOptions): number {
  const exponent = Math.max(0, attempt);
  const raw = options.baseMs * options.factor ** exponent;
  return options.maxMs === undefined ? raw : Math.min(options.maxMs, raw);
}

/**
 * Parse an HTTP `Retry-After` value into a delay in ms. Handles the two RFC 9110
 * forms: delta-seconds (`"120"` → `120_000`) and an HTTP-date
 * (`"Wed, 21 Oct 2025 07:28:00 GMT"` → the ms from `nowMs` until then). Returns
 * `undefined` for a missing, blank, or unparseable value, and never a negative
 * delay. `nowMs` defaults to `Date.now()` and is injectable for deterministic
 * tests. Callers own extracting the raw value (a `Headers.get`, a JSON
 * `retry_after` field) and pass the string in.
 */
export function parseRetryAfterMs(
  value: string | null | undefined,
  nowMs: number = Date.now(),
): number | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds)) {
    return Math.max(0, Math.floor(seconds * 1000));
  }
  const dateMs = Date.parse(trimmed);
  if (Number.isFinite(dateMs)) {
    return Math.max(0, dateMs - nowMs);
  }
  return undefined;
}

/**
 * Map a seed string to a stable fraction in `[0, 1)` via FNV-1a. Deterministic
 * and dependency-free — identical across processes and replays, and never
 * `Math.random` — so the delay it feeds survives tape replay. The shared jitter
 * primitive for retry backoff and schedule-recurrence spreading; the caller
 * decides how to apply the fraction (full jitter, a capped ratio, and so on).
 */
export function deterministicJitterFraction(seed: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash / 0x1_0000_0000;
}
