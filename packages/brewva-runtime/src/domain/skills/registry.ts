import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { parseMarkdownFrontmatter } from "@brewva/brewva-std/markdown";
import { formatISO } from "date-fns";
import { resolveGlobalBrewvaRootDir, resolveProjectBrewvaRootDir } from "../../config/paths.js";
import type { BrewvaConfig } from "../../config/types.js";
import {
  RETIREMENT_SENSITIVITIES,
  conventionRetirementSensitivity,
  isConventionKind,
  isRetirementSensitivity,
} from "../conventions/api.js";
import {
  createEmptySkillResources,
  mergeOverlayCard,
  mergeSkillResources,
  parseSkillDocument,
} from "./contract.js";
import { parseProducerContractFile } from "./producers.js";
import { resolveBundledSystemSkillsRoot } from "./system-install.js";
import type {
  LoadableSkillCategory,
  ProducerContract,
  ProjectGuidanceEntry,
  ProjectGuidanceStrength,
  SkillDocument,
  SkillIndexOrigin,
  SkillRegistryLoadReport,
  SkillRegistryRoot,
  SkillRootSource,
  SkillsIndexEntry,
  SkillsIndexFile,
} from "./types.js";

const LOADABLE_SKILL_CATEGORIES: LoadableSkillCategory[] = [
  "core",
  "domain",
  "operator",
  "meta",
  "internal",
];

const PROJECT_GUIDANCE_STRENGTHS: ProjectGuidanceStrength[] = [
  "invariant",
  "workflow_gate",
  "preference",
  "lookup",
];

interface ProjectGuidanceSource extends ProjectGuidanceEntry {
  markdown: string;
}

interface DefaultSkillGuidanceSource {
  filePath: string;
  markdown: string;
}

interface LoadedSkillOrigin {
  base: SkillIndexOrigin;
  overlays: SkillIndexOrigin[];
}

function cloneSkillRegistryRoot(entry: SkillRegistryRoot): SkillRegistryRoot {
  return {
    rootDir: entry.rootDir,
    skillDir: entry.skillDir,
    source: entry.source,
  };
}

function cloneProjectGuidanceEntry(entry: ProjectGuidanceEntry): ProjectGuidanceEntry {
  return {
    filePath: entry.filePath,
    strength: entry.strength,
    scope: entry.scope,
    conventionKind: entry.conventionKind,
    retirementSensitivity: entry.retirementSensitivity,
    ...(entry.owner ? { owner: entry.owner } : {}),
  };
}

function cloneProjectGuidanceEntries(
  entries: readonly ProjectGuidanceEntry[],
): ProjectGuidanceEntry[] {
  return entries.map(cloneProjectGuidanceEntry);
}

