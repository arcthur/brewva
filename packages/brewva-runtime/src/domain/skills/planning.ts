import type { PlanningOwnerLane, ReviewChangeCategory } from "./review.js";

export const DESIGN_EXECUTION_MODE_HINTS = [
  "direct_patch",
  "test_first",
  "coordinated_rollout",
] as const;

export const PLANNING_EVIDENCE_KEYS = [
  "design_spec",
  "execution_plan",
  "risk_register",
  "implementation_targets",
] as const;

export type DesignExecutionModeHint = (typeof DESIGN_EXECUTION_MODE_HINTS)[number];
export type PlanningEvidenceKey = (typeof PLANNING_EVIDENCE_KEYS)[number];
export type PlanningEvidenceState = "present" | "stale" | "missing";
export type DesignRiskSeverity = "critical" | "high" | "medium" | "low" | "unknown";

export interface DesignExecutionStep {
  step: string;
  intent?: string;
  owner?: string;
  exit_criteria?: string;
  verification_intent?: string;
}

export interface DesignImplementationTarget {
  target: string;
  kind?: string;
  owner_boundary?: string;
  reason?: string;
}

export interface DesignRiskItem {
  risk: string;
  category?: ReviewChangeCategory | "unknown";
  severity?: DesignRiskSeverity;
  mitigation?: string;
  required_evidence: string[];
  owner_lane?: PlanningOwnerLane | "unknown";
}

export interface PlanningArtifactSet {
  designSpec?: string;
  executionPlan?: DesignExecutionStep[];
  executionModeHint?: DesignExecutionModeHint;
  riskRegister?: DesignRiskItem[];
  implementationTargets?: DesignImplementationTarget[];
}
