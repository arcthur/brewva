import { describe, expect, it } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "../..");
const testRoot = resolve(repoRoot, "test");

const ALLOWED_GLOBAL_MUTATION_FILES = new Set([
  "test/helpers/global-state.ts",
  "test/setup-env.ts",
  "test/unit/helpers/test-isolation.unit.test.ts",
]);

const FORBIDDEN_PATTERNS: Array<{ name: string; regex: RegExp }> = [
  {
    name: "direct Date.now reassignment",
    regex: /\bDate\.now\s*=(?!=)/g,
  },
  {
    name: "direct process.env assignment",
    regex: /\bprocess\.env(?:\[[^\]]+\]|\.[A-Za-z0-9_]+)\s*=(?!=)/g,
  },
  {
    name: "direct process.env deletion",
    regex: /\bdelete\s+process\.env(?:\[[^\]]+\]|\.[A-Za-z0-9_]+)/g,
  },
];

function walkFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory)) {
    const absolutePath = join(directory, entry);
    const stats = statSync(absolutePath);
    if (stats.isDirectory()) {
      files.push(...walkFiles(absolutePath));
      continue;
    }
    if (absolutePath.endsWith(".ts")) {
      files.push(absolutePath);
    }
  }
  return files;
}

describe("test global mutation guard", () => {
  it("keeps direct Date.now and process.env rewrites behind shared test helpers", () => {
    const offenders: string[] = [];

    for (const absolutePath of walkFiles(testRoot)) {
      const relativePath = relative(repoRoot, absolutePath);
      if (ALLOWED_GLOBAL_MUTATION_FILES.has(relativePath)) {
        continue;
      }

      const source = readFileSync(absolutePath, "utf-8");
      for (const pattern of FORBIDDEN_PATTERNS) {
        if (pattern.regex.test(source)) {
          offenders.push(`${relativePath}: ${pattern.name}`);
        }
        pattern.regex.lastIndex = 0;
      }
    }

    expect(offenders).toEqual([]);
  });
});
