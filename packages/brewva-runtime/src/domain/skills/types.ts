import type { ConventionKind, RetirementSensitivity } from "../conventions/api.js";
import { SEMANTIC_ARTIFACT_SCHEMA_IDS } from "./semantic-artifacts.js";
export { SEMANTIC_ARTIFACT_SCHEMA_IDS } from "./semantic-artifacts.js";

export type LoadableSkillCategory = "core" | "domain" | "operator" | "meta" | "internal";
export type SkillOverlayCategory = "overlay";
export type SkillCategory = LoadableSkillCategory | SkillOverlayCategory;
export type SkillRootSource = "system_root" | "global_root" | "project_root" | "config_root";
export type ProjectGuidanceStrength = "invariant" | "workflow_gate" | "preference" | "lookup";

export interface ProjectGuidanceEntry {
  filePath: string;
  strength: ProjectGuidanceStrength;
  scope: string;
  conventionKind: ConventionKind;
  retirementSensitivity: RetirementSensitivity;
  owner?: string;
}

export type SemanticArtifactSchemaId = (typeof SEMANTIC_ARTIFACT_SCHEMA_IDS)[number];
export type SkillSemanticBindings = Record<string, SemanticArtifactSchemaId>;

export interface SkillRegistryRoot {
  rootDir: string;
  skillDir: string;
  source: SkillRootSource;
}

export interface SkillRegistryLoadReport {
  roots: SkillRegistryRoot[];
  loadedSkills: string[];
  selectableSkills: string[];
  overlaySkills: string[];
  projectGuidance: ProjectGuidanceEntry[];
  categories: Partial<Record<LoadableSkillCategory, string[]>>;
}

export interface SkillSelectionPolicy {
  whenToUse?: string;
  triggers?: string[];
  pathGlobs?: string[];
}

export interface SkillResourceSet {
  references: string[];
  scripts: string[];
  invariants: string[];
}

export interface SkillCard {
  name: string;
  category: LoadableSkillCategory;
  selection?: SkillSelectionPolicy;
  description?: string;
}

export interface SkillCardOverride extends Omit<Partial<SkillCard>, "name" | "category"> {
  selection?: Partial<SkillSelectionPolicy>;
}

export interface SkillOverlayCard extends SkillCardOverride {
  name: string;
  category: SkillOverlayCategory;
  description?: string;
}

export type SkillCardLike = SkillCard | SkillOverlayCard;

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

export interface ProducerContract {
  producer: string;
  outputs: string[];
  outputContracts: Record<string, SkillOutputContract>;
  semanticBindings: SkillSemanticBindings;
  filePath: string;
  source: SkillRootSource;
  rootDir: string;
}

interface BaseSkillDocument<TCategory extends SkillCategory, TCard> {
  name: string;
  description: string;
  category: TCategory;
  filePath: string;
  baseDir: string;
  markdown: string;
  authoredMarkdown: string;
  inheritedMarkdown: string;
  card: TCard;
  resources: SkillResourceSet;
  authoredResources: SkillResourceSet;
  inheritedResources: SkillResourceSet;
  projectGuidance: ProjectGuidanceEntry[];
  overlayFiles: string[];
}

export interface SkillDocument extends BaseSkillDocument<LoadableSkillCategory, SkillCard> {}

export interface OverlaySkillDocument extends BaseSkillDocument<
  SkillOverlayCategory,
  SkillOverlayCard
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
  selectable: boolean;
  overlay: boolean;
  projectGuidance: ProjectGuidanceEntry[];
  selection?: SkillSelectionPolicy;
  source: SkillRootSource;
  rootDir: string;
  overlayOrigins?: SkillIndexOrigin[];
}

export interface SkillsIndexFile {
  schemaVersion: 3;
  generatedAt: string;
  roots: SkillRegistryRoot[];
  summary: {
    loadedSkills: number;
    selectableSkills: number;
    overlaySkills: number;
  };
  skills: SkillsIndexEntry[];
}

export interface SkillRefreshInput {
  reason?: string;
  sessionId?: string;
}

export interface SkillRefreshResult {
  generatedAt: string;
  systemInstall: SkillSystemInstallResult;
  loadReport: SkillRegistryLoadReport;
  indexPath: string;
}

export interface SkillSystemInstallResult {
  systemRoot: string;
  fingerprint: string;
  installed: boolean;
  migratedLegacyGlobalSeed: boolean;
}
