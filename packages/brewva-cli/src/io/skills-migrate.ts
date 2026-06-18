import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { parseMarkdownFrontmatter } from "@brewva/brewva-std/markdown";
import { isRecord } from "@brewva/brewva-std/unknown";
import { stringify as stringifyYaml } from "yaml";

const REMOVED_SKILL_CARD_KEYS = new Set([
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
]);

const SKILL_CARD_KEYS = ["name", "description", "selection", "references", "scripts", "invariants"];
const SKILL_CATEGORY_DIRS = ["core", "domain", "operator", "meta", "internal", "project"];

interface MigrationIssue {
  filePath: string;
  removedFields: string[];
}

interface ParsedSkillFile {
  filePath: string;
  data: Record<string, unknown>;
  body: string;
}

interface SkillsMigrateOptions {
  mode: "check" | "write";
  root: string;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function findSkillDir(root: string): string {
  const resolved = resolve(root);
  const nested = join(resolved, "skills");
  if (SKILL_CATEGORY_DIRS.some((entry) => isDirectory(join(resolved, entry)))) {
    return resolved;
  }
  if (SKILL_CATEGORY_DIRS.some((entry) => isDirectory(join(nested, entry)))) {
    return nested;
  }
  return resolved;
}

function walkSkillFiles(root: string): string[] {
  if (!isDirectory(root)) return [];
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (entry.isFile() && entry.name === "SKILL.md") {
        out.push(full);
      }
    }
  };
  walk(root);
  return out.toSorted((left, right) => left.localeCompare(right));
}

function parseSkillFile(filePath: string): ParsedSkillFile {
  const raw = readFileSync(filePath, "utf8");
  const parsed = parseMarkdownFrontmatter(raw);
  if (!parsed.hasFrontmatter) {
    throw new Error(`${filePath}: missing YAML frontmatter.`);
  }
  return {
    filePath,
    data: parsed.data,
    body: parsed.body,
  };
}

function isMetaSkill(skillDir: string, filePath: string): boolean {
  return relative(skillDir, filePath).replaceAll("\\", "/").startsWith("meta/");
}

function buildSkillCardFrontmatter(
  skillDir: string,
  parsed: ParsedSkillFile,
): Record<string, unknown> {
  const next: Record<string, unknown> = {};
  for (const key of SKILL_CARD_KEYS) {
    if (!Object.hasOwn(parsed.data, key)) continue;
    if (key === "selection" && isMetaSkill(skillDir, parsed.filePath)) continue;
    next[key] = key === "selection" ? normalizeSelection(parsed.data[key]) : parsed.data[key];
  }
  return next;
}

function normalizeSelection(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const selection = { ...value };
  if (selection.paths !== undefined && selection.path_globs === undefined) {
    selection.path_globs = selection.paths;
    delete selection.paths;
  }
  return selection;
}

function collectIssues(skillDir: string): MigrationIssue[] {
  return walkSkillFiles(skillDir).map((filePath) => {
    const parsed = parseSkillFile(filePath);
    return {
      filePath,
      removedFields: Object.keys(parsed.data).filter((key) => REMOVED_SKILL_CARD_KEYS.has(key)),
    };
  });
}

function writeMigration(skillDir: string): MigrationIssue[] {
  const issues = collectIssues(skillDir);

  for (const filePath of walkSkillFiles(skillDir)) {
    const parsed = parseSkillFile(filePath);
    const card = buildSkillCardFrontmatter(skillDir, parsed);
    writeFileSync(
      filePath,
      `---\n${stringifyYaml(card, { lineWidth: 100 }).trimEnd()}\n---\n${parsed.body}`,
      "utf8",
    );
  }

  return issues;
}

function printIssues(issues: readonly MigrationIssue[], mode: "check" | "write"): void {
  const impacted = issues.filter((issue) => issue.removedFields.length > 0);
  console.log(`skills migrate ${mode}: ${impacted.length} file(s) with removed fields`);
  for (const issue of impacted) {
    console.log(`${issue.filePath}: removed_fields=${issue.removedFields.join(",")}`);
  }
}

function parseSkillsMigrateArgs(argv: string[]): SkillsMigrateOptions | undefined {
  let mode: "check" | "write" | undefined;
  let root = process.cwd();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--check") {
      mode = mode === undefined ? "check" : undefined;
      continue;
    }
    if (token === "--write") {
      mode = mode === undefined ? "write" : undefined;
      continue;
    }
    if (token === "--root") {
      const value = argv[index + 1];
      if (!value) return undefined;
      root = value;
      index += 1;
      continue;
    }
    return undefined;
  }
  if (!mode) return undefined;
  return { mode, root };
}

export async function runSkillsMigrateCli(argv: string[]): Promise<number> {
  if (argv[0] !== "migrate") {
    console.error("Usage: brewva skills migrate --check|--write [--root <path>]");
    return 1;
  }
  const options = parseSkillsMigrateArgs(argv.slice(1));
  if (!options) {
    console.error("Usage: brewva skills migrate --check|--write [--root <path>]");
    return 1;
  }
  const skillDir = findSkillDir(options.root);
  if (!existsSync(skillDir)) {
    console.error(`Error: skill root not found: ${skillDir}`);
    return 1;
  }
  const issues = options.mode === "check" ? collectIssues(skillDir) : writeMigration(skillDir);
  printIssues(issues, options.mode);
  return 0;
}
