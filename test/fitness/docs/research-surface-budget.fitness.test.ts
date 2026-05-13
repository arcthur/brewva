import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("research surface budget workflow", () => {
  it("documents numeric promotion gates for surface-affecting RFCs", () => {
    const repoRoot = resolve(import.meta.dirname, "../../..");
    const markdown = readFileSync(resolve(repoRoot, "docs/research/README.md"), "utf8");

    expect(markdown).toContain("Surface Budget");
    expect(markdown).toContain("required authored fields");
    expect(markdown).toContain("optional authored fields");
    expect(markdown).toContain("author-facing concepts");
    expect(markdown).toContain("inspect surfaces");
    expect(markdown).toContain("routing/control-plane decision points");
    expect(markdown).toContain("runtime/gateway maintainer review");
    expect(markdown).toContain("net required authored fields");
    expect(markdown).toContain("debt owner");
    expect(markdown).toContain("re-evaluation trigger");
  });
});
