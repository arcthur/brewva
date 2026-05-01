import type { VerificationLevel } from "../../core/shared.js";

export type VerificationCheckStatus = "pass" | "fail" | "missing" | "skip";
export type VerificationOutcome = "pass" | "fail" | "skipped";
export type VerificationEvidenceFreshness = "none" | "fresh" | "stale" | "mixed";

export const VERIFICATION_WRITE_MARKED_SCHEMA = "brewva.verification.write_marked.v1" as const;
export const VERIFICATION_OUTCOME_SCHEMA = "brewva.verification.outcome.v1" as const;

export interface VerificationWriteMarkedEventPayload {
  schema: typeof VERIFICATION_WRITE_MARKED_SCHEMA;
  toolName: string;
}

export interface VerificationOutcomeCheckResult {
  name: string;
  status: VerificationCheckStatus;
  evidence: string | null;
}

export interface VerificationOutcomeCheckProvenance {
  check: string;
  status: VerificationCheckStatus;
  command: string | null;
  hasRun: boolean;
  freshSinceWrite: boolean;
  runTimestamp: number | null;
  ledgerId: string | null;
}

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

export interface VerificationOutcomeRecordedEventPayload {
  schema: typeof VERIFICATION_OUTCOME_SCHEMA;
  level: VerificationLevel;
  outcome: VerificationOutcome;
  lessonKey: string;
  pattern: string;
  rootCause: string;
  recommendation: string | null;
  taskGoal: string | null;
  strategy: string;
  failedChecks: string[];
  missingChecks: string[];
  missingEvidence: string[];
  skipped: boolean;
  reason: string | null;
  evidence: string;
  evidenceIds: string[];
  checkResults: VerificationOutcomeCheckResult[];
  provenanceVersion: string;
  activeSkill: string | null;
  referenceWriteAt: number | null;
  evidenceFreshness: VerificationEvidenceFreshness;
  commandsExecuted: string[];
  commandsFresh: string[];
  commandsStale: string[];
  commandsMissing: string[];
  checkProvenance: VerificationOutcomeCheckProvenance[];
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
