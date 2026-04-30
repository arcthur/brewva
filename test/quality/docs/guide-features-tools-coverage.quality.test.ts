import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("docs/guide features tool coverage", () => {
  it("routes exact tool inventory readers to the reference inventory", () => {
    const repoRoot = resolve(import.meta.dirname, "../../..");
    const markdown = readFileSync(resolve(repoRoot, "docs/guide/features.md"), "utf-8");

    expect(markdown).toContain("docs/reference/tools.md");
    expect(markdown).not.toContain("## Current Tool Name Index");
  });
});
