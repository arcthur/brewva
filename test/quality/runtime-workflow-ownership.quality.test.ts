import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "../..");

function readRepoFile(relativePath: string): string {
  return readFileSync(resolve(repoRoot, relativePath), "utf-8");
}

function listSourceFiles(relativeDir: string): string[] {
  const absoluteDir = resolve(repoRoot, relativeDir);
  const files: string[] = [];

  for (const entry of readdirSync(absoluteDir)) {
    const absolutePath = resolve(absoluteDir, entry);
    const relativePath = `${relativeDir}/${entry}`;
    const stats = statSync(absolutePath);
    if (stats.isDirectory()) {
      files.push(...listSourceFiles(relativePath));
      continue;
    }
    if (stats.isFile() && relativePath.endsWith(".ts")) {
      files.push(relativePath);
    }
  }

  return files;
}

describe("runtime workflow derivation ownership", () => {
  test("root runtime exports concrete workflow owner modules without a derivation shim", () => {
    const indexSource = readRepoFile("packages/brewva-runtime/src/index.ts");

    expect(
      existsSync(resolve(repoRoot, "packages/brewva-runtime/src/workflow/derivation.ts")),
    ).toBe(false);
    expect(indexSource).not.toContain("./workflow/derivation.js");
    expect(indexSource).toContain("./workflow/types.js");
    expect(indexSource).toContain("./workflow/artifact-derivation.js");
    expect(indexSource).toContain("./workflow/status-derivation.js");
    expect(indexSource).toContain("./workflow/workspace-revision.js");
    expect(indexSource).not.toContain('export * from "./workflow/artifact-derivation.js"');
  });

  test("runtime source imports concrete workflow owner modules directly", () => {
    for (const relativePath of listSourceFiles("packages/brewva-runtime/src")) {
      const source = readRepoFile(relativePath);
      expect(source, relativePath).not.toContain("workflow/derivation.js");
      expect(source, relativePath).not.toContain("../workflow/derivation.js");
      expect(source, relativePath).not.toContain("./workflow/derivation.js");
    }
  });
});
