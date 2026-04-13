import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { parseMarkdownFrontmatter } from "./markdown-frontmatter.js";
import type { BrewvaHostedSkill, BrewvaHostedSkillLoadResult } from "./resource-loader.js";

const BREWVA_CONFIG_DIR_RELATIVE = ".brewva";
const BREWVA_CONFIG_FILE_NAME = "brewva.json";
const LOADABLE_SKILL_CATEGORIES = ["core", "domain", "operator", "meta", "internal", "project"];

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

function hasSkillDocuments(rootDir: string): boolean {
  if (!isDirectory(rootDir)) {
    return false;
  }
  const stack = [resolve(rootDir)];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }
    let entries: Array<import("node:fs").Dirent>;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (entry.isFile() && entry.name === "SKILL.md") {
        return true;
      }
    }
  }
  return false;
}

function resolveSkillDirectory(rootDir: string): string | undefined {
  const normalizedRoot = resolve(rootDir);
  const direct = normalizedRoot;
  const nested = join(normalizedRoot, "skills");
  if (hasSkillCategoryDirectories(direct) || hasSkillDocuments(direct)) return direct;
  if (hasSkillCategoryDirectories(nested) || hasSkillDocuments(nested)) return nested;
  return undefined;
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

function walkFiles(rootDir: string, predicate: (path: string) => boolean): string[] {
  if (!isDirectory(rootDir)) return [];
  const resolvedRoot = resolve(rootDir);
  const out: string[] = [];

  const walk = (dir: string): void => {
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
        walk(full);
        continue;
      }
      if (isFile && predicate(full)) {
        out.push(full);
      }
    }
  };

  walk(resolvedRoot);
  return out.toSorted((left, right) => left.localeCompare(right));
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

function appendSkillRoot(roots: string[], seen: Set<string>, rootDir: string): void {
  const skillDir = resolveSkillDirectory(rootDir);
  if (!skillDir) return;
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

  appendSkillRoot(roots, seenRoots, join(globalRoot, "skills", ".system"));
  appendSkillRoot(roots, seenRoots, globalRoot);
  appendSkillRoot(roots, seenRoots, projectRoot);
  for (const root of [...globalConfig.roots, ...projectConfig.roots]) {
    appendSkillRoot(roots, seenRoots, root);
  }

  const disabled = new Set<string>([
    ...globalConfig.disabled.values(),
    ...projectConfig.disabled.values(),
  ]);
  const skillsByName = new Map<string, BrewvaHostedSkill>();
  const diagnostics = [...globalConfig.diagnostics, ...projectConfig.diagnostics];

  for (const root of roots) {
    for (const filePath of walkFiles(root, (candidate) => basename(candidate) === "SKILL.md")) {
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
