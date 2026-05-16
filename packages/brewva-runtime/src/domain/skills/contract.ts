import { readFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { parseMarkdownFrontmatter } from "@brewva/brewva-std/markdown";
import type {
  LoadableSkillCategory,
  OverlaySkillDocument,
  ParsedSkillDocument,
  SkillCard,
  SkillCardOverride,
  SkillCategory,
  SkillDocument,
  SkillOverlayCard,
  SkillResourceSet,
  SkillSelectionPolicy,
} from "./types.js";

const BASE_SKILL_FRONTMATTER_KEYS = [
  "name",
  "description",
  "selection",
  "references",
  "scripts",
  "invariants",
] as const;

const REMOVED_AUTHORITY_KEYS = [
  "routing",
  "intent",
  "effects",
  "resources",
  "execution_hints",
  "consumes",
  "requires",
  "composable_with",
  "stability",
  "budget",
  "tools",
  "dispatch",
] as const;

function failSkillCard(filePath: string, message: string): never {
  throw new Error(`[skill_card] ${filePath}: ${message}`);
}

function requireStringArrayField(
  data: Record<string, unknown>,
  key: string,
  filePath: string,
): string[] {
  const value = data[key];
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    failSkillCard(filePath, `frontmatter field '${key}' must be a string array.`);
  }
  const out: string[] = [];
  for (const [index, item] of value.entries()) {
    if (typeof item !== "string" || item.trim().length === 0) {
      failSkillCard(filePath, `frontmatter field '${key}[${index}]' must be a non-empty string.`);
    }
    out.push(item.trim());
  }
  return [...new Set(out)];
}

function readOptionalStringField(
  data: Record<string, unknown>,
  key: string,
  filePath: string,
): string | undefined {
  const value = data[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    failSkillCard(filePath, `frontmatter field '${key}' must be a string.`);
  }
  const normalized = value.trim();
  if (!normalized) {
    failSkillCard(filePath, `frontmatter field '${key}' cannot be empty.`);
  }
  return normalized;
}

function readSelectionPolicy(
  data: Record<string, unknown>,
  filePath: string,
): SkillSelectionPolicy | undefined {
  const value = data.selection;
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    failSkillCard(filePath, "frontmatter field 'selection' must be an object.");
  }
  const selection = value as Record<string, unknown>;
  const allowed = new Set(["when_to_use", "triggers", "path_globs"]);
  const unexpected = Object.keys(selection).filter((key) => !allowed.has(key));
  if (unexpected.length > 0) {
    failSkillCard(filePath, `selection contains unsupported field(s): ${unexpected.join(", ")}.`);
  }
  const whenToUse = readOptionalStringField(selection, "when_to_use", filePath);
  const triggers = requireStringArrayField(selection, "triggers", filePath);
  const pathGlobs = requireStringArrayField(selection, "path_globs", filePath);
  const normalized = {
    ...(whenToUse ? { whenToUse } : {}),
    ...(triggers.length > 0 ? { triggers } : {}),
    ...(pathGlobs.length > 0 ? { pathGlobs } : {}),
  } satisfies SkillSelectionPolicy;
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function assertSkillCardFrontmatter(
  data: Record<string, unknown>,
  category: SkillCategory,
  filePath: string,
): void {
  for (const key of REMOVED_AUTHORITY_KEYS) {
    if (Object.prototype.hasOwnProperty.call(data, key)) {
      failSkillCard(
        filePath,
        `frontmatter field '${key}' has been removed from SkillCard. Move authority, output, effect, tool, and budget metadata to capability or producer manifests.`,
      );
    }
  }
  if (Object.prototype.hasOwnProperty.call(data, "category")) {
    failSkillCard(
      filePath,
      "frontmatter field 'category' is not allowed. Category is derived from skill directory layout.",
    );
  }
  if (Object.prototype.hasOwnProperty.call(data, "tier")) {
    failSkillCard(
      filePath,
      "frontmatter field 'tier' is not allowed. Category is derived from skill directory layout.",
    );
  }

  const allowed = new Set<string>(BASE_SKILL_FRONTMATTER_KEYS);
  const unexpected = Object.keys(data).filter((key) => !allowed.has(key));
  if (unexpected.length > 0) {
    failSkillCard(filePath, `frontmatter contains unsupported field(s): ${unexpected.join(", ")}.`);
  }

  if ((category === "internal" || category === "meta") && data.selection !== undefined) {
    failSkillCard(filePath, `${category} skills cannot declare selection hints.`);
  }
}

function readSkillName(data: Record<string, unknown>, filePath: string): string {
  return readOptionalStringField(data, "name", filePath) ?? basename(dirname(filePath));
}

