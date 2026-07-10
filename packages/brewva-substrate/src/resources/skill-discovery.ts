import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { parseMarkdownFrontmatter } from "@brewva/brewva-std/markdown";
import type { BrewvaHostedSkill, BrewvaHostedSkillLoadResult } from "./resource-loader.js";

const BREWVA_CONFIG_DIR_RELATIVE = ".brewva";
const BREWVA_CONFIG_FILE_NAME = "brewva.json";
const LOADABLE_SKILL_CATEGORIES = ["core", "domain", "operator", "meta", "internal", "project"];
// Discovery walks must stay bounded even when a caller hands over an
// accidental root (a workspace parent, a shared temp dir): dependency trees
// are never skill roots, and legitimate skill layouts are shallow and small.
// Depth alone cannot bound wide trees, so the directory and entry budgets
// carry the wall-time bound; exhausting any of them surfaces as a
// truncation diagnostic instead of silently dropping skills.
const MAX_SKILL_DISCOVERY_DEPTH = 8;
const MAX_SKILL_DISCOVERY_DIRECTORIES = 1024;
const MAX_SKILL_DISCOVERY_ENTRIES = 10_000;
const SKILL_DISCOVERY_TRUNCATED_MESSAGE = "skill_discovery_truncated: walk budget exceeded";
const IGNORED_SKILL_DISCOVERY_DIRECTORIES = new Set(["node_modules", ".git"]);

function shouldSkipDiscoveryEntry(name: string): boolean {
  return name.startsWith(".") || IGNORED_SKILL_DISCOVERY_DIRECTORIES.has(name);
}

