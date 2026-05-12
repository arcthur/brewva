import type { RuntimeResult } from "../../core/runtime-result.js";
import type { EvidenceRef } from "../evidence/api.js";
import type { ToolRiskLevel } from "../governance/api.js";
import type { PatchSet } from "../patching/api.js";

export const CONVENTION_KINDS = [
  "project_fact",
  "user_preference",
  "style_rule",
  "workflow_rule",
  "routing_rule",
  "verification_rule",
  "permission_rule",
  "safety_boundary",
  "compliance_rule",
] as const;

export type ConventionKind = (typeof CONVENTION_KINDS)[number];

export const CONVENTION_LANES = ["soft", "governed", "pinned"] as const;

export type ConventionLane = (typeof CONVENTION_LANES)[number];

export const RETIREMENT_SENSITIVITIES = [
  "auto_decay_allowed",
  "review_only",
  "non_retirable_without_owner",
  "pinned",
] as const;

export type RetirementSensitivity = (typeof RETIREMENT_SENSITIVITIES)[number];

export const BLAST_RADII = [
  "session",
  "task",
  "project",
  "workspace",
  "security_boundary",
] as const;

export type BlastRadius = (typeof BLAST_RADII)[number];

export const CONVENTION_REVIEW_SURFACES = ["digest", "interrupt", "audit"] as const;

export type ConventionReviewSurface = (typeof CONVENTION_REVIEW_SURFACES)[number];

export const CONVENTION_TRANSITIONS = [
  "observe",
  "promote",
  "modify",
  "retire",
  "contest",
  "emergency_override",
] as const;

export type ConventionTransition = (typeof CONVENTION_TRANSITIONS)[number];

export const CONVENTION_DECISIONS = ["accept", "reject", "defer"] as const;

export type ConventionDecision = (typeof CONVENTION_DECISIONS)[number];

export function isConventionKind(value: unknown): value is ConventionKind {
  return typeof value === "string" && CONVENTION_KINDS.includes(value as ConventionKind);
}

export function isRetirementSensitivity(value: unknown): value is RetirementSensitivity {
  return (
    typeof value === "string" && RETIREMENT_SENSITIVITIES.includes(value as RetirementSensitivity)
  );
}

export type ConventionTarget =
  | {
      kind: "project_guidance";
      path: string;
    }
  | {
      kind: "skill_contract";
      path: string;
      skillName?: string;
    }
  | {
      kind: "runtime_config";
      path: string;
      configPaths: string[];
    };

export interface ConventionChangeRequest {
  id: string;
  issuer: string;
  subject: string;
  conventionKind: ConventionKind;
  transition: ConventionTransition;
  target: ConventionTarget;
  evidenceRefs: EvidenceRef[];
  rationale: string;
  blastRadius?: BlastRadius;
  owner?: string;
  patchSet?: PatchSet;
  expiresAt?: number;
  createdAt: number;
}

export interface ConventionDecisionReceipt {
  requestId: string;
  decision: ConventionDecision;
  lane: ConventionLane;
  riskLevel: ToolRiskLevel;
  reviewSurface: ConventionReviewSurface;
  policyBasis: string[];
  reasons: string[];
  evidenceRefs: EvidenceRef[];
  turn: number;
  timestamp: number;
}

export type ConventionRequestState = "pending" | "accepted" | "rejected" | "consumed";

export interface ConventionRequestRecord {
  request: ConventionChangeRequest;
  state: ConventionRequestState;
  receipt?: ConventionDecisionReceipt;
  appliedPatchSetId?: string;
  mutationReceiptId?: string;
  updatedAt: number;
}

export interface ConventionState {
  requests: ConventionRequestRecord[];
  pending: ConventionRequestRecord[];
  activeConventions: ConventionChangeRequest[];
  contestedRequestIds: string[];
  updatedAt: number | null;
}

export interface ConventionDigest {
  pendingCount: number;
  interruptCount: number;
  digestCount: number;
  auditCount: number;
  latestUpdatedAt: number | null;
}

export type DecideConventionChangeResult = RuntimeResult<
  {
    request: ConventionChangeRequest;
    receipt: ConventionDecisionReceipt;
  },
  "request_not_found" | "decision_required"
>;

export type ApplyApprovedConventionChangeResult = RuntimeResult<
  {
    request: ConventionChangeRequest;
    patchSetId: string;
    mutationReceiptId: string;
    appliedPaths: string[];
  },
  | "request_not_found"
  | "request_not_accepted"
  | "missing_patchset"
  | "invalid_target"
  | "patch_apply_failed"
>;