function uniqueProjectGuidanceEntries(
  entries: readonly ProjectGuidanceEntry[],
): ProjectGuidanceEntry[] {
  return [
    ...new Map(entries.map((entry) => [entry.filePath, cloneProjectGuidanceEntry(entry)])).values(),
  ].toSorted((left, right) => left.filePath.localeCompare(right.filePath));
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function hasSkillCategoryDirectories(skillDir: string): boolean {
  return (
    LOADABLE_SKILL_CATEGORIES.some((category) => isDirectory(join(skillDir, category))) ||
    isDirectory(join(skillDir, "project"))
  );
}

function resolveSkillDirectory(rootDir: string): string | undefined {
  const normalizedRoot = resolve(rootDir);
  const direct = normalizedRoot;
  const nested = join(normalizedRoot, "skills");
  if (hasSkillCategoryDirectories(direct)) return direct;
  if (hasSkillCategoryDirectories(nested)) return nested;
  return undefined;
}

function sourcePriority(source: SkillRootSource): number {
  if (source === "config_root") return 4;
  if (source === "project_root") return 3;
  if (source === "global_root") return 2;
  return 1;
}

function appendDiscoveredRoot(
  roots: SkillRegistryRoot[],
  rootIndexBySkillDir: Map<string, number>,
  rootDir: string,
  source: SkillRootSource,
): void {
  const skillDir = resolveSkillDirectory(rootDir);
  if (!skillDir) return;
  const skillDirKey = resolve(skillDir);
  const existingIndex = rootIndexBySkillDir.get(skillDirKey);
  if (existingIndex !== undefined) {
    const existing = roots[existingIndex];
    if (!existing) return;
    if (sourcePriority(source) > sourcePriority(existing.source)) {
      roots[existingIndex] = {
        rootDir: resolve(rootDir),
        skillDir: existing.skillDir,
        source,
      };
    }
    return;
  }

  rootIndexBySkillDir.set(skillDirKey, roots.length);
  roots.push({
    rootDir: resolve(rootDir),
    skillDir: skillDirKey,
    source,
  });
}

export function discoverSkillRegistryRoots(input: {
  cwd: string;
  configuredRoots?: readonly string[];
  globalRootDir?: string;
}): SkillRegistryRoot[] {
  const roots: SkillRegistryRoot[] = [];
  const rootIndexBySkillDir = new Map<string, number>();

  const globalRootDir = input.globalRootDir ?? resolveGlobalBrewvaRootDir();
  appendDiscoveredRoot(
    roots,
    rootIndexBySkillDir,
    resolveBundledSystemSkillsRoot(globalRootDir),
    "system_root",
  );
  appendDiscoveredRoot(roots, rootIndexBySkillDir, globalRootDir, "global_root");

  const projectRoot = resolveProjectBrewvaRootDir(input.cwd);
  appendDiscoveredRoot(roots, rootIndexBySkillDir, projectRoot, "project_root");

  for (const configured of input.configuredRoots ?? []) {
    if (typeof configured !== "string") continue;
    const trimmed = configured.trim();
    if (!trimmed) continue;
    appendDiscoveredRoot(roots, rootIndexBySkillDir, resolve(input.cwd, trimmed), "config_root");
  }

  return roots;
}

function isContainedWithin(candidate: string, container: string): boolean {
  const resolved = resolve(candidate);
  const base = resolve(container);
  return resolved === base || resolved.startsWith(base + "/");
}

function walkFiles(
  rootDir: string,
  predicate: (path: string, allowRootMarkdown: boolean) => boolean,
): string[] {
  if (!isDirectory(rootDir)) return [];
  const resolvedRoot = resolve(rootDir);
  const out: string[] = [];

  const walk = (dir: string, allowRootMarkdown: boolean): void => {
    let entries: Array<import("node:fs").Dirent>;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const full = join(dir, entry.name);
      let isDir = entry.isDirectory();
      let isFile = entry.isFile();
      if (entry.isSymbolicLink()) {
        try {
          const real = realpathSync(full);
          if (!isContainedWithin(real, resolvedRoot)) continue;
          const st = statSync(real);
          isDir = st.isDirectory();
          isFile = st.isFile();
        } catch {
          continue;
        }
      }

      if (isDir) {
        walk(full, false);
        continue;
      }
      if (!isFile) continue;
      if (predicate(full, allowRootMarkdown)) {
        out.push(full);
      }
    }
  };

  walk(resolvedRoot, true);
  return out;
}

function listSkillFiles(rootDir: string): string[] {
  return walkFiles(rootDir, (path) => basename(path) === "SKILL.md").toSorted((a, b) =>
    a.localeCompare(b),
  );
}

function listProducerFiles(rootDir: string): string[] {
  return walkFiles(rootDir, (path) => /\.(?:ya?ml)$/iu.test(path)).toSorted((a, b) =>
    a.localeCompare(b),
  );
}

function listMarkdownFiles(rootDir: string): string[] {
  return walkFiles(rootDir, (path) => path.endsWith(".md")).toSorted((a, b) => a.localeCompare(b));
}

function joinMarkdownSections(sections: string[]): string {
  return sections
    .map((section) => section.trim())
    .filter(Boolean)
    .join("\n\n");
}

function normalizeResourcePathInput(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return trimmed;
  if (trimmed === "~") return homedir();
  if (trimmed.startsWith("~/")) {
    return join(homedir(), trimmed.slice(2));
  }
  return trimmed;
}

