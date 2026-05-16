import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

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
  producerOutputs: string[];
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
        if (entry.name === "producers") continue;
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
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/u.exec(raw);
  if (!match) {
    throw new Error(`${filePath}: missing YAML frontmatter.`);
  }
  const parsed = parseYaml(match[1] ?? "");
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${filePath}: frontmatter must be an object.`);
  }
  return {
    filePath,
    data: parsed as Record<string, unknown>,
    body: match[2] ?? "",
  };
}

function readOutputNames(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const outputs = (value as Record<string, unknown>).outputs;
  if (!Array.isArray(outputs)) return [];
  return outputs.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
}

function isMetaSkill(skillDir: string, filePath: string): boolean {
  return relative(skillDir, filePath).replaceAll("\\", "/").startsWith("meta/");
}

function isProjectOverlay(skillDir: string, filePath: string): boolean {
  return relative(skillDir, filePath).replaceAll("\\", "/").startsWith("project/overlays/");
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
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const selection = { ...(value as Record<string, unknown>) };
  if (selection.paths !== undefined && selection.path_globs === undefined) {
    selection.path_globs = selection.paths;
    delete selection.paths;
  }
  return selection;
}

function buildProducerContract(parsed: ParsedSkillFile): Record<string, unknown> | undefined {
  const name =
    typeof parsed.data.name === "string" ? parsed.data.name.trim() : basename(parsed.filePath);
  if (!name) return undefined;
  const intent = parsed.data.intent;
  if (!intent || typeof intent !== "object" || Array.isArray(intent)) return undefined;
  const intentRecord = intent as Record<string, unknown>;
  const outputs = readOutputNames(intent);
  if (outputs.length === 0) return undefined;
  const producer: Record<string, unknown> = {
    producer: name,
    outputs,
  };
  if (
    intentRecord.output_contracts &&
    typeof intentRecord.output_contracts === "object" &&
    !Array.isArray(intentRecord.output_contracts)
  ) {
    producer.output_contracts = intentRecord.output_contracts;
  }
  if (
    intentRecord.semantic_bindings &&
    typeof intentRecord.semantic_bindings === "object" &&
    !Array.isArray(intentRecord.semantic_bindings)
  ) {
    producer.semantic_bindings = intentRecord.semantic_bindings;
  }
  return producer;
}

function collectIssues(skillDir: string): MigrationIssue[] {
  return walkSkillFiles(skillDir).map((filePath) => {
    const parsed = parseSkillFile(filePath);
    return {
      filePath,
      removedFields: Object.keys(parsed.data).filter((key) => REMOVED_SKILL_CARD_KEYS.has(key)),
      producerOutputs: isProjectOverlay(skillDir, filePath)
        ? []
        : readOutputNames(parsed.data.intent),
    };
  });
}

function writeMigration(skillDir: string): MigrationIssue[] {
  const issues = collectIssues(skillDir);
  const producerDir = join(skillDir, "producers");
  mkdirSync(producerDir, { recursive: true });

  for (const filePath of walkSkillFiles(skillDir)) {
    const parsed = parseSkillFile(filePath);
    const producer = isProjectOverlay(skillDir, filePath)
      ? undefined
      : buildProducerContract(parsed);
    if (producer) {
      writeFileSync(
        join(producerDir, `${String(producer.producer)}.yaml`),
        stringifyYaml(producer, { lineWidth: 100 }),
        "utf8",
      );
    }

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
  const impacted = issues.filter(
    (issue) => issue.removedFields.length > 0 || issue.producerOutputs.length > 0,
  );
  console.log(
    `skills migrate ${mode}: ${impacted.length} file(s) with removed fields or producer outputs`,
  );
  for (const issue of impacted) {
    const parts = [
      issue.removedFields.length > 0
        ? `removed_fields=${issue.removedFields.join(",")}`
        : undefined,
      issue.producerOutputs.length > 0
        ? `producer_outputs=${issue.producerOutputs.join(",")}`
        : undefined,
    ].filter((entry): entry is string => Boolean(entry));
    console.log(`${issue.filePath}: ${parts.join(" ")}`);
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
