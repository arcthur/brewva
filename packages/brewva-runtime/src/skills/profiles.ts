import type {
  SkillConsumedOutputsView,
  SkillContract,
  SkillDocument,
  SkillEffectLevel,
  SkillReadinessEntry,
  SkillReadinessState,
  SkillResourceBudget,
  SkillRoutingScope,
  SkillSelectionPolicy,
  ToolEffectClass,
} from "../contracts/index.js";
import {
  listSkillAllowedEffects,
  listSkillDeniedEffects,
  listSkillOutputs,
  resolveSkillDefaultLease,
  resolveSkillEffectLevel,
  resolveSkillHardCeiling,
} from "./facets.js";

export type SkillLifecyclePlane = "discovery" | "selection" | "activation" | "handoff";
type SkillSelectionFieldPath = `selection.${Extract<keyof SkillSelectionPolicy, string>}`;
export type SkillFieldPath =
  | keyof SkillContract
  | SkillSelectionFieldPath
  | "authoredMarkdown.Trigger";

export const FIELD_TO_PLANE = {
  name: ["discovery", "selection", "activation", "handoff"],
  category: ["discovery", "activation", "handoff"],
  routing: ["discovery"],
  selection: [],
  "selection.whenToUse": ["selection"],
  "selection.paths": ["selection"],
  "authoredMarkdown.Trigger": ["selection"],
  intent: ["activation"],
  effects: ["activation"],
  resources: ["activation"],
  executionHints: [],
  composableWith: ["discovery"],
  consumes: ["activation", "handoff"],
  requires: ["activation", "handoff"],
  stability: ["discovery"],
  description: ["discovery"],
} as const satisfies Record<SkillFieldPath, readonly SkillLifecyclePlane[]>;

export function listSkillFieldsForPlane(plane: SkillLifecyclePlane): SkillFieldPath[] {
  return (Object.keys(FIELD_TO_PLANE) as SkillFieldPath[]).filter((field) => {
    const planes = FIELD_TO_PLANE[field] as readonly SkillLifecyclePlane[];
    return planes.includes(plane);
  });
}

export const SELECTION_PROFILE_SOURCE_FIELDS = listSkillFieldsForPlane("selection");

export interface SkillSelectionScorerProfile {
  name: string;
  whenToUse?: string;
  paths: string[];
  triggerBullets: string[];
}

export interface SkillSelectionModelProfile {
  name: string;
  summary: string;
  reasonLabels: string[];
}

export interface SkillSelectionProfile {
  forScorer: SkillSelectionScorerProfile;
  forModel: SkillSelectionModelProfile;
}

export interface SkillDiscoveryProfile {
  name: string;
  category: SkillDocument["category"];
  description: string;
  filePath: string;
  baseDir: string;
  routingScope?: SkillRoutingScope;
  stability: NonNullable<SkillContract["stability"]>;
}

export interface SkillActivationEnvelope {
  activeSkill: {
    name: string;
    category: SkillDocument["category"];
    baseDir: string;
  };
  effectPosture: {
    level: SkillEffectLevel;
    allowedEffects: ToolEffectClass[];
    deniedEffects: ToolEffectClass[];
  };
  budget: {
    defaultLease?: SkillResourceBudget;
    hardCeiling?: SkillResourceBudget;
  };
  requiredOutputs: string[];
  requiredInputs: string[];
  optionalInputs: string[];
  readiness: SkillReadinessState | "unknown";
  missingRequiredInputs: string[];
  consumedOutputs: Array<{
    key: string;
    value: string;
  }>;
  normalizationIssues: SkillConsumedOutputsView["issues"];
  instructions: string;
}

export interface SkillHandoffProfile {
  name: string;
  category: SkillDocument["category"];
  actionability: SkillReadinessState;
  requires: string[];
  consumes: string[];
  missingRequiredInputs: string[];
  satisfiedRequiredInputs: string[];
  satisfiedConsumedInputs: string[];
  blockingIssues: SkillConsumedOutputsView["issues"];
  sourceSkillNames: string[];
  sourceEventIds: string[];
}

export interface SkillHandoffProfileSource {
  name: string;
  category: SkillDocument["category"];
  contract?: Pick<SkillContract, "requires" | "consumes">;
  requires?: readonly string[];
  consumes?: readonly string[];
}

export interface SkillRoutingCatalogEntry {
  name: string;
  category: SkillDocument["category"];
  selection: SkillSelectionProfile;
  requires: string[];
  consumes: string[];
}

function extractMarkdownSection(markdown: string | undefined, heading: string): string {
  if (!markdown) return "";
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(?:^|\\n)##\\s+${escaped}\\s*\\n([\\s\\S]*?)(?=\\n##\\s+|$)`, "i");
  const match = markdown.match(pattern);
  return (match?.[1] ?? "").trim();
}

function extractMarkdownBullets(markdown: string | undefined, heading: string): string[] {
  return extractMarkdownSection(markdown, heading)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2).trim())
    .filter(Boolean);
}

function summarizeConsumedValue(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  const normalized = text && text.length > 0 ? text : String(value);
  return normalized.length > 500 ? `${normalized.slice(0, 497)}...` : normalized;
}