function resolveSkillResourcePath(input: {
  resourcePath: string;
  baseDir: string;
  skillDir: string;
}): string {
  const normalized = normalizeResourcePathInput(input.resourcePath).replaceAll("\\", "/");
  if (!normalized) {
    return normalized;
  }
  if (isAbsolute(normalized)) {
    return resolve(normalized);
  }

  if (normalized.startsWith("skills/")) {
    const anchorDir =
      basename(input.skillDir) === "skills" ? dirname(input.skillDir) : input.skillDir;
    const relativePath =
      basename(input.skillDir) === "skills" ? normalized : normalized.slice("skills/".length);
    return resolve(anchorDir, relativePath);
  }

  return resolve(input.baseDir, normalized);
}

function resolveSkillResources(
  resources: SkillDocument["resources"],
  input: {
    baseDir: string;
    skillDir: string;
  },
): SkillDocument["resources"] {
  return {
    references: resources.references.map((resourcePath) =>
      resolveSkillResourcePath({
        resourcePath,
        baseDir: input.baseDir,
        skillDir: input.skillDir,
      }),
    ),
    scripts: resources.scripts.map((resourcePath) =>
      resolveSkillResourcePath({
        resourcePath,
        baseDir: input.baseDir,
        skillDir: input.skillDir,
      }),
    ),
    invariants: resources.invariants.map((resourcePath) =>
      resolveSkillResourcePath({
        resourcePath,
        baseDir: input.baseDir,
        skillDir: input.skillDir,
      }),
    ),
  };
}

function failProjectGuidance(filePath: string, message: string): never {
  throw new Error(`[project_guidance] ${filePath}: ${message}`);
}

function isProjectGuidanceStrength(value: unknown): value is ProjectGuidanceStrength {
  return (
    typeof value === "string" && (PROJECT_GUIDANCE_STRENGTHS as readonly string[]).includes(value)
  );
}

function parseProjectGuidanceFile(filePath: string): ProjectGuidanceSource {
  const raw = readFileSync(filePath, "utf8");
  let parsed: ReturnType<typeof parseMarkdownFrontmatter>;
  try {
    parsed = parseMarkdownFrontmatter(raw);
  } catch (error) {
    failProjectGuidance(filePath, error instanceof Error ? error.message : String(error));
  }
  if (!parsed.hasFrontmatter) {
    failProjectGuidance(filePath, "missing required metadata frontmatter.");
  }
  const allowedKeys = new Set([
    "strength",
    "scope",
    "convention_kind",
    "retirement_sensitivity",
    "owner",
  ]);
  const unexpected = Object.keys(parsed.data).filter((key) => !allowedKeys.has(key));
  if (unexpected.length > 0) {
    failProjectGuidance(
      filePath,
      `frontmatter contains unsupported field(s): ${unexpected.join(", ")}.`,
    );
  }
  if (!isProjectGuidanceStrength(parsed.data.strength)) {
    failProjectGuidance(
      filePath,
      `frontmatter.strength must be one of: ${PROJECT_GUIDANCE_STRENGTHS.join(" | ")}.`,
    );
  }
  if (typeof parsed.data.scope !== "string" || parsed.data.scope.trim().length === 0) {
    failProjectGuidance(filePath, "frontmatter.scope must be a non-empty string.");
  }
  if (!isConventionKind(parsed.data.convention_kind)) {
    failProjectGuidance(filePath, "frontmatter.convention_kind must be a known convention kind.");
  }
  if (!isRetirementSensitivity(parsed.data.retirement_sensitivity)) {
    failProjectGuidance(
      filePath,
      `frontmatter.retirement_sensitivity must be one of: ${RETIREMENT_SENSITIVITIES.join(" | ")}.`,
    );
  }
  const expectedRetirementSensitivity = conventionRetirementSensitivity(
    parsed.data.convention_kind,
  );
  if (parsed.data.retirement_sensitivity !== expectedRetirementSensitivity) {
    failProjectGuidance(
      filePath,
      `frontmatter.retirement_sensitivity must match convention_kind default: ${expectedRetirementSensitivity}.`,
    );
  }
  const owner =
    typeof parsed.data.owner === "string" && parsed.data.owner.trim().length > 0
      ? parsed.data.owner.trim()
      : undefined;
  if (parsed.data.owner !== undefined && !owner) {
    failProjectGuidance(filePath, "frontmatter.owner must be a non-empty string when provided.");
  }
  if (
    (parsed.data.retirement_sensitivity === "non_retirable_without_owner" ||
      parsed.data.retirement_sensitivity === "pinned") &&
    !owner
  ) {
    failProjectGuidance(
      filePath,
      "frontmatter.owner is required for pinned or non-retirable convention guidance.",
    );
  }
  return {
    filePath,
    strength: parsed.data.strength,
    scope: parsed.data.scope.trim(),
    conventionKind: parsed.data.convention_kind,
    retirementSensitivity: parsed.data.retirement_sensitivity,
    ...(owner ? { owner } : {}),
    markdown: parsed.body.trim(),
  };
}

