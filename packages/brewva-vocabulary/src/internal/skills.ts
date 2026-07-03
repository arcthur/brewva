import { existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseMarkdownFrontmatter } from "@brewva/brewva-std/markdown";
import { readStringArray } from "./shared.js";
import type { ProtocolRecord } from "./types/foundation.js";

export type SkillCategory = string;

export type LoadableSkillCategory = string;

export interface SkillDocument extends ProtocolRecord {
  readonly name: string;
  readonly title?: string;
  readonly baseDir: string;
  readonly category: string;
  readonly filePath: string;
  readonly description: string;
  readonly markdown: string;
  readonly card: SkillCard;
  readonly resources: SkillResourceSet;
}

export type ParsedSkillDocument = SkillDocument;

export interface SkillCard extends ProtocolRecord {
  readonly name: string;
  readonly category: string;
  readonly description: string;
  readonly selection?: SkillSelectionPolicy;
  readonly argumentHints?: readonly string[];
  readonly outputArtifacts?: readonly string[];
}

export type SkillInvocationSelectionTrigger =
  | "explicit_command"
  | "suggested"
  | "delegated"
  | "discover_only";

export type SkillInvocationMode = "prompt_visible" | "delegated" | "inspect_only";

export interface SkillResourceRef extends ProtocolRecord {
  readonly kind: "reference" | "script" | "invariant";
  readonly path: string;
}

export interface SkillInvocationRecord extends ProtocolRecord {
  readonly invocationId: string;
  readonly skillName: string;
  readonly category: string;
  readonly sourcePath: string;
  readonly sourcePackage: string | null;
  readonly selectionTrigger: SkillInvocationSelectionTrigger;
  readonly invocationMode: SkillInvocationMode;
  readonly resourceRefs: readonly SkillResourceRef[];
  readonly estimatedTokens: number;
  readonly tokenEncoding: string;
  readonly tokenEstimateMethod: string;
  readonly tokenEstimateApproximation: boolean;
  readonly capabilityRefs: readonly string[];
  readonly requestedOutputArtifacts: readonly string[];
  readonly argumentHints: readonly string[];
}

export interface SkillRegistryLoadReport extends ProtocolRecord {
  readonly loadedSkills: readonly string[];
  readonly selectableSkills: readonly string[];
  readonly overlaySkills: readonly string[];
  readonly roots: readonly string[];
  /**
   * Project-category skills seen on disk but excluded from the catalog because
   * the session workspace lies outside the catalog root's project. Kept in the
   * report so selection receipts can explain the exclusion.
   */
  readonly outOfScopeSkills: readonly string[];
}

export interface SkillResourceSet extends ProtocolRecord {
  readonly references: readonly string[];
  readonly scripts: readonly string[];
  readonly invariants: readonly string[];
}

export const SKILLCARD_PROJECTION_LIMITS = {
  textFieldMaxChars: 1_536,
  listItemMaxCount: 16,
  resourceRefMaxCount: 24,
} as const;

interface SkillResourceRefSource {
  readonly resources: SkillResourceSet;
}

export function listSkillResourceRefs(skill: SkillResourceRefSource): SkillResourceRef[] {
  return [
    ...skill.resources.references.map((path): SkillResourceRef => ({ kind: "reference", path })),
    ...skill.resources.scripts.map((path): SkillResourceRef => ({ kind: "script", path })),
    ...skill.resources.invariants.map((path): SkillResourceRef => ({ kind: "invariant", path })),
  ];
}

export function listSurfacedSkillResourceRefs(skill: SkillResourceRefSource): SkillResourceRef[] {
  return listSkillResourceRefs(skill).slice(0, SKILLCARD_PROJECTION_LIMITS.resourceRefMaxCount);
}

export interface SkillSelectionPolicy extends ProtocolRecord {
  readonly whenToUse?: string;
  readonly pathGlobs?: readonly string[];
}

function readDocumentSource(sourceOrPath: string): {
  readonly source: string;
  readonly baseDir: string;
} {
  if (existsSync(sourceOrPath)) {
    return { source: readFileSync(sourceOrPath, "utf8"), baseDir: dirname(sourceOrPath) };
  }
  return { source: sourceOrPath, baseDir: process.cwd() };
}

function readSkillSelection(value: unknown): SkillSelectionPolicy | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as ProtocolRecord;
  if ("triggers" in record) {
    throw new Error("SkillCard field 'selection.triggers' has been removed");
  }
  if ("whenToUse" in record) {
    throw new Error("SkillCard field 'selection.whenToUse' has been removed");
  }
  if ("paths" in record) {
    throw new Error("SkillCard field 'selection.paths' has been removed");
  }
  const selection: {
    whenToUse?: string;
    pathGlobs?: string[];
  } = {};
  if (typeof record.when_to_use === "string") {
    selection.whenToUse = record.when_to_use;
  }
  const pathGlobs = readStringArray(record.path_globs);
  if (pathGlobs.length > 0) {
    selection.pathGlobs = pathGlobs;
  }
  return Object.keys(selection).length > 0 ? selection : undefined;
}

export function parseSkillDocument(
  sourceOrPath: string,
  category: SkillCategory = "core",
): ParsedSkillDocument {
  const { source, baseDir } = readDocumentSource(sourceOrPath);
  const parsedFrontmatter = parseMarkdownFrontmatter(source);
  const frontmatter = parsedFrontmatter.data;
  const markdown = parsedFrontmatter.body;
  if ("intent" in frontmatter) {
    throw new Error("SkillCard field 'intent' has been removed");
  }
  const title =
    markdown
      .split(/\r?\n/u)
      .find((line) => line.trim().length > 0)
      ?.replace(/^#\s*/u, "") ?? "Skill";
  const name = typeof frontmatter.name === "string" ? frontmatter.name : title;
  const description =
    typeof frontmatter.description === "string" ? frontmatter.description : `${title}.`;
  const selection = readSkillSelection(frontmatter.selection);
  const argumentHints = readStringArray(frontmatter.argument_hints);
  const outputArtifacts = readStringArray(frontmatter.output_artifacts);
  const card: SkillCard = {
    name,
    category,
    description,
    ...(selection ? { selection } : {}),
    ...(argumentHints.length > 0 ? { argumentHints } : {}),
    ...(outputArtifacts.length > 0 ? { outputArtifacts } : {}),
  };
  return {
    name,
    title,
    source,
    baseDir,
    filePath: existsSync(sourceOrPath) ? sourceOrPath : "",
    category,
    markdown,
    description,
    card,
    resources: {
      references: readStringArray(frontmatter.references),
      scripts: readStringArray(frontmatter.scripts),
      invariants: readStringArray(frontmatter.invariants),
    },
  };
}
