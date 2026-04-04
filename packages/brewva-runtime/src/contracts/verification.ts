import type { VerificationLevel } from "./shared.js";

export type VerificationCheckStatus = "pass" | "fail" | "missing" | "skip";

export interface VerificationReport {
  passed: boolean;
  readOnly: boolean;
  skipped: boolean;
  reason?: "read_only";
  level: VerificationLevel;
  failedChecks: string[];
  missingChecks: string[];
  missingEvidence: string[];
  checks: Array<{
    name: string;
    status: VerificationCheckStatus;
    evidence?: string;
  }>;
}

export interface VerificationCheckRun {
  timestamp: number;
  ok: boolean;
  command: string;
  exitCode: number | null;
  durationMs: number;
  ledgerId?: string;
  outputSummary?: string;
}

export interface VerificationSessionState {
  lastWriteAt?: number;
  checkRuns: Record<string, VerificationCheckRun>;
  denialCount: number;
  lastOutcomeAt?: number;
  lastOutcomeLevel?: VerificationLevel;
  lastOutcomePassed?: boolean;
  lastOutcomeReferenceWriteAt?: number;
}
