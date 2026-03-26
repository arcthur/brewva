import type { VerificationLevel } from "./shared.js";

export type VerificationEvidenceKind = "lsp_clean" | "test_or_build_passed";

export type VerificationEvidenceMode = "heuristic" | "compiler" | "command" | "lsp_native";

export interface VerificationEvidence {
  kind: VerificationEvidenceKind;
  timestamp: number;
  tool: string;
  detail?: string;
  mode?: VerificationEvidenceMode;
}

export interface VerificationReport {
  passed: boolean;
  readOnly: boolean;
  skipped: boolean;
  reason?: "read_only";
  level: VerificationLevel;
  missingEvidence: string[];
  checks: Array<{
    name: string;
    status: "pass" | "fail" | "skip";
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
  evidence: VerificationEvidence[];
  checkRuns: Record<string, VerificationCheckRun>;
  denialCount: number;
}
