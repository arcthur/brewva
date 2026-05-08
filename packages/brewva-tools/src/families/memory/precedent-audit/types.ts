import type { KnowledgeSourceType } from "@brewva/brewva-recall/knowledge";
import type { NormalizedSolutionRecord } from "../solution-record.js";

export type PrecedentAuditVerdict = "pass" | "inconclusive" | "fail";
export type DerivativeLinkAuditStatus =
  | "not_applicable"
  | "sufficient"
  | "insufficient"
  | "unresolved";
export type PrecedentMaintenanceRecommendation =
  | "none"
  | "review_for_drift"
  | "mark_stale"
  | "mark_superseded"
  | "complete_derivative_routing";
export type PrecedentAuditFindingSeverity = "info" | "warn" | "error";

export interface PrecedentAuditFinding {
  code: string;
  severity: PrecedentAuditFindingSeverity;
  summary: string;
  refs: string[];
}

export interface PrecedentAuditSummary {
  verdict: PrecedentAuditVerdict;
  maintenanceRecommendation: PrecedentMaintenanceRecommendation;
  derivativeLinkStatus: DerivativeLinkAuditStatus;
  querySummary: string;
  candidatePath?: string;
  stableDocRefs: string[];
  peerSolutionRefs: string[];
  consultedRefs: Array<{
    path: string;
    sourceType: KnowledgeSourceType;
    authorityRank: number;
    freshness: string;
  }>;
  findings: PrecedentAuditFinding[];
}

export interface LoadedAuditCandidate {
  record: NormalizedSolutionRecord;
  candidatePath?: string;
}
