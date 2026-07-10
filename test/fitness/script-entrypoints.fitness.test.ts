import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "../..");
const ROOT_SCRIPT_REFERENCE_PATTERN =
  /(?:^|[\s"'`(=])(?:\.\/)?(script\/[^\s"'`&|;]+?\.(?:ts|sh))/gu;
const ROOT_SCRIPT_FILE_PATTERN = /\.(?:ts|sh)$/u;

const SUPPORT_SCRIPT_FILES = new Set([
  "script/promotion-gates.ts",
  "script/provider-model-catalog.ts",
  "script/test-policy/model.ts",
  "script/test-policy/rules.ts",
  "script/test-policy/scan.ts",
]);

function readRepoFile(relativePath: string): string {
  return readFileSync(resolve(repoRoot, relativePath), "utf8");
}

function listFiles(relativeDir: string): string[] {
  const absoluteDir = resolve(repoRoot, relativeDir);
  const files: string[] = [];

  for (const entry of readdirSync(absoluteDir)) {
    if (entry.endsWith(".tsbuildinfo")) continue;
    const absolutePath = resolve(absoluteDir, entry);
    const repoPath = `${relativeDir}/${entry}`;
    const stats = statSync(absolutePath);
    if (stats.isDirectory()) {
      files.push(...listFiles(repoPath));
      continue;
    }
    if (stats.isFile()) {
      files.push(repoPath);
    }
  }

  return files.toSorted((left, right) => left.localeCompare(right));
}

function collectPackageScriptReferences(scripts: Record<string, string>): Set<string> {
  const references = new Set<string>();

  for (const command of Object.values(scripts)) {
    for (const match of command.matchAll(ROOT_SCRIPT_REFERENCE_PATTERN)) {
      const reference = match[1];
      if (reference) {
        references.add(reference);
      }
    }
  }

  return references;
}

describe("root script entrypoints", () => {
  test("keeps package script references inside the canonical script directory", () => {
    const packageJson = JSON.parse(readRepoFile("package.json")) as {
      scripts?: Record<string, string>;
    };
    const scripts = packageJson.scripts ?? {};
    const commands = Object.values(scripts).join("\n");

    expect(existsSync(resolve(repoRoot, "scripts"))).toBe(false);
    expect(commands).not.toContain("scripts/");

    for (const reference of collectPackageScriptReferences(scripts)) {
      expect(existsSync(resolve(repoRoot, reference)), `${reference} must exist`).toBe(true);
    }
  });

  test("keeps script files either package-addressable or explicitly support-only", () => {
    const packageJson = JSON.parse(readRepoFile("package.json")) as {
      scripts?: Record<string, string>;
    };
    const referenced = collectPackageScriptReferences(packageJson.scripts ?? {});
    const scriptFiles = listFiles("script").filter((file) => ROOT_SCRIPT_FILE_PATTERN.test(file));

    const orphaned = scriptFiles.filter(
      (file) => !referenced.has(file) && !SUPPORT_SCRIPT_FILES.has(file),
    );

    expect(orphaned).toEqual([]);
  });
});
