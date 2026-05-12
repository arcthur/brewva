import type { ToolRiskLevel } from "../governance/api.js";
import type {
  BlastRadius,
  ConventionKind,
  ConventionLane,
  ConventionReviewSurface,
  RetirementSensitivity,
} from "./types.js";

function assertNever(value: never): never {
  throw new Error(`unsupported_convention_policy_value:${String(value)}`);
}

export function conventionLane(kind: ConventionKind): ConventionLane {
  switch (kind) {
    case "project_fact":
    case "user_preference":
    case "style_rule":
      return "soft";
    case "workflow_rule":
    case "routing_rule":
    case "verification_rule":
      return "governed";
    case "permission_rule":
    case "safety_boundary":
    case "compliance_rule":
      return "pinned";
    default:
      return assertNever(kind);
  }
}

export function conventionDefaultRisk(kind: ConventionKind): ToolRiskLevel {
  switch (kind) {
    case "project_fact":
    case "user_preference":
    case "style_rule":
      return "low";
    case "workflow_rule":
    case "routing_rule":
      return "medium";
    case "verification_rule":
    case "permission_rule":
      return "high";
    case "safety_boundary":
    case "compliance_rule":
      return "critical";
    default:
      return assertNever(kind);
  }
}

export function conventionRetirementSensitivity(kind: ConventionKind): RetirementSensitivity {
  switch (kind) {
    case "project_fact":
    case "user_preference":
    case "style_rule":
      return "auto_decay_allowed";
    case "workflow_rule":
    case "routing_rule":
    case "verification_rule":
      return "review_only";
    case "permission_rule":
      return "non_retirable_without_owner";
    case "safety_boundary":
    case "compliance_rule":
      return "pinned";
    default:
      return assertNever(kind);
  }
}

function riskRank(risk: ToolRiskLevel): number {
  if (risk === "critical") return 4;
  if (risk === "high") return 3;
  if (risk === "medium") return 2;
  return 1;
}

function riskFromRank(rank: number): ToolRiskLevel {
  if (rank >= 4) return "critical";
  if (rank === 3) return "high";
  if (rank === 2) return "medium";
  return "low";
}

function blastRadiusRisk(blastRadius: BlastRadius | undefined): ToolRiskLevel {
  switch (blastRadius) {
    case "workspace":
      return "high";
    case "security_boundary":
      return "critical";
    case "project":
      return "medium";
    case "session":
    case "task":
    case undefined:
      return "low";
    default:
      return assertNever(blastRadius);
  }
}

export function effectiveConventionRisk(input: {
  kind: ConventionKind;
  blastRadius?: BlastRadius;
}): ToolRiskLevel {
  return riskFromRank(
    Math.max(
      riskRank(conventionDefaultRisk(input.kind)),
      riskRank(blastRadiusRisk(input.blastRadius)),
    ),
  );
}

export function conventionReviewSurface(input: {
  lane: ConventionLane;
  riskLevel: ToolRiskLevel;
  mutation: boolean;
}): ConventionReviewSurface {
  if (input.riskLevel === "critical" || input.riskLevel === "high" || input.lane === "pinned") {
    return "interrupt";
  }
  if (!input.mutation && input.lane === "soft") {
    return "digest";
  }
  if (input.mutation) {
    return "digest";
  }
  return "audit";
}
