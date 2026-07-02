/**
 * Turns a failed-turn error into a user-facing notice. A permanent provider
 * access failure — a model the account is not entitled to, a missing/expired
 * credential, an unauthorized request — is enriched with the concrete in-app
 * recovery step (`/model`). A transient connection failure that survived the
 * runtime's retry budget gets a wait-and-retry notice so an intermittent
 * gateway outage doesn't read as an opaque "Connection error.". Other transient
 * failures pass through unchanged.
 */
export function describeProviderFailure(error: unknown): string {
  const message = providerFailureMessage(error);
  if (isProviderAccessFailure(error)) {
    return [
      message,
      "",
      "This model isn't usable with your current credentials. Run /model to switch to a model your account can use, or connect credentials for this provider.",
    ].join("\n");
  }
  if (isTransientConnectionFailure(error)) {
    return [
      message,
      "",
      "The connection to the provider kept getting refused or reset, even after automatic retries. This is almost always a transient network or egress-gateway hiccup — not your credentials or config. Wait a few seconds and send it again.",
    ].join("\n");
  }
  return message;
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

/** One provider-route attempt carried by a fallback-exhausted turn failure. */
export interface ProviderFailureAttempt {
  readonly provider: string;
  readonly model: string;
  readonly message: string;
  readonly retryable?: boolean;
}

/**
 * The per-route attempt trail a fallback-exhausted failure carries (the
 * runtime's `ProviderFallbackExhaustedError.attempts`). Duck-typed on purpose:
 * the CLI must not import gateway internals, and a failure that crossed a
 * string-reducing boundary simply yields an empty trail — the message text
 * already carries the same facts for the human.
 */
export function readProviderFailureAttempts(error: unknown): readonly ProviderFailureAttempt[] {
  if (typeof error !== "object" || error === null) {
    return [];
  }
  const attempts = (error as { attempts?: unknown }).attempts;
  if (!Array.isArray(attempts)) {
    return [];
  }
  const trail: ProviderFailureAttempt[] = [];
  for (const entry of attempts) {
    if (typeof entry !== "object" || entry === null) {
      return [];
    }
    const { provider, model, message, retryable } = entry as {
      provider?: unknown;
      model?: unknown;
      message?: unknown;
      retryable?: unknown;
    };
    if (typeof provider !== "string" || typeof model !== "string" || typeof message !== "string") {
      return [];
    }
    trail.push({
      provider,
      model,
      message,
      ...(typeof retryable === "boolean" ? { retryable } : {}),
    });
  }
  return trail;
}

/**
 * Same classification as {@link isProviderAccessFailure}, applied to one attempt
 * of the trail: the structured flag is authoritative when present, else the
 * attempt's own message decides. Drives per-model availability marking, so every
 * model the fallback chain burned through gets its badge — not just the one the
 * user selected.
 */
export function isProviderAccessFailureAttempt(attempt: ProviderFailureAttempt): boolean {
  if (typeof attempt.retryable === "boolean") {
    return !attempt.retryable;
  }
  return ACCESS_FAILURE_PATTERN.test(attempt.message);
}

// Fallback for when the structured `retryable` flag is absent (e.g. an in-band
// mid-stream error that lost its HTTP status). Kept to provider-credential/entitlement
// phrasing; generic "permission denied"/"access denied" are deliberately excluded
// because they collide with filesystem/tool failures that are not provider errors.
const ACCESS_FAILURE_PATTERN =
  /not supported|not entitled|unauthorized|forbidden|invalid api key|no api key|api key|credential|unauthenticated|entitlement|\b401\b|\b403\b/i;

/**
 * True when a failure is a connection-level transport error (refused/reset/
 * dropped) rather than a permanent access problem — the kind the runtime already
 * exhausted its retry budget on. Deliberately narrow: keyed to connection/socket
 * phrasing so ordinary tool/filesystem errors don't get a misleading network
 * notice. A permanent access failure takes precedence (checked first).
 */
export function isTransientConnectionFailure(error: unknown): boolean {
  if (isProviderAccessFailure(error)) {
    return false;
  }
  return CONNECTION_FAILURE_PATTERN.test(providerFailureMessage(error));
}

const CONNECTION_FAILURE_PATTERN =
  /connection error|connection refused|connection reset|econnrefused|econnreset|socket hang up|fetch failed|network error/i;
