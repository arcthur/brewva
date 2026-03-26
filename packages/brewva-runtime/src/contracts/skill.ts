import type { ToolEffectClass } from "./governance.js";
import type { RuntimeSuccess, VerificationLevel } from "./shared.js";

export type LoadableSkillCategory = "core" | "domain" | "operator" | "meta" | "internal";
export type SkillOverlayCategory = "overlay";
export type SkillCategory = LoadableSkillCategory | SkillOverlayCategory;
export type SkillRoutingScope = "core" | "domain" | "operator" | "meta";
export type SkillCostHint = "low" | "medium" | "high";
export type SkillEffectLevel = "read_only" | "execute" | "mutation";

export interface SkillRoutingPolicy {
  scope: SkillRoutingScope;
}

export interface SkillResourceSet {
  references: string[];
  scripts: string[];
  heuristics: string[];
  invariants: string[];
}

export interface SkillOutputTextContract {
  kind: "text";
  minWords?: number;
  minLength?: number;
}

export interface SkillOutputEnumContract {
  kind: "enum";
  values: string[];
  caseSensitive?: boolean;
}

export interface SkillOutputJsonContract {
  kind: "json";
  minKeys?: number;
  minItems?: number;
}

export type SkillOutputContract =
  | SkillOutputTextContract
  | SkillOutputEnumContract
  | SkillOutputJsonContract;

export interface SkillCompletionDefinition {
  verificationLevel?: VerificationLevel;
  requiredEvidenceKinds?: string[];
}

export interface SkillIntentContract {
  outputs?: string[];
  outputContracts?: Record<string, SkillOutputContract>;
  completionDefinition?: SkillCompletionDefinition;
}

export interface SkillEffectsPolicy {
  allowedEffects?: ToolEffectClass[];
  deniedEffects?: ToolEffectClass[];
}

export type SkillEffectsContract = SkillEffectsPolicy;
export type SkillEffectsOverride = SkillEffectsPolicy;

export interface ResourceBudgetLimits {
  maxToolCalls?: number;
  maxTokens?: number;
  maxParallel?: number;
}

export type SkillResourceBudget = ResourceBudgetLimits;

export interface SkillResourcePolicy {
  defaultLease?: SkillResourceBudget;
  hardCeiling?: SkillResourceBudget;
}

export interface SkillSuggestedChain {
  steps: string[];
}

export interface SkillExecutionHints {
  preferredTools?: string[];
  fallbackTools?: string[];
  suggestedChains?: SkillSuggestedChain[];
  costHint?: SkillCostHint;
}

export interface SkillContract {
  name: string;
  category: LoadableSkillCategory;
  routing?: SkillRoutingPolicy;
  intent?: SkillIntentContract;
  effects?: SkillEffectsContract;
  resources?: SkillResourcePolicy;
  executionHints?: SkillExecutionHints;
  composableWith?: string[];
  consumes?: string[];
  requires?: string[];
  stability?: "experimental" | "stable" | "deprecated";
  description?: string;
}

export interface SkillContractOverride extends Omit<
  Partial<SkillContract>,
  "name" | "category" | "intent" | "effects" | "resources" | "executionHints" | "routing"
> {
  intent?: Partial<SkillIntentContract>;
  effects?: SkillEffectsOverride;
  resources?: {
    defaultLease?: Partial<SkillResourceBudget>;
    hardCeiling?: Partial<SkillResourceBudget>;
  };
  executionHints?: Partial<SkillExecutionHints>;
  routing?: Partial<SkillRoutingPolicy>;
}

export interface SkillOverlayContract extends SkillContractOverride {
  name: string;
  category: SkillOverlayCategory;
  stability?: "experimental" | "stable" | "deprecated";
  description?: string;
}

export type SkillContractLike = SkillContract | SkillOverlayContract;

interface BaseSkillDocument<TCategory extends SkillCategory, TContract> {
  name: string;
  description: string;
  category: TCategory;
  filePath: string;
  baseDir: string;
  markdown: string;
  contract: TContract;
  resources: SkillResourceSet;
  sharedContextFiles: string[];
  overlayFiles: string[];
}

export interface SkillDocument extends BaseSkillDocument<LoadableSkillCategory, SkillContract> {}

export interface OverlaySkillDocument extends BaseSkillDocument<
  SkillOverlayCategory,
  SkillOverlayContract
> {}

export type ParsedSkillDocument = SkillDocument | OverlaySkillDocument;

export interface SkillsIndexEntry {
  name: string;
  category: SkillCategory;
  description: string;
  outputs: string[];
  preferredTools: string[];
  fallbackTools: string[];
  allowedEffects: ToolEffectClass[];
  costHint: SkillCostHint;
  stability: "experimental" | "stable" | "deprecated";
  composableWith: string[];
  consumes: string[];
  requires: string[];
  effectLevel: SkillEffectLevel;
  routingScope?: SkillRoutingScope;
}

export type SkillActivationResult =
  | RuntimeSuccess<{
      skill: SkillDocument;
    }>
  | {
      ok: false;
      reason: string;
    };

export interface SkillOutputValidationIssue {
  name: string;
  reason: string;
}

export type SkillOutputValidationResult =
  | RuntimeSuccess<{
      missing: string[];
      invalid: SkillOutputValidationIssue[];
    }>
  | {
      ok: false;
      missing: string[];
      invalid: SkillOutputValidationIssue[];
    };

export interface SkillOutputRecord {
  skillName: string;
  completedAt: number;
  outputs: Record<string, unknown>;
}
