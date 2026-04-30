import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("README skill coverage", () => {
  it("routes exact skill inventory readers to the reference inventory", () => {
    const repoRoot = resolve(import.meta.dirname, "../../..");
    const readme = readFileSync(resolve(repoRoot, "README.md"), "utf-8");

    expect(readme).toContain("docs/reference/skills.md");
  });
});
