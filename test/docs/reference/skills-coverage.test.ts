import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

function collectSkillNames(root: string, relativeDirs: string[]): string[] {
  const names: string[] = [];

  for (const relativeDir of relativeDirs) {
    const tierDir = join(root, relativeDir);
    let entries: Array<import("node:fs").Dirent>;
    try {
      entries = readdirSync(tierDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillPath = join(tierDir, entry.name, "SKILL.md");
      try {
        if (statSync(skillPath).isFile()) {
          names.push(entry.name);
        }
      } catch {
        // Ignore non-skill folders.
      }
    }
  }

  return names.toSorted();
}

function collectSharedContextNames(root: string): string[] {
  const sharedDir = join(root, "project/shared");
  try {
    return readdirSync(sharedDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .map((entry) => entry.name.replace(/\.md$/i, ""))
      .toSorted();
  } catch {
    return [];
  }
}

describe("docs/reference skills coverage", () => {
  it("documents all skill names", () => {
    const repoRoot = resolve(import.meta.dirname, "../../..");
    const skillNames = collectSkillNames(resolve(repoRoot, "skills"), [
      "core",
      "domain",
      "operator",
      "meta",
      "project/overlays",
    ]);
    const sharedNames = collectSharedContextNames(resolve(repoRoot, "skills"));
    const markdown = readFileSync(resolve(repoRoot, "docs/reference/skills.md"), "utf-8");

    const missing = [...skillNames, ...sharedNames].filter(
      (name) => !markdown.includes(`\`${name}\``),
    );

    expect(missing, `Missing skills in docs/reference/skills.md: ${missing.join(", ")}`).toEqual(
      [],
    );
  });
});