function buildSelectionModelProfile(
  scorer: SkillSelectionScorerProfile,
): SkillSelectionModelProfile {
  const reasonLabels = [
    scorer.whenToUse ? "when_to_use" : undefined,
    scorer.paths.length > 0 ? "paths" : undefined,
    scorer.triggerBullets.length > 0 ? "trigger" : undefined,
  ].filter((entry): entry is string => Boolean(entry));
  const summaryParts = [
    scorer.whenToUse,
    ...scorer.paths.map((path) => `path:${path}`),
    ...scorer.triggerBullets,
  ].filter((entry): entry is string => Boolean(entry));

  return {
    name: scorer.name,
    summary: summaryParts.join(" | "),
    reasonLabels,
  };
}

export function buildSkillSelectionProfile(
  skill: Pick<SkillDocument, "name" | "authoredMarkdown" | "contract">,
): SkillSelectionProfile {
  const scorer = {
    name: skill.name,
    ...(skill.contract.selection?.whenToUse
      ? { whenToUse: skill.contract.selection.whenToUse }
      : {}),
    paths: [...(skill.contract.selection?.paths ?? [])],
    triggerBullets: extractMarkdownBullets(skill.authoredMarkdown, "Trigger"),
  } satisfies SkillSelectionScorerProfile;

  return {
    forScorer: scorer,
    forModel: buildSelectionModelProfile(scorer),
  };
}

export function hasSelectionProfileSignals(profile: SkillSelectionProfile): boolean {
  return Boolean(
    profile.forScorer.whenToUse ||
    profile.forScorer.paths.length > 0 ||
    profile.forScorer.triggerBullets.length > 0,
  );
}

export function buildSkillDiscoveryProfile(
  skill: Pick<
    SkillDocument,
    "name" | "category" | "description" | "filePath" | "baseDir" | "contract"
  >,
): SkillDiscoveryProfile {
  return {
    name: skill.name,
    category: skill.category,
    description: skill.description,
    filePath: skill.filePath,
    baseDir: skill.baseDir,
    routingScope: skill.contract.routing?.scope,
    stability: skill.contract.stability ?? "stable",
  };
}

export function buildSkillActivationEnvelope(
  skill: SkillDocument,
  input: {
    consumedOutputs?: SkillConsumedOutputsView;
    readiness?: SkillReadinessEntry;
    maxConsumedOutputs?: number;
  } = {},
): SkillActivationEnvelope {
  const maxConsumedOutputs = input.maxConsumedOutputs ?? 8;
  const consumedOutputs = Object.entries(input.consumedOutputs?.outputs ?? {})
    .slice(0, maxConsumedOutputs)
    .map(([key, value]) => ({
      key,
      value: summarizeConsumedValue(value),
    }));

  return {
    activeSkill: {
      name: skill.name,
      category: skill.category,
      baseDir: skill.baseDir,
    },
    effectPosture: {
      level: resolveSkillEffectLevel(skill.contract),
      allowedEffects: listSkillAllowedEffects(skill.contract),
      deniedEffects: listSkillDeniedEffects(skill.contract),
    },
    budget: {
      defaultLease: resolveSkillDefaultLease(skill.contract),
      hardCeiling: resolveSkillHardCeiling(skill.contract),
    },
    requiredOutputs: listSkillOutputs(skill.contract),
    requiredInputs: [...(skill.contract.requires ?? [])],
    optionalInputs: [...(skill.contract.consumes ?? [])],
    readiness: input.readiness?.readiness ?? "unknown",
    missingRequiredInputs: [...(input.readiness?.missingRequires ?? [])],
    consumedOutputs,
    normalizationIssues: [...(input.consumedOutputs?.issues ?? [])],
    instructions: skill.markdown,
  };
}

export function buildSkillHandoffProfile(
  skill: SkillHandoffProfileSource,
  readiness?: SkillReadinessEntry,
): SkillHandoffProfile {
  return {
    name: skill.name,
    category: skill.category,
    actionability: readiness?.readiness ?? "available",
    requires: [...(skill.contract?.requires ?? skill.requires ?? [])],
    consumes: [...(skill.contract?.consumes ?? skill.consumes ?? [])],
    missingRequiredInputs: [...(readiness?.missingRequires ?? [])],
    satisfiedRequiredInputs: [...(readiness?.satisfiedRequires ?? [])],
    satisfiedConsumedInputs: [...(readiness?.satisfiedConsumes ?? [])],
    blockingIssues: [...(readiness?.issues ?? [])],
    sourceSkillNames: [...(readiness?.sourceSkillNames ?? [])],
    sourceEventIds: [...(readiness?.sourceEventIds ?? [])],
  };
}

export function buildSkillRoutingCatalogEntry(
  skill: Pick<SkillDocument, "name" | "category" | "authoredMarkdown" | "contract">,
): SkillRoutingCatalogEntry {
  return {
    name: skill.name,
    category: skill.category,
    selection: buildSkillSelectionProfile(skill),
    requires: [...(skill.contract.requires ?? [])],
    consumes: [...(skill.contract.consumes ?? [])],
  };
}
