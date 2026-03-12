import type { VerificationCheckRun } from "../types.js";

export const VERIFIER_BLOCKER_PREFIX = "verifier:" as const;
export const GOVERNANCE_BLOCKER_ID = "verifier:governance:verify-spec";
export const GOVERNANCE_TRUTH_FACT_ID = "truth:governance:verify-spec";

export function normalizeVerifierCheckForId(name: string): string {
  const normalized = name.trim().toLowerCase();
  if (!normalized) return "unknown";
  return normalized.replace(/[^a-z0-9._-]+/g, "-");
}

export function buildVerifierBlockerMessage(input: {
  checkName: string;
  truthFactId: string;
  run?: VerificationCheckRun;
}): string {
  const parts: string[] = [`verification failed: ${input.checkName}`, `truth=${input.truthFactId}`];
  if (input.run?.ledgerId) {
    parts.push(`evidence=${input.run.ledgerId}`);
  }
  if (input.run && input.run.exitCode !== null && input.run.exitCode !== undefined) {
    parts.push(`exitCode=${input.run.exitCode}`);
  }
  return parts.join(" ");
}
