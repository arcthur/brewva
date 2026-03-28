import { describe, expect, it } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "../..");
const unitRoot = resolve(repoRoot, "test/unit");

const ALLOWED_GLOBAL_MUTATION_FILES = new Set(["test/unit/helpers/test-isolation.unit.test.ts"]);

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
  {
    name: "host child-process spawn",
    regex: /\b(?:spawn|spawnSync|execFile|execSync)\s*\(/g,
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

describe("unit test hermeticity guard", () => {
  it("keeps unit tests free of direct global mutation and host process execution", () => {
    const offenders: string[] = [];

    for (const absolutePath of walkFiles(unitRoot)) {
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
