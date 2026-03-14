import { describe, expect, it } from "bun:test";
import { readdirSync, statSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

function listSkillNames(rootDir: string): string[] {
  const entries = readdirSync(rootDir, { withFileTypes: true });
  const names: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillPath = join(rootDir, entry.name, "SKILL.md");
    try {
      if (statSync(skillPath).isFile()) {
        names.push(entry.name);
      }
    } catch {
      // Ignore non-skill folders.
    }
  }
  return names.toSorted();
}

describe("README skill coverage", () => {
  it("mentions all repository skills", () => {
    const repoRoot = resolve(import.meta.dirname, "../../..");
    const readme = readFileSync(resolve(repoRoot, "README.md"), "utf-8");

    const coreSkills = listSkillNames(resolve(repoRoot, "skills/core"));
    const domainSkills = listSkillNames(resolve(repoRoot, "skills/domain"));
    const operatorSkills = listSkillNames(resolve(repoRoot, "skills/operator"));
    const metaSkills = listSkillNames(resolve(repoRoot, "skills/meta"));
    const allSkills = [...coreSkills, ...domainSkills, ...operatorSkills, ...metaSkills];

    const missing = allSkills.filter((name) => !readme.includes(`\`${name}\``));

    expect(missing, `Missing skills in README.md: ${missing.join(", ")}`).toEqual([]);
  });
});