function readSkillDescription(
  data: Record<string, unknown>,
  name: string,
  filePath: string,
): string {
  return readOptionalStringField(data, "description", filePath) ?? `${name} skill`;
}

function normalizeResourceSet(data: Record<string, unknown>, filePath: string): SkillResourceSet {
  return {
    references: requireStringArrayField(data, "references", filePath),
    scripts: requireStringArrayField(data, "scripts", filePath),
    invariants: requireStringArrayField(data, "invariants", filePath),
  };
}

function normalizeCard(
  name: string,
  category: "overlay",
  data: Record<string, unknown>,
  filePath: string,
): SkillOverlayCard;
function normalizeCard(
  name: string,
  category: LoadableSkillCategory,
  data: Record<string, unknown>,
  filePath: string,
): SkillCard;
function normalizeCard(
  name: string,
  category: SkillCategory,
  data: Record<string, unknown>,
  filePath: string,
): SkillCard | SkillOverlayCard {
  assertSkillCardFrontmatter(data, category, filePath);
  const description = readOptionalStringField(data, "description", filePath);
  const selection = readSelectionPolicy(data, filePath);
  return {
    name,
    category,
    ...(description ? { description } : {}),
    ...(selection ? { selection } : {}),
  } as SkillCard | SkillOverlayCard;
}

function mergeSelectionPolicy(
  base: SkillSelectionPolicy | undefined,
  overlay: Partial<SkillSelectionPolicy> | undefined,
): SkillSelectionPolicy | undefined {
  if (!base && !overlay) return undefined;
  const triggers = [...new Set([...(base?.triggers ?? []), ...(overlay?.triggers ?? [])])];
  const pathGlobs = [...new Set([...(base?.pathGlobs ?? []), ...(overlay?.pathGlobs ?? [])])];
  const merged = {
    whenToUse: overlay?.whenToUse ?? base?.whenToUse,
    ...(triggers.length > 0 ? { triggers } : {}),
    ...(pathGlobs.length > 0 ? { pathGlobs } : {}),
  } satisfies SkillSelectionPolicy;
  return Object.keys(merged).some((key) => merged[key as keyof SkillSelectionPolicy] !== undefined)
    ? merged
    : undefined;
}

export function mergeOverlayCard(base: SkillCard, overlay: SkillCardOverride): SkillCard {
  const selection = mergeSelectionPolicy(base.selection, overlay.selection);
  return {
    ...base,
    ...(overlay.description ? { description: overlay.description } : {}),
    ...(selection ? { selection } : {}),
  };
}

export function mergeSkillResources(
  base: SkillResourceSet,
  overlay: SkillResourceSet,
): SkillResourceSet {
  return {
    references: [...new Set([...base.references, ...overlay.references])],
    scripts: [...new Set([...base.scripts, ...overlay.scripts])],
    invariants: [...new Set([...base.invariants, ...overlay.invariants])],
  };
}

export function createEmptySkillResources(): SkillResourceSet {
  return {
    references: [],
    scripts: [],
    invariants: [],
  };
}

export function parseSkillDocument(filePath: string, category: "overlay"): OverlaySkillDocument;
export function parseSkillDocument(
  filePath: string,
  category: LoadableSkillCategory,
): SkillDocument;
export function parseSkillDocument(filePath: string, category: SkillCategory): ParsedSkillDocument;
export function parseSkillDocument(filePath: string, category: SkillCategory): ParsedSkillDocument {
  const raw = readFileSync(filePath, "utf8");
  let body: string;
  let data: Record<string, unknown>;
  try {
    ({ body, data } = parseMarkdownFrontmatter(raw));
  } catch (error) {
    failSkillCard(filePath, error instanceof Error ? error.message : String(error));
  }

  const name = readSkillName(data, filePath);
  const description = readSkillDescription(data, name, filePath);
  const resources = normalizeResourceSet(data, filePath);
  const markdown = body.trim();
  const emptyResources = createEmptySkillResources();

  if (category === "overlay") {
    const card = normalizeCard(name, category, data, filePath);
    return {
      name,
      description,
      category,
      filePath,
      baseDir: dirname(filePath),
      markdown,
      authoredMarkdown: markdown,
      inheritedMarkdown: "",
      card,
      resources,
      authoredResources: resources,
      inheritedResources: emptyResources,
      projectGuidance: [],
      overlayFiles: [],
    };
  }

  const card = normalizeCard(name, category, data, filePath);
  return {
    name,
    description,
    category,
    filePath,
    baseDir: dirname(filePath),
    markdown,
    authoredMarkdown: markdown,
    inheritedMarkdown: "",
    card,
    resources,
    authoredResources: resources,
    inheritedResources: emptyResources,
    projectGuidance: [],
    overlayFiles: [],
  };
}
