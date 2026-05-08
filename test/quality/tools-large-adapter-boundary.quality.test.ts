import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "../..");
const toolsSrcRoot = resolve(repoRoot, "packages/brewva-tools/src");
const familiesRoot = join(toolsSrcRoot, "families");
const sharedRoot = join(toolsSrcRoot, "shared");

const MAX_REVIEWABLE_LINES = 500;
const GENERATED_OR_SCHEMA_FILES = new Set<string>([
  "packages/brewva-tools/src/families/navigation/parsing/oxc-source.ts",
]);

const PENDING_LARGE_ADAPTER_ALLOWLIST = new Set<string>();

function listTypeScriptFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const pending = [root];
  const files: string[] = [];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) continue;
    for (const entry of readdirSync(current)) {
      const path = join(current, entry);
      const stats = statSync(path);
      if (stats.isDirectory()) {
        pending.push(path);
        continue;
      }
      if (stats.isFile() && entry.endsWith(".ts")) {
        files.push(relative(repoRoot, path));
      }
    }
  }
  return files.toSorted();
}

function lineCount(relativePath: string): number {
  return readFileSync(resolve(repoRoot, relativePath), "utf8").split("\n").length;
}

describe("brewva-tools large adapter boundaries", () => {
  test("keeps newly decomposed family and shared modules under the reviewable line budget", () => {
    const files = [...listTypeScriptFiles(familiesRoot), ...listTypeScriptFiles(sharedRoot)];
    const oversizedFiles = files
      .filter((file) => !GENERATED_OR_SCHEMA_FILES.has(file))
      .map((file) => ({ file, lines: lineCount(file) }))
      .filter(
        ({ file, lines }) =>
          lines > MAX_REVIEWABLE_LINES && !PENDING_LARGE_ADAPTER_ALLOWLIST.has(file),
      )
      .map(({ file, lines }) => `${file}:${lines}`);

    expect(oversizedFiles).toEqual([]);
  });

  test("keeps the Phase 3 large-adapter allowlist empty", () => {
    expect([...PENDING_LARGE_ADAPTER_ALLOWLIST]).toEqual([]);
  });
});
