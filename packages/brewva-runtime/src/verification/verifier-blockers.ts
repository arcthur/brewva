import type { VerificationCheckRun } from "../contracts/index.js";

export const VERIFIER_BLOCKER_PREFIX = "verifier:" as const;
export const GOVERNANCE_BLOCKER_ID = "verifier:governance:verify-spec";
export const GOVERNANCE_TRUTH_FACT_ID = "truth:governance:verify-spec";
export const VERIFICATION_CHECK_FAILED_TRUTH_KIND = "verification_check_failed" as const;
export const VERIFICATION_CHECK_MISSING_TRUTH_KIND = "verification_check_missing" as const;

export function normalizeVerifierCheckForId(name: string): string {
  const normalized = name.trim().toLowerCase();
  if (!normalized) return "unknown";
  return normalized.replace(/[^a-z0-9._-]+/g, "-");
}

export function buildVerifierBlockerMessage(input: {
  checkName: string;
  truthFactId: string;
  issueKind: "fail" | "missing";
  run?: VerificationCheckRun;
}): string {
  const parts: string[] = [
    input.issueKind === "fail"
      ? `verification failed: ${input.checkName}`
      : `verification missing fresh evidence: ${input.checkName}`,
    `truth=${input.truthFactId}`,
  ];
  if (input.run?.ledgerId) {
    parts.push(`evidence=${input.run.ledgerId}`);
  }
  if (
    input.issueKind === "fail" &&
    input.run &&
    input.run.exitCode !== null &&
    input.run.exitCode !== undefined
  ) {
    parts.push(`exitCode=${input.run.exitCode}`);
  }
  return parts.join(" ");
}
