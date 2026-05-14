import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "../../..");

function walk(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist") {
      continue;
    }
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      files.push(...walk(path));
      continue;
    }
    if (/\.(ts|tsx)$/u.test(path)) {
      files.push(path);
    }
  }
  return files;
}

function directOpenTuiImportSpecifiers(file: string): string[] {
  const source = readFileSync(file, "utf8");
  const matches = source.matchAll(
    /(?:import|export)\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?["'](@opentui\/[^"']+)["']/gu,
  );
  return [...matches].map((match) => match[1] ?? "");
}

describe("OpenTUI import quarantine", () => {
  test("keeps cli OpenTUI imports behind the local adapter", () => {
    const allowlist = new Set([
      "packages/brewva-cli/runtime/internal-opentui-runtime.ts",
      "packages/brewva-cli/runtime/opentui/index.ts",
      "script/build-binaries.ts",
    ]);
    const files = [
      ...walk(resolve(repoRoot, "packages", "brewva-cli")),
      resolve(repoRoot, "script", "build-binaries.ts"),
    ];
    const violations = files
      .map((file) => ({
        file: relative(repoRoot, file),
        specifiers: directOpenTuiImportSpecifiers(file),
      }))
      .filter((entry) => entry.specifiers.length > 0 && !allowlist.has(entry.file));

    expect(violations).toEqual([]);
  });

  test("keeps cli internal tui helpers free of direct OpenTUI imports", () => {
    const violations = walk(resolve(repoRoot, "packages", "brewva-cli", "src", "internal", "tui"))
      .map((file) => ({
        file: relative(repoRoot, file),
        specifiers: directOpenTuiImportSpecifiers(file),
      }))
      .filter((entry) => entry.specifiers.length > 0);

    expect(violations).toEqual([]);
  });
});
