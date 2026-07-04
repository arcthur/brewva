import type { BrewvaToolRuntime } from "../contracts/index.js";

export interface RecordVerificationOutcomeInput {
  readonly outcome: "pass" | "fail" | "skipped";
  readonly level: string;
  readonly checks: readonly string[];
  readonly failedChecks: readonly string[];
  readonly missingChecks: readonly string[];
  readonly missingEvidence: readonly string[];
  readonly evidenceFreshness: string;
  readonly reason: string | null;
}

/**
 * Commits the caller-computed verification outcome as the canonical
 * `verification.outcome.recorded` receipt. Returns undefined when the runtime
 * does not expose the verification capability (fail-closed per managed-tool
 * doctrine: recording is unavailable rather than silently dropped).
 */
export function recordVerificationOutcome(
  runtime: BrewvaToolRuntime,
  sessionId: string,
  input: RecordVerificationOutcomeInput,
): ReturnType<BrewvaToolRuntime["capabilities"]["verification"]["checks"]["verify"]> | undefined {
  return runtime.capabilities.verification?.checks?.verify(sessionId, input);
}
