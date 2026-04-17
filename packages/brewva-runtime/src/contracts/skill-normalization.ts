import type { SemanticArtifactSchemaId } from "./skill.js";

export type SkillArtifactIssueTier = "tier_a" | "tier_b" | "tier_c";

export interface SkillNormalizedOutputIssue {
  outputName: string;
  path: string;
  reason: string;
  tier: SkillArtifactIssueTier;
  blockingConsumer?: string;
  schemaId?: SemanticArtifactSchemaId;
}

export interface SkillNormalizedBlockingState {
  status: "ready" | "partial" | "blocked";
  raw_present: boolean;
  normalized_present: boolean;
  partial: boolean;
  unresolved: string[];
  blocking_consumer?: string;
}

export interface SkillNormalizedOutputsView {
  canonical: Record<string, unknown>;
  issues: SkillNormalizedOutputIssue[];
  blockingState: SkillNormalizedBlockingState;
  canonicalSchemaIds: SemanticArtifactSchemaId[];
  normalizerVersion: string;
  sourceEventId?: string;
}

export interface SkillConsumedOutputsView {
  outputs: Record<string, unknown>;
  issues: SkillNormalizedOutputIssue[];
  blockingState: SkillNormalizedBlockingState;
  normalizerVersion: string;
  sourceSkillNames: string[];
  sourceEventIds: string[];
}
