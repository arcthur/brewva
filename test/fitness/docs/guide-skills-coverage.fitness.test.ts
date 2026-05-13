import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("docs/guide skills coverage", () => {
  it("routes exact skill inventory readers to the reference inventory", () => {
    const repoRoot = resolve(import.meta.dirname, "../../..");
    const markdown = readFileSync(resolve(repoRoot, "docs/guide/features.md"), "utf-8");

    expect(markdown).toContain("docs/reference/skills.md");
    expect(markdown).not.toContain("## Current Skill Name Index");
  });
});