function demoteProjectGuidanceHeadings(markdown: string): string {
  return markdown
    .split("\n")
    .map((line) => {
      const match = /^(#{1,6})(\s+.*)$/.exec(line);
      if (!match) {
        return line;
      }
      const marker = match[1] ?? "";
      const suffix = match[2] ?? "";
      const nextLevel = Math.min(6, Math.max(3, marker.length + 1));
      return `${"#".repeat(nextLevel)}${suffix}`;
    })
    .join("\n");
}

function renderProjectGuidance(entries: ProjectGuidanceSource[]): string {
  if (entries.length === 0) return "";
  const sections = entries.map((entry) => {
    const title = basename(entry.filePath).replace(/\.md$/i, "");
    const markdown = demoteProjectGuidanceHeadings(entry.markdown.trim());
    const owner = entry.owner ? `; owner=${entry.owner}` : "";
    return `## Project Guidance: ${title}\n\nMetadata: strength=${entry.strength}; scope=${entry.scope}; convention_kind=${entry.conventionKind}; retirement_sensitivity=${entry.retirementSensitivity}${owner}\n\n${markdown}`;
  });
  return joinMarkdownSections(sections);
}

function renderDefaultSkillGuidance(entries: DefaultSkillGuidanceSource[]): string {
  if (entries.length === 0) return "";
  const sections = entries.map((entry) => {
    const title = basename(entry.filePath).replace(/\.md$/i, "");
    const markdown = demoteProjectGuidanceHeadings(entry.markdown.trim());
    return `## Runtime Skill Guidance: ${title}\n\nMetadata: source=runtime_default; kind=authored_behavior\n\n${markdown}`;
  });
  return joinMarkdownSections(sections);
}

function cloneLoadReport(report: SkillRegistryLoadReport): SkillRegistryLoadReport {
  return {
    roots: report.roots.map(cloneSkillRegistryRoot),
    loadedSkills: [...report.loadedSkills],
    selectableSkills: [...report.selectableSkills],
    overlaySkills: [...report.overlaySkills],
    projectGuidance: cloneProjectGuidanceEntries(report.projectGuidance),
    categories: Object.fromEntries(
      Object.entries(report.categories).map(([key, value]) => [key, [...(value ?? [])]]),
    ) as SkillRegistryLoadReport["categories"],
  };
}

export interface SkillRegistryOptions {
  workspaceRoot: string;
  config: BrewvaConfig;
  roots?: SkillRegistryRoot[];
}

export class SkillRegistry {
  private readonly workspaceRoot: string;
  private readonly config: BrewvaConfig;
  private readonly rootsOverride?: SkillRegistryRoot[];
  private loadedRoots: SkillRegistryRoot[] = [];
  private lastLoadReport: SkillRegistryLoadReport = {
    roots: [],
    loadedSkills: [],
    selectableSkills: [],
    overlaySkills: [],
    projectGuidance: [],
    categories: {},
  };
  private skills = new Map<string, SkillDocument>();
  private producers = new Map<string, ProducerContract>();
  private projectGuidanceEntries: ProjectGuidanceSource[] = [];
  private defaultSkillGuidanceEntries: DefaultSkillGuidanceSource[] = [];
  private skillOrigins = new Map<string, LoadedSkillOrigin>();
  private baseMarkdownBySkill = new Map<string, string>();
  private overlayMarkdownsBySkill = new Map<string, string[]>();

  constructor(options: SkillRegistryOptions) {
    this.workspaceRoot = options.workspaceRoot;
    this.config = options.config;
    this.rootsOverride = options.roots;
  }

  load(): void {
    this.skills.clear();
    this.producers.clear();
    this.projectGuidanceEntries = [];
    this.defaultSkillGuidanceEntries = [];
    this.skillOrigins.clear();
    this.baseMarkdownBySkill.clear();
    this.overlayMarkdownsBySkill.clear();

    const discoveredRoots =
      this.rootsOverride ??
      discoverSkillRegistryRoots({
        cwd: this.workspaceRoot,
        configuredRoots: this.config.skills.roots ?? [],
      });
    this.loadedRoots = discoveredRoots.map(cloneSkillRegistryRoot);

    for (const root of discoveredRoots) {
      this.loadRoot(root);
      this.loadProducers(root);
    }

    for (const disabled of this.config.skills.disabled) {
      this.skills.delete(disabled);
    }

    this.defaultSkillGuidanceEntries = this.loadDefaultSkillGuidance();
    this.applyInheritedGuidance();
    this.lastLoadReport = this.buildLoadReport();
  }

  list(): SkillDocument[] {
    return [...this.skills.values()].toSorted((left, right) => left.name.localeCompare(right.name));
  }

  get(name: string): SkillDocument | undefined {
    return this.skills.get(name);
  }

  listProducers(): ProducerContract[] {
    return [...this.producers.values()].toSorted((left, right) =>
      left.producer.localeCompare(right.producer),
    );
  }

  getProducer(name: string): ProducerContract | undefined {
    return this.producers.get(name);
  }

  getLoadedRoots(): SkillRegistryRoot[] {
    return this.loadedRoots.map(cloneSkillRegistryRoot);
  }

  getLoadReport(): SkillRegistryLoadReport {
    return cloneLoadReport(this.lastLoadReport);
  }

  buildIndex(options: { selectableOnly?: boolean } = {}): SkillsIndexEntry[] {
    return this.list()
      .filter((skill) => !options.selectableOnly || this.isSelectable(skill))
      .map((skill) => {
        const origin = this.skillOrigins.get(skill.name);
        if (!origin) {
          throw new Error(`[skill_registry] missing load origin for skill '${skill.name}'.`);
        }

        return {
          name: skill.name,
          category: skill.category,
          description: skill.description,
          filePath: skill.filePath,
          baseDir: skill.baseDir,
          selectable: this.isSelectable(skill),
          overlay: skill.overlayFiles.length > 0,
          projectGuidance: cloneProjectGuidanceEntries(skill.projectGuidance),
          selection: skill.card.selection
            ? {
                ...(skill.card.selection.whenToUse
                  ? { whenToUse: skill.card.selection.whenToUse }
                  : {}),
                ...(skill.card.selection.triggers
                  ? { triggers: [...skill.card.selection.triggers] }
                  : {}),
                ...(skill.card.selection.pathGlobs
                  ? { pathGlobs: [...skill.card.selection.pathGlobs] }
                  : {}),
              }
            : undefined,
          source: origin.base.source,
          rootDir: origin.base.rootDir,
          overlayOrigins: origin.overlays.length > 0 ? [...origin.overlays] : undefined,
        };
      });
  }

  writeIndex(
    filePath = join(resolveProjectBrewvaRootDir(this.workspaceRoot), "skills_index.json"),
  ): string {
    const parent = dirname(filePath);
    if (parent && !existsSync(parent)) {
      mkdirSync(parent, { recursive: true });
    }
    const indexEntries = this.buildIndex();
    const payload: SkillsIndexFile = {
      schemaVersion: 3,
      generatedAt: formatISO(Date.now()),
      roots: this.getLoadedRoots(),
      summary: {
        loadedSkills: indexEntries.length,
        selectableSkills: indexEntries.filter((skill) => skill.selectable).length,
        overlaySkills: indexEntries.filter((skill) => skill.overlay).length,
      },
      skills: indexEntries,
    };
    writeFileSync(filePath, JSON.stringify(payload, null, 2), "utf8");
    return filePath;
  }

  private isSelectable(skill: SkillDocument): boolean {
    return skill.category !== "internal";
  }

  private buildLoadReport(): SkillRegistryLoadReport {
    const categories: SkillRegistryLoadReport["categories"] = {};
    const loadedSkills: string[] = [];
    const selectableSkills: string[] = [];
    const overlaySkills: string[] = [];

    for (const skill of this.list()) {
      loadedSkills.push(skill.name);
      const categoryBucket = categories[skill.category] ?? [];
      categoryBucket.push(skill.name);
      categories[skill.category] = categoryBucket;
      if (this.isSelectable(skill)) selectableSkills.push(skill.name);
      if (skill.overlayFiles.length > 0) {
        overlaySkills.push(skill.name);
      }
    }

    for (const category of Object.keys(categories) as LoadableSkillCategory[]) {
      categories[category] = [...new Set(categories[category] ?? [])].toSorted((a, b) =>
        a.localeCompare(b),
      );
    }

    return {
      roots: this.getLoadedRoots(),
      loadedSkills: [...new Set(loadedSkills)].toSorted((a, b) => a.localeCompare(b)),
      selectableSkills: [...new Set(selectableSkills)].toSorted((a, b) => a.localeCompare(b)),
      overlaySkills: [...new Set(overlaySkills)].toSorted((a, b) => a.localeCompare(b)),
      projectGuidance: uniqueProjectGuidanceEntries(this.projectGuidanceEntries),
      categories,
    };
  }

  private loadRoot(root: SkillRegistryRoot): void {
    const { skillDir } = root;
    for (const category of LOADABLE_SKILL_CATEGORIES) {
      this.loadCategory(category, join(skillDir, category), root);
    }

    const projectGuidanceEntries = this.loadProjectGuidance(join(skillDir, "project", "shared"));
    if (projectGuidanceEntries.length > 0) {
      this.projectGuidanceEntries.push(...projectGuidanceEntries);
    }
    this.loadOverlays(join(skillDir, "project", "overlays"), root);
  }

  private loadProducers(root: SkillRegistryRoot): void {
    for (const filePath of listProducerFiles(join(root.skillDir, "producers"))) {
      const parsed = parseProducerContractFile(filePath, root);
      const existing = this.producers.get(parsed.producer);
      if (existing) {
        throw new Error(
          `[producer_registry] ${filePath}: duplicate producer '${parsed.producer}' conflicts with '${existing.filePath}'.`,
        );
      }
      this.producers.set(parsed.producer, parsed);
    }
  }

  private loadCategory(
    category: LoadableSkillCategory,
    dir: string,
    root: SkillRegistryRoot,
  ): void {
    const files = listSkillFiles(dir);
    for (const filePath of files) {
      const parsed = parseSkillDocument(filePath, category);
      const resolvedResources = resolveSkillResources(parsed.resources, {
        baseDir: parsed.baseDir,
        skillDir: root.skillDir,
      });
      const existing = this.skills.get(parsed.name);
      if (existing) {
        throw new Error(
          `[skill_registry] ${filePath}: duplicate skill name '${parsed.name}' conflicts with '${existing.filePath}'. Skill names must be globally unique across loaded roots and categories; use a project overlay for same-name specialization.`,
        );
      }
      this.skills.set(parsed.name, {
        ...parsed,
        resources: resolvedResources,
        authoredResources: resolvedResources,
        inheritedResources: createEmptySkillResources(),
      });
      this.baseMarkdownBySkill.set(parsed.name, parsed.markdown);
      this.overlayMarkdownsBySkill.set(parsed.name, []);
      this.skillOrigins.set(parsed.name, {
        base: {
          filePath: parsed.filePath,
          source: root.source,
          rootDir: root.rootDir,
        },
        overlays: [],
      });
    }
  }

  private loadProjectGuidance(dir: string): ProjectGuidanceSource[] {
    return listMarkdownFiles(dir).map((filePath) => parseProjectGuidanceFile(filePath));
  }

  private loadDefaultSkillGuidance(): DefaultSkillGuidanceSource[] {
    const skillAuthoring = this.skills.get("skill-authoring");
    if (!skillAuthoring) {
      return [];
    }
    const authoredBehaviorPath = join(skillAuthoring.baseDir, "references", "authored-behavior.md");
    if (!existsSync(authoredBehaviorPath)) {
      return [];
    }
    return [
      {
        filePath: authoredBehaviorPath,
        markdown: readFileSync(authoredBehaviorPath, "utf8"),
      },
    ];
  }

  private loadOverlays(dir: string, root: SkillRegistryRoot): void {
    const overlayFiles = listSkillFiles(dir);
    for (const filePath of overlayFiles) {
      const overlay = parseSkillDocument(filePath, "overlay");
      const resolvedOverlayResources = resolveSkillResources(overlay.resources, {
        baseDir: overlay.baseDir,
        skillDir: root.skillDir,
      });
      const baseSkill = this.skills.get(overlay.name);
      if (!baseSkill) {
        throw new Error(
          `[skill_overlay] ${filePath}: overlay target '${overlay.name}' was not loaded before overlay application.`,
        );
      }
      const origin = this.skillOrigins.get(overlay.name);
      if (!origin) {
        throw new Error(
          `[skill_registry] missing load origin for overlay target '${overlay.name}'.`,
        );
      }

      const baseMarkdown = this.baseMarkdownBySkill.get(overlay.name) ?? baseSkill.markdown;
      const overlayMarkdowns = this.overlayMarkdownsBySkill.get(overlay.name) ?? [];
      overlayMarkdowns.push(overlay.markdown);
      this.overlayMarkdownsBySkill.set(overlay.name, overlayMarkdowns);

      const authoredMarkdown = joinMarkdownSections([baseMarkdown, ...overlayMarkdowns]);
      const authoredResources = mergeSkillResources(
        baseSkill.authoredResources,
        resolvedOverlayResources,
      );
      const mergedResources = mergeSkillResources(authoredResources, baseSkill.inheritedResources);

      this.skills.set(overlay.name, {
        ...baseSkill,
        markdown: joinMarkdownSections([baseSkill.inheritedMarkdown, authoredMarkdown]),
        authoredMarkdown,
        card: mergeOverlayCard(baseSkill.card, overlay.card),
        resources: mergedResources,
        authoredResources,
        overlayFiles: [...new Set([...baseSkill.overlayFiles, filePath])],
      });
      origin.overlays.push({
        filePath,
        source: root.source,
        rootDir: root.rootDir,
      });
    }
  }

  private applyInheritedGuidance(): void {
    if (this.projectGuidanceEntries.length === 0 && this.defaultSkillGuidanceEntries.length === 0) {
      return;
    }
    const projectGuidanceMarkdown = renderProjectGuidance(this.projectGuidanceEntries);
    const defaultSkillGuidanceMarkdown = renderDefaultSkillGuidance(
      this.defaultSkillGuidanceEntries,
    );
    const projectGuidanceResources = {
      ...createEmptySkillResources(),
      references: this.projectGuidanceEntries.map((entry) => entry.filePath),
    };
    const defaultSkillGuidanceResources = {
      ...createEmptySkillResources(),
      references: this.defaultSkillGuidanceEntries.map((entry) => entry.filePath),
    };
    const inheritedMarkdown = joinMarkdownSections([
      projectGuidanceMarkdown,
      defaultSkillGuidanceMarkdown,
    ]);
    const inheritedResources = mergeSkillResources(
      projectGuidanceResources,
      defaultSkillGuidanceResources,
    );
    const projectGuidance = uniqueProjectGuidanceEntries(this.projectGuidanceEntries);

    for (const [name, skill] of this.skills.entries()) {
      const baseMarkdown = this.baseMarkdownBySkill.get(name) ?? skill.markdown;
      const overlayMarkdowns = this.overlayMarkdownsBySkill.get(name) ?? [];
      const authoredMarkdown = joinMarkdownSections([baseMarkdown, ...overlayMarkdowns]);
      const combinedInheritedResources = mergeSkillResources(
        skill.inheritedResources,
        inheritedResources,
      );
      this.skills.set(name, {
        ...skill,
        markdown: joinMarkdownSections([inheritedMarkdown, authoredMarkdown]),
        authoredMarkdown,
        inheritedMarkdown,
        resources: mergeSkillResources(skill.authoredResources, combinedInheritedResources),
        inheritedResources: combinedInheritedResources,
        projectGuidance,
      });
    }
  }
}
