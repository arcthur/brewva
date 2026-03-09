import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("project overlay contracts", () => {
  it("keeps the Brewva review overlay wired to shared context and DoD tooling", () => {
    const repoRoot = resolve(import.meta.dirname, "../..");
    const markdown = readFileSync(
      resolve(repoRoot, "skills/project/overlays/review/SKILL.md"),
      "utf-8",
    );

    expect(markdown).toContain("skills/project/shared/package-boundaries.md");
    expect(markdown).toContain("skills/project/shared/migration-priority-matrix.md");
    expect(markdown).toContain("skills/project/scripts/check-skill-dod.sh");
  });

  it("keeps runtime-forensics overlay pointed at canonical runtime artifact context", () => {
    const repoRoot = resolve(import.meta.dirname, "../..");
    const markdown = readFileSync(
      resolve(repoRoot, "skills/project/overlays/runtime-forensics/SKILL.md"),
      "utf-8",
    );

    expect(markdown).toContain("skills/project/shared/runtime-artifacts.md");
  });
});
