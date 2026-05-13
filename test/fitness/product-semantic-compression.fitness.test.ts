import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "../..");
const currentFile = relative(repoRoot, import.meta.path);
const SCAN_ROOTS = ["packages", "docs", "test"] as const;
const ALLOWED_DOC_PREFIXES = ["docs/research/"] as const;
const ALLOWED_FILES = new Set([currentFile]);

const BANNED_NEEDLES = [
  ["runtime task spine namespace", ["runtime", "task_spine"].join(".")],
  ["runtime evidence namespace", ["runtime", "evidence"].join(".")],
  [
    "linear product primitive stage machine",
    ["Task", "Skill", "Search", "Evidence", "Finish"].join(" -> "),
  ],
  ["old skill policy block", ["[Brewva Skill", "Recommendation]"].join(" ")],
  ["old skill diagnosis event", ["skill", "recommendation", "derived"].join("_")],
  ["old recall source tier field", ["source", "Tier"].join("")],
  ["old recall source tier render field", ["source", "tier"].join("_")],
  ["old recall source tier type", ["Recall", "Source", "Tier"].join("")],
  ["old tool-surface candidate field", ["recommended", "Skill", "Names"].join("")],
] as const;

function listFiles(relativeDir: string): string[] {
  const absoluteDir = resolve(repoRoot, relativeDir);
  const files: string[] = [];
  for (const entry of readdirSync(absoluteDir)) {
    if (entry === "node_modules" || entry === ".git" || entry === "dist") continue;
    const absolutePath = join(absoluteDir, entry);
    const relativePath = relative(repoRoot, absolutePath);
    const stats = statSync(absolutePath);
    if (stats.isDirectory()) {
      files.push(...listFiles(relativePath));
      continue;
    }
    if (!stats.isFile()) continue;
    if (/\.(ts|tsx|md|json|jsonc)$/u.test(entry)) {
      files.push(relativePath);
    }
  }
  return files;
}

function shouldScan(relativePath: string): boolean {
  if (ALLOWED_FILES.has(relativePath)) return false;
  if (ALLOWED_DOC_PREFIXES.some((prefix) => relativePath.startsWith(prefix))) return false;
  return true;
}

describe("product semantic compression guardrails", () => {
  test("does not reintroduce duplicated product primitives or retired default-path terms", () => {
    const violations: string[] = [];
    const files = SCAN_ROOTS.flatMap((root) => listFiles(root)).filter(shouldScan);

    for (const filePath of files) {
      const content = readFileSync(resolve(repoRoot, filePath), "utf-8");
      for (const [label, needle] of BANNED_NEEDLES) {
        if (content.includes(needle)) {
          violations.push(`${filePath}: ${label}`);
        }
      }
    }

    expect(
      violations,
      `Semantic compression guardrail violations:\n${violations.join("\n")}`,
    ).toEqual([]);
  });
});
