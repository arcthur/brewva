/**
 * Read a numeric HTTP status (100-599) from a provider error or anywhere in its
 * `cause` chain. SDK errors (deepseek/openai/anthropic/google) expose `status` or
 * `statusCode`, on the error itself or on a wrapped cause.
 *
 * Single source of truth for HTTP-status extraction across the provider seam:
 * consumed inside provider-core by `toProviderStreamError` (to derive the
 * `retryable` flag from an unambiguous permanent status) and re-exported by the
 * gateway as `readProviderErrorStatus` for `classifyProviderFailure`. The two
 * callers layer DIFFERENT status semantics on top of this shared reader (a
 * fail-fast retry gate vs. a `ProviderFailureReason` taxonomy), so only the
 * extraction itself lives here.
 *
 * The depth bound only guards against a cyclic `cause` chain; a real SDK error
 * nests its status shallowly, so 4 is ample (the runtime's separate
 * `isRetryableProviderError` walks deeper because it traverses the host's
 * multi-layer error wrapping, not an SDK cause chain).
 */
const MAX_STATUS_CAUSE_DEPTH = 4;

export function readErrorStatus(error: unknown, depth = 0): number | undefined {
  if (depth > MAX_STATUS_CAUSE_DEPTH || error === null || typeof error !== "object") {
    return undefined;
  }
  const record = error as { status?: unknown; statusCode?: unknown; cause?: unknown };
  for (const candidate of [record.status, record.statusCode]) {
    if (
      typeof candidate === "number" &&
      Number.isInteger(candidate) &&
      candidate >= 100 &&
      candidate <= 599
    ) {
      return candidate;
    }
  }
  return readErrorStatus(record.cause, depth + 1);
}
