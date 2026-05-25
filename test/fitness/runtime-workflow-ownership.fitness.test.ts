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
  if (!existsSync(absoluteDir)) return files;

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
  test("vocabulary iteration subpath owns workflow helpers without restoring runtime read models", () => {
    const indexSource = readRepoFile("packages/brewva-runtime/src/index.ts");
    const publicIndexSource = readRepoFile("packages/brewva-runtime/src/public/index.ts");
    const iterationVocabularySource = readRepoFile("packages/brewva-vocabulary/src/iteration.ts");
    const packageManifestSource = readRepoFile("packages/brewva-runtime/package.json");

    expect(
      existsSync(resolve(repoRoot, "packages/brewva-runtime/src/domain/workflow/derivation.ts")),
    ).toBe(false);
    expect(existsSync(resolve(repoRoot, "packages/brewva-runtime/src/domain/workflow"))).toBe(
      false,
    );
    expect(indexSource.trim()).toBe('export * from "./public/index.js";');
    expect(publicIndexSource).not.toContain("./workflow/derivation.js");
    expect(publicIndexSource).not.toContain("../domain/projection/workflow/");
    expect(packageManifestSource).not.toContain('"./projection"');
    expect(iterationVocabularySource).not.toContain("./read-models/");
    expect(iterationVocabularySource).toContain("deriveWorkflowArtifacts");
    expect(iterationVocabularySource).toContain("deriveWorkflowStatus");
    expect(iterationVocabularySource).toContain("resolveWorkspaceRevision");
    expect(publicIndexSource).not.toContain(
      'export * from "../../packages/brewva-runtime/src/domain/workflow/artifact-derivation.js"',
    );
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
