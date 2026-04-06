import type { ToolEffectClass } from "./governance.js";
import type { RuntimeSuccess, VerificationLevel } from "./shared.js";
import type { TaskPhase } from "./task.js";

export type LoadableSkillCategory = "core" | "domain" | "operator" | "meta" | "internal";
export type SkillOverlayCategory = "overlay";
export type SkillCategory = LoadableSkillCategory | SkillOverlayCategory;
export type SkillRoutingScope = "core" | "domain" | "operator" | "meta";
export type SkillCostHint = "low" | "medium" | "high";
export type SkillEffectLevel = "read_only" | "execute" | "mutation";
export type SkillRootSource = "system_root" | "global_root" | "project_root" | "config_root";
export const SEMANTIC_ARTIFACT_SCHEMA_IDS = [
  "planning.design_spec.v1",
  "planning.execution_plan.v1",
  "planning.execution_mode_hint.v1",
  "planning.risk_register.v1",
  "planning.implementation_targets.v1",
  "implementation.change_set.v1",
  "implementation.files_changed.v1",
  "implementation.verification_evidence.v1",
  "review.review_report.v1",
  "review.review_findings.v1",
  "review.merge_decision.v1",
  "qa.qa_report.v1",
  "qa.qa_findings.v1",
  "qa.qa_verdict.v1",
  "qa.qa_checks.v1",
  "qa.qa_missing_evidence.v1",
  "qa.qa_confidence_gaps.v1",
  "qa.qa_environment_limits.v1",
  "ship.ship_report.v1",
  "ship.release_checklist.v1",
  "ship.ship_decision.v1",
] as const;
export type SemanticArtifactSchemaId = (typeof SEMANTIC_ARTIFACT_SCHEMA_IDS)[number];
export type SkillSemanticBindings = Record<string, SemanticArtifactSchemaId>;
export const SKILL_REPAIR_ALLOWED_TOOL_NAMES = [
  "skill_complete",
  "workflow_status",
  "task_view_state",
  "ledger_query",
  "tape_info",
  "reasoning_checkpoint",
  "reasoning_revert",
  "session_compact",
] as const;
export const SKILL_REPAIR_MAX_ATTEMPTS = 2;
export const SKILL_REPAIR_MAX_TOOL_CALLS = 6;
export const SKILL_REPAIR_TOKEN_BUDGET = 12_000;

export interface SkillRegistryRoot {
  rootDir: string;
  skillDir: string;
  source: SkillRootSource;
}

export interface SkillRegistryLoadReport {
  roots: SkillRegistryRoot[];
  loadedSkills: string[];
  routingEnabled: boolean;
  routingScopes: SkillRoutingScope[];
  routableSkills: string[];
  hiddenSkills: string[];
  overlaySkills: string[];
  sharedContextFiles: string[];
  categories: Partial<Record<LoadableSkillCategory, string[]>>;
}

export interface SkillRoutingPolicy {
  scope: SkillRoutingScope;
}

export interface SkillSelectionPolicy {
  whenToUse: string;
  examples?: string[];
  paths?: string[];
  phases?: TaskPhase[];
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
  requiredFields?: string[];
  fieldContracts?: Record<string, SkillOutputContract>;
  itemContract?: SkillOutputContract;
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
  semanticBindings?: SkillSemanticBindings;
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
  selection?: SkillSelectionPolicy;
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
  | "name"
  | "category"
  | "intent"
  | "effects"
  | "resources"
  | "executionHints"
  | "routing"
  | "selection"
> {
  intent?: Partial<SkillIntentContract>;
  effects?: SkillEffectsOverride;
  resources?: {
    defaultLease?: Partial<SkillResourceBudget>;
    hardCeiling?: Partial<SkillResourceBudget>;
  };
  executionHints?: Partial<SkillExecutionHints>;
  routing?: Partial<SkillRoutingPolicy>;
  selection?: Partial<SkillSelectionPolicy>;
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

export interface SkillIndexOrigin {
  filePath: string;
  source: SkillRootSource;
  rootDir: string;
}

export interface SkillsIndexEntry {
  name: string;
  category: SkillCategory;
  description: string;
  filePath: string;
  baseDir: string;
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
  routable: boolean;
  overlay: boolean;
  sharedContextFiles: string[];
  routingScope?: SkillRoutingScope;
  selection?: SkillSelectionPolicy;
  source: SkillRootSource;
  rootDir: string;
  overlayOrigins?: SkillIndexOrigin[];
}

export interface SkillsIndexFile {
  schemaVersion: 1;
  generatedAt: string;
  roots: SkillRegistryRoot[];
  routing: {
    enabled: boolean;
    scopes: SkillRoutingScope[];
  };
  summary: {
    loadedSkills: number;
    routableSkills: number;
    hiddenSkills: number;
    overlaySkills: number;
  };
  skills: SkillsIndexEntry[];
}

export interface SkillRefreshInput {
  reason?: string;
  sessionId?: string;
}

export interface SkillSystemInstallResult {
  systemRoot: string;
  fingerprint: string;
  installed: boolean;
  migratedLegacyGlobalSeed: boolean;
}

export interface SkillRefreshResult {
  generatedAt: string;
  systemInstall: SkillSystemInstallResult;
  loadReport: SkillRegistryLoadReport;
  indexPath: string;
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
  schemaId?: SemanticArtifactSchemaId;
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

export interface SkillRepairBudgetState {
  maxAttempts: number;
  usedAttempts: number;
  remainingAttempts: number;
  maxToolCalls: number;
  usedToolCalls: number;
  remainingToolCalls: number;
  tokenBudget: number;
  enteredAtTokens?: number;
  latestObservedTokens?: number;
  usedTokens?: number;
}

export interface SkillCompletionFailureRecord {
  skillName: string;
  occurredAt: number;
  phase: "repair_required" | "failed_contract";
  outputKeys: string[];
  missing: string[];
  invalid: SkillOutputValidationIssue[];
  expectedOutputs: Record<string, unknown>;
  repairBudget: SkillRepairBudgetState;
}

export interface ActiveSkillRuntimeState {
  skillName: string;
  phase: "active" | "repair_required";
  repairBudget?: SkillRepairBudgetState;
  latestFailure?: SkillCompletionFailureRecord;
}
