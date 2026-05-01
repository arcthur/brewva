import type { SkillNormalizedOutputIssue } from "./normalization.js";
import type { LoadableSkillCategory } from "./types.js";

export type SkillReadinessState = "blocked" | "available" | "ready";

export interface SkillReadinessEntry {
  name: string;
  category: LoadableSkillCategory;
  readiness: SkillReadinessState;
  score: number;
  requires: string[];
  consumes: string[];
  satisfiedRequires: string[];
  missingRequires: string[];
  satisfiedConsumes: string[];
  issues: SkillNormalizedOutputIssue[];
  sourceSkillNames: string[];
  sourceEventIds: string[];
}

export interface SkillReadinessQuery {
  targetSkillName?: string;
}
