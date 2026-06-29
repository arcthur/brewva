/**
 * Turns a failed-turn error into a user-facing notice. A permanent provider
 * access failure — a model the account is not entitled to, a missing/expired
 * credential, an unauthorized request — is enriched with the concrete in-app
 * recovery step (`/model`) so the user is never left with a raw provider string
 * and no idea what to do. Transient failures are passed through unchanged.
 */
export function describeProviderFailure(error: unknown): string {
  const message = providerFailureMessage(error);
  if (!isProviderAccessFailure(error)) {
    return message;
  }
  return [
    message,
    "",
    "This model isn't usable with your current credentials. Run /model to switch to a model your account can use, or connect credentials for this provider.",
  ].join("\n");
}

/**
 * True when a failure looks like a permanent credential/entitlement problem
 * rather than a transient hiccup. Drives both the actionable notice above and
 * the model picker's "unavailable" badge. Keys off the structured `retryable`
 * flag the runtime now carries, falling back to message inspection. This is the
 * PRESENTATION classifier; the runtime's `isRetryableProviderError` is the retry
 * gate and provider-core's `readErrorStatus` derives the flag from HTTP status.
 */
export function isProviderAccessFailure(error: unknown): boolean {
  if (typeof error === "object" && error !== null) {
    const flag = (error as { retryable?: unknown }).retryable;
    if (typeof flag === "boolean") {
      // The structured flag is authoritative when present: a permanent failure
      // (retryable === false) is an access failure; an explicitly transient one
      // (retryable === true) is not, regardless of what its message text says.
      // Without this, a retryable error whose message happens to contain a token
      // like "api key" would fall through to the regex and be mis-badged.
      return !flag;
    }
  }
  return ACCESS_FAILURE_PATTERN.test(providerFailureMessage(error));
}

function providerFailureMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "Failed to run prompt.";
}

// Fallback for when the structured `retryable` flag is absent (e.g. an in-band
// mid-stream error that lost its HTTP status). Kept to provider-credential/entitlement
// phrasing; generic "permission denied"/"access denied" are deliberately excluded
// because they collide with filesystem/tool failures that are not provider errors.
const ACCESS_FAILURE_PATTERN =
  /not supported|not entitled|unauthorized|forbidden|invalid api key|no api key|api key|credential|unauthenticated|entitlement|\b401\b|\b403\b/i;
