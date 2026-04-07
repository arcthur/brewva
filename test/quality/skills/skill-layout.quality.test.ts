import { describe, expect, it } from "bun:test";
import { readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const LOADABLE_CATEGORIES = ["core", "domain", "operator", "meta", "internal"] as const;

function listMissingSkillDocuments(root: string): string[] {
  const missing: string[] = [];

  for (const category of LOADABLE_CATEGORIES) {
    const categoryDir = join(root, category);
    let entries: Array<import("node:fs").Dirent>;
    try {
      entries = readdirSync(categoryDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillDir = join(categoryDir, entry.name);
      const skillPath = join(skillDir, "SKILL.md");
      try {
        if (!statSync(skillPath).isFile()) {
          missing.push(`${category}/${entry.name}`);
        }
      } catch {
        missing.push(`${category}/${entry.name}`);
      }
    }
  }

  return missing.toSorted();
}

describe("skill layout quality", () => {
  it("keeps every loadable skill directory anchored by SKILL.md", () => {
    const repoRoot = resolve(import.meta.dirname, "../../..");
    const missing = listMissingSkillDocuments(resolve(repoRoot, "skills"));
    expect(missing, `Directories missing SKILL.md: ${missing.join(", ")}`).toEqual([]);
  });
});
