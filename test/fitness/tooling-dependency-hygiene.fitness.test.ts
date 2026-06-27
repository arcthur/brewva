import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "../..");

function readRepoFile(relativePath: string): string {
  return readFileSync(resolve(repoRoot, relativePath), "utf8");
}

describe("tooling dependency hygiene", () => {
  test("runs Knip as a dependency and binary hygiene gate", () => {
    const packageJson = JSON.parse(readRepoFile("package.json")) as {
      scripts?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const knipConfig = JSON.parse(readRepoFile("knip.json")) as {
      ignoreBinaries?: string[];
      ignoreDependencies?: string[];
    };

    expect(packageJson.devDependencies?.knip).toMatch(/^6\.\d+\.\d+$/u);
    expect(packageJson.scripts?.["lint:unused"]).toBe("knip --dependencies --no-progress");
    expect(packageJson.scripts?.check).toContain("bun run lint:unused");
    expect(knipConfig.ignoreBinaries).toEqual(expect.arrayContaining(["codesign", "file"]));
    expect(knipConfig.ignoreDependencies).toEqual(["@vscode/tree-sitter-wasm"]);
  });

  test("pins every direct dependency to an exact version (no caret/tilde ranges)", () => {
    const packageJson = JSON.parse(readRepoFile("package.json")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    // Exact pins make a dependency bump a reviewed edit and shrink the blast radius of a
    // compromised release: `bun.lock` blocks transitive drift, this blocks direct drift.
    // Both manifest sections are checked; `workspace:*` internal packages are not ranges
    // and pass naturally.
    const ranged = Object.entries({
      ...packageJson.dependencies,
      ...packageJson.devDependencies,
    }).filter(([, spec]) => /^[\^~]/u.test(spec));
    expect(ranged).toEqual([]);
  });
});