interface SkillDiscoveryConfig {
  roots: string[];
  disabled: Set<string>;
  diagnostics: Array<{ path: string; message: string }>;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function hasSkillCategoryDirectories(skillDir: string): boolean {
  return LOADABLE_SKILL_CATEGORIES.some((category) => isDirectory(join(skillDir, category)));
}

function hasSkillDocuments(rootDir: string): { found: boolean; truncated: boolean } {
  if (!isDirectory(rootDir)) {
    return { found: false, truncated: false };
  }
  const stack: Array<{ dir: string; depth: number }> = [{ dir: resolve(rootDir), depth: 0 }];
  let remainingDirectories = MAX_SKILL_DISCOVERY_DIRECTORIES;
  let remainingEntries = MAX_SKILL_DISCOVERY_ENTRIES;
  let truncated = false;
  while (stack.length > 0) {
    if (remainingDirectories <= 0) {
      truncated = true;
      break;
    }
    remainingDirectories -= 1;
    const current = stack.pop();
    if (!current) {
      continue;
    }
    let entries: Array<import("node:fs").Dirent>;
    try {
      entries = readdirSync(current.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    // Already-read entries are still scanned for SKILL.md; the exhausted
    // budget only stops further descent.
    remainingEntries -= entries.length;
    for (const entry of entries) {
      if (shouldSkipDiscoveryEntry(entry.name)) continue;
      const full = join(current.dir, entry.name);
      if (entry.isDirectory()) {
        if (remainingEntries >= 0 && current.depth < MAX_SKILL_DISCOVERY_DEPTH) {
          stack.push({ dir: full, depth: current.depth + 1 });
        } else {
          truncated = true;
        }
        continue;
      }
      if (entry.isFile() && entry.name === "SKILL.md") {
        return { found: true, truncated };
      }
    }
  }
  return { found: false, truncated };
}

function resolveSkillDirectory(rootDir: string): {
  skillDir: string | undefined;
  truncated: boolean;
} {
  const normalizedRoot = resolve(rootDir);
  const direct = normalizedRoot;
  const nested = join(normalizedRoot, "skills");
  const directDocuments = hasSkillCategoryDirectories(direct)
    ? { found: true, truncated: false }
    : hasSkillDocuments(direct);
  if (directDocuments.found) return { skillDir: direct, truncated: false };
  const nestedDocuments = hasSkillCategoryDirectories(nested)
    ? { found: true, truncated: false }
    : hasSkillDocuments(nested);
  if (nestedDocuments.found) return { skillDir: nested, truncated: false };
  return {
    skillDir: undefined,
    truncated: directDocuments.truncated || nestedDocuments.truncated,
  };
}

function normalizePathInput(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return trimmed;
  if (trimmed === "~") return process.env.HOME ?? trimmed;
  if (trimmed.startsWith("~/")) {
    return join(process.env.HOME ?? "", trimmed.slice(2));
  }
  return trimmed;
}

function resolveMaybeAbsolute(baseDir: string, pathText: string): string {
  const normalized = normalizePathInput(pathText);
  if (isAbsolute(normalized)) {
    return resolve(normalized);
  }
  return resolve(baseDir, normalized);
}

function findAncestor(startDir: string, predicate: (dir: string) => boolean): string | undefined {
  let current = resolve(startDir);
  while (true) {
    if (predicate(current)) return current;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return undefined;
}

function hasBrewvaConfigRoot(dir: string): boolean {
  return existsSync(join(dir, BREWVA_CONFIG_DIR_RELATIVE, BREWVA_CONFIG_FILE_NAME));
}

function hasGitRootMarker(dir: string): boolean {
  return existsSync(join(dir, ".git"));
}

function resolveWorkspaceRootDir(cwd: string): string {
  const resolvedCwd = resolve(cwd);
  return (
    findAncestor(resolvedCwd, (dir) => hasBrewvaConfigRoot(dir) || hasGitRootMarker(dir)) ??
    resolvedCwd
  );
}

function walkFiles(
  rootDir: string,
  predicate: (path: string) => boolean,
): { files: string[]; truncated: boolean } {
  if (!isDirectory(rootDir)) return { files: [], truncated: false };
  const resolvedRoot = resolve(rootDir);
  const out: string[] = [];
  let remainingDirectories = MAX_SKILL_DISCOVERY_DIRECTORIES;
  let remainingEntries = MAX_SKILL_DISCOVERY_ENTRIES;
  let truncated = false;

  const walk = (dir: string, depth: number): void => {
    if (remainingDirectories <= 0 || remainingEntries < 0) {
      truncated = true;
      return;
    }
    remainingDirectories -= 1;
    let entries: Array<import("node:fs").Dirent>;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    // Already-read entries are still matched below; the exhausted budget
    // only stops further descent.
    remainingEntries -= entries.length;

    for (const entry of entries) {
      if (shouldSkipDiscoveryEntry(entry.name)) continue;
      const full = join(dir, entry.name);
      let isDir = entry.isDirectory();
      let isFile = entry.isFile();
      if (entry.isSymbolicLink()) {
        try {
          const real = realpathSync(full);
          if (!(real === resolvedRoot || real.startsWith(`${resolvedRoot}/`))) {
            continue;
          }
          const stats = statSync(real);
          isDir = stats.isDirectory();
          isFile = stats.isFile();
        } catch {
          continue;
        }
      }

      if (isDir) {
        if (depth < MAX_SKILL_DISCOVERY_DEPTH) {
          walk(full, depth + 1);
        } else {
          truncated = true;
        }
        continue;
      }
      if (isFile && predicate(full)) {
        out.push(full);
      }
    }
  };

  walk(resolvedRoot, 0);
  return {
    files: out.toSorted((left, right) => left.localeCompare(right)),
    truncated,
  };
}

function readSkillDiscoveryConfig(rootDir: string, workspaceRoot: string): SkillDiscoveryConfig {
  const configPath = join(rootDir, BREWVA_CONFIG_FILE_NAME);
  if (!existsSync(configPath)) {
    return {
      roots: [],
      disabled: new Set<string>(),
      diagnostics: [],
    };
  }

  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf8")) as {
      skills?: { roots?: unknown; disabled?: unknown };
    } | null;
    const skillRoots = Array.isArray(parsed?.skills?.roots)
      ? parsed.skills.roots.filter(
          (value): value is string => typeof value === "string" && value.trim().length > 0,
        )
      : [];
    const disabled = Array.isArray(parsed?.skills?.disabled)
      ? parsed.skills.disabled.filter(
          (value): value is string => typeof value === "string" && value.trim().length > 0,
        )
      : [];
    return {
      roots: skillRoots.map((root) => resolveMaybeAbsolute(workspaceRoot, root)),
      disabled: new Set(disabled.map((value) => value.trim())),
      diagnostics: [],
    };
  } catch (error) {
    return {
      roots: [],
      disabled: new Set<string>(),
      diagnostics: [
        {
          path: configPath,
          message: error instanceof Error ? error.message : String(error),
        },
      ],
    };
  }
}

function appendSkillRoot(
  roots: string[],
  seen: Set<string>,
  rootDir: string,
  diagnostics: Array<{ path: string; message: string }>,
): void {
  const { skillDir, truncated } = resolveSkillDirectory(rootDir);
  if (!skillDir) {
    // A probe that gave up before finding any SKILL.md must not silently
    // drop the root — the configured skills would just vanish.
    if (truncated) {
      diagnostics.push({ path: resolve(rootDir), message: SKILL_DISCOVERY_TRUNCATED_MESSAGE });
    }
    return;
  }
  const normalized = resolve(skillDir);
  if (seen.has(normalized)) return;
  seen.add(normalized);
  roots.push(normalized);
}

function describeSkill(filePath: string): BrewvaHostedSkill {
  const raw = readFileSync(filePath, "utf8");
  const { data, body } = parseMarkdownFrontmatter(raw);
  const baseDir = dirname(filePath);
  const fallbackName = basename(baseDir) || "unknown";
  const firstBodyLine = body
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  return {
    name:
      typeof data.name === "string" && data.name.trim().length > 0
        ? data.name.trim()
        : fallbackName,
    description:
      typeof data.description === "string" && data.description.trim().length > 0
        ? data.description.trim()
        : (firstBodyLine ?? ""),
    filePath,
    baseDir,
  };
}

export function discoverHostedSkills(input: {
  cwd: string;
  agentDir: string;
}): BrewvaHostedSkillLoadResult {
  const workspaceRoot = resolveWorkspaceRootDir(input.cwd);
  const globalRoot = resolve(input.agentDir, "..");
  const projectRoot = join(workspaceRoot, BREWVA_CONFIG_DIR_RELATIVE);
  const globalConfig = readSkillDiscoveryConfig(globalRoot, workspaceRoot);
  const projectConfig = readSkillDiscoveryConfig(projectRoot, workspaceRoot);
  const roots: string[] = [];
  const seenRoots = new Set<string>();
  const diagnostics = [...globalConfig.diagnostics, ...projectConfig.diagnostics];

  appendSkillRoot(roots, seenRoots, join(globalRoot, "skills", ".system"), diagnostics);
  appendSkillRoot(roots, seenRoots, globalRoot, diagnostics);
  appendSkillRoot(roots, seenRoots, projectRoot, diagnostics);
  for (const root of [...globalConfig.roots, ...projectConfig.roots]) {
    appendSkillRoot(roots, seenRoots, root, diagnostics);
  }

  const disabled = new Set<string>([
    ...globalConfig.disabled.values(),
    ...projectConfig.disabled.values(),
  ]);
  const skillsByName = new Map<string, BrewvaHostedSkill>();

  for (const root of roots) {
    const walked = walkFiles(root, (candidate) => basename(candidate) === "SKILL.md");
    if (walked.truncated) {
      diagnostics.push({ path: root, message: SKILL_DISCOVERY_TRUNCATED_MESSAGE });
    }
    for (const filePath of walked.files) {
      try {
        const skill = describeSkill(filePath);
        if (disabled.has(skill.name)) {
          continue;
        }
        skillsByName.set(skill.name, skill);
      } catch (error) {
        diagnostics.push({
          path: filePath,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  return {
    skills: [...skillsByName.values()].toSorted((left, right) =>
      left.name.localeCompare(right.name),
    ),
    diagnostics,
  };
}
