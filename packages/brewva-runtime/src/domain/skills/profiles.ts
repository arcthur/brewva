import type {
  SkillContract,
  SkillDocument,
  SkillRoutingScope,
  SkillSelectionPolicy,
} from "./types.js";

export type SkillCatalogPlane = "discovery" | "selection";
type SkillSelectionFieldPath = `selection.${Extract<keyof SkillSelectionPolicy, string>}`;
export type SkillFieldPath =
  | keyof SkillContract
  | SkillSelectionFieldPath
  | "authoredMarkdown.Trigger";

export const FIELD_TO_PLANE = {
  name: ["discovery", "selection"],
  category: ["discovery"],
  routing: ["discovery"],
  selection: [],
  "selection.whenToUse": ["selection"],
  "selection.paths": ["selection"],
  "authoredMarkdown.Trigger": ["selection"],
  intent: [],
  effects: [],
  resources: [],
  executionHints: [],
  composableWith: ["discovery"],
  consumes: [],
  requires: [],
  stability: ["discovery"],
  description: ["discovery"],
} as const satisfies Record<SkillFieldPath, readonly SkillCatalogPlane[]>;

export function listSkillFieldsForPlane(plane: SkillCatalogPlane): SkillFieldPath[] {
  return (Object.keys(FIELD_TO_PLANE) as SkillFieldPath[]).filter((field) => {
    const planes = FIELD_TO_PLANE[field] as readonly SkillCatalogPlane[];
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
