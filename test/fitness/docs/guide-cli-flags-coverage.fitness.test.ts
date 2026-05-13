import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("docs/guide CLI coverage", () => {
  it("routes exact CLI flag readers to the reference inventory", () => {
    const repoRoot = resolve(import.meta.dirname, "../../..");
    const docsPath = resolve(repoRoot, "docs/guide/cli.md");
    const docs = readFileSync(docsPath, "utf-8");

    expect(docs).toContain("docs/reference/commands.md");
    expect(docs).not.toContain("## Flag Coverage Map");
  });
});
