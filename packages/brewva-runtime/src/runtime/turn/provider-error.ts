/**
 * Provider errors crossing the {@link RuntimeProviderPort} may carry a
 * `retryable` flag set by the host adapter from the provider's HTTP/transport
 * classification. A permanent failure — missing/expired credentials, a model
 * the account is not entitled to, an otherwise invalid request — is flagged
 * `retryable: false` so the runtime fails fast instead of re-issuing a request
 * that can only fail the same way again.
 *
 * The flag may sit on the thrown error itself or anywhere in its `cause` chain
 * (the host wraps provider errors as it crosses package boundaries). This is a
 * fail-fast SAFETY gate, so it fails safe: ANY explicit `retryable: false` in the
 * chain marks the failure permanent. Absent any such flag the error is treated as
 * retryable, preserving the historical retry-once behavior for unclassified
 * transient stream failures.
 *
 * This is the runtime's RETRY gate. Two sibling classifiers serve different jobs:
 * provider-core derives the `retryable` flag from an HTTP status
 * (`contracts/error-status.ts` via `stream/effect-interop.ts`), and the CLI's
 * `isProviderAccessFailure` decides the user-facing badge/notice.
 */
// Bounds the `cause` walk against a cyclic chain. Deeper than provider-core's
// `readErrorStatus` (4) because this traverses the HOST's multi-layer error wrapping
// (codex wrapper -> ProviderStreamError -> ProviderAttemptError -> ...), not a shallow
// SDK `cause` chain.
import { computeBackoffMs } from "@brewva/brewva-std/backoff";

const MAX_CAUSE_DEPTH = 8;

export function isRetryableProviderError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (typeof current !== "object" || current === null) {
      break;
    }
    const record = current as { retryable?: unknown; cause?: unknown };
    if (record.retryable === false) {
      return false;
    }
    current = record.cause;
  }
  return true;
}

/**
 * A diagnostic string spanning the error's `cause` chain. Provider transport
 * failures surface to the user as a generic top-level message (e.g. the SDK's
 * "Connection error."), while the actionable detail — the underlying socket/TLS
 * errno, an abort, a serialization fault — sits in `cause`. Recording the whole
 * chain (each `Name: message (code)` joined by ` <- `) on the failed/suspended
 * event turns an opaque "Connection error." into something diagnosable. Same
 * bounded, cycle-safe walk as {@link isRetryableProviderError}.
 */
export function describeProviderError(error: unknown, fallback = "runtime_turn_failed"): string {
  if (typeof error === "string" && error.length > 0) {
    return error;
  }
  const segments: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (typeof current !== "object" || current === null) {
      break;
    }
    const record = current as {
      name?: unknown;
      message?: unknown;
      code?: unknown;
      cause?: unknown;
    };
    const name = typeof record.name === "string" && record.name !== "Error" ? record.name : "";
    const message = typeof record.message === "string" ? record.message : "";
    const code =
      typeof record.code === "string" || typeof record.code === "number"
        ? ` (${String(record.code)})`
        : "";
    const head = [name, message].filter((part) => part.length > 0).join(": ");
    const segment = `${head}${code}`.trim();
    if (segment.length > 0 && !segments.includes(segment)) {
      segments.push(segment);
    }
    if (record.cause === undefined || record.cause === current) {
      break;
    }
    current = record.cause;
  }
  return segments.length > 0 ? segments.join(" <- ") : fallback;
}

/**
 * The runtime re-issues a retryable provider failure (see
 * {@link isRetryableProviderError}) up to this many times before giving up.
 * Sized to ride out a transient egress-gateway outage: a zero-trust proxy (e.g.
 * ByteDance Feilian) intermittently REFUSES new connections to LLM endpoints for
 * seconds to tens of seconds, identically across HTTP/1.1 and HTTP/2 — protocol
 * is not the lever, persistence is. With {@link providerRetryDelayMs} the two
 * attempts span ~1.5s of wall-clock backoff. Kept SHORT deliberately: dogfooding
 * showed the gateway's bad windows routinely run tens of seconds (up to ~90s),
 * far past any sane retry budget — so retry only rides out brief blips, while a
 * genuinely-down window fails FAST with a clear notice instead of a long hang.
 */
export const PROVIDER_RETRY_MAX_ATTEMPTS = 2;

const PROVIDER_RETRY_BASE_DELAY_MS = 500;
const PROVIDER_RETRY_MAX_DELAY_MS = 2_000;

/**
 * Exponential backoff for the Nth provider retry (1-based): 500ms, 1s, then 2s
 * (capped). No jitter — a single-user CLI has no thundering herd to spread — so
 * the schedule stays deterministic for tape replay and tests.
 */
export function providerRetryDelayMs(attempt: number): number {
  // 1-based attempts: pass attempt - 1 so the first retry lands on baseMs (the
  // kernel clamps the exponent to >= 0).
  return computeBackoffMs(attempt - 1, {
    baseMs: PROVIDER_RETRY_BASE_DELAY_MS,
    factor: 2,
    maxMs: PROVIDER_RETRY_MAX_DELAY_MS,
  });
}
