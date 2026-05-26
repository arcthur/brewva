import { existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { parse as parseYaml } from "yaml";
import { optionalStringField, readStringArray } from "./shared.js";
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

export type SkillOutputContract =
  | ({
      readonly kind: "text";
      readonly minWords?: number;
      readonly minLength?: number;
    } & ProtocolRecord)
  | ({
      readonly kind: "json";
      readonly minItems?: number;
      readonly minKeys?: number;
    } & ProtocolRecord)
  | ({ readonly kind: "enum"; readonly values: readonly string[] } & ProtocolRecord);

export interface SkillRegistryLoadReport extends ProtocolRecord {
  readonly loadedSkills: readonly string[];
  readonly selectableSkills: readonly string[];
  readonly overlaySkills: readonly string[];
  readonly roots: readonly string[];
  readonly projectGuidance: readonly ProjectGuidanceEntry[];
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

export type SkillSemanticBindings = Record<string, string>;

export interface ProducerContract extends ProtocolRecord {
  readonly source?: string;
  readonly producer?: string;
  readonly filePath?: string;
  readonly outputs?: readonly string[];
  readonly outputContracts?: Record<string, SkillOutputContract>;
  readonly semanticBindings?: Record<string, string>;
}

export interface ProjectGuidanceEntry extends ProtocolRecord {}

function readDocumentSource(sourceOrPath: string): {
  readonly source: string;
  readonly baseDir: string;
} {
  if (existsSync(sourceOrPath)) {
    return { source: readFileSync(sourceOrPath, "utf8"), baseDir: dirname(sourceOrPath) };
  }
  return { source: sourceOrPath, baseDir: process.cwd() };
}

function readYamlFrontmatter(source: string): {
  readonly frontmatter: ProtocolRecord;
  readonly markdown: string;
} {
  const match = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?/u.exec(source);
  if (!match) {
    return { frontmatter: {}, markdown: source };
  }
  const parsed = parseYaml(match[1] ?? "");
  return {
    frontmatter: typeof parsed === "object" && parsed !== null ? (parsed as ProtocolRecord) : {},
    markdown: source.slice(match[0].length),
  };
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
  const { frontmatter, markdown } = readYamlFrontmatter(source);
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

export function parseProducerContractFile(
  sourceOrPath: string,
  ..._rest: unknown[]
): ProducerContract {
  const { source } = readDocumentSource(sourceOrPath);
  const parsed = parseYaml(source);
  const record = typeof parsed === "object" && parsed !== null ? (parsed as ProtocolRecord) : {};
  const rawContracts =
    typeof record.output_contracts === "object" && record.output_contracts !== null
      ? (record.output_contracts as ProtocolRecord)
      : {};
  const outputContractEntries: Array<[string, SkillOutputContract]> = Object.entries(
    rawContracts,
  ).flatMap(([key, value]) => {
    if (typeof value !== "object" || value === null) return [];
    const contract = value as ProtocolRecord;
    const normalized = Object.fromEntries(
      Object.entries(contract).filter(([contractKey]) => contractKey !== "min_words"),
    );
    return [
      [
        key,
        {
          ...normalized,
          ...(typeof contract.min_words === "number" ? { minWords: contract.min_words } : {}),
        },
      ] as [string, SkillOutputContract],
    ];
  });
  const outputContracts: Record<string, SkillOutputContract> =
    Object.fromEntries(outputContractEntries);
  return {
    source,
    producer: optionalStringField(record, "producer") ?? source,
    filePath: sourceOrPath,
    outputs: readStringArray(record.outputs),
    outputContracts,
  };
}

export function getProducerOutputContracts(
  producer: ProducerContract | undefined,
): Record<string, SkillOutputContract> {
  return producer?.outputContracts ?? {};
}

export function getProducerSemanticBindings(
  producer: ProducerContract | undefined,
): SkillSemanticBindings {
  return producer?.semanticBindings ?? {};
}

export function listProducerOutputs(producer: ProducerContract | undefined): readonly string[] {
  return producer?.outputs ?? [];
}
