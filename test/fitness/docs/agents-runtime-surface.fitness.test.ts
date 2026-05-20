import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("AGENTS runtime surface coverage", () => {
  it("documents the four-port runtime root surface", () => {
    const repoRoot = resolve(import.meta.dirname, "../../..");
    const agentsDoc = readFileSync(resolve(repoRoot, "AGENTS.md"), "utf-8");

    expect(agentsDoc).toContain("`tape`");
    expect(agentsDoc).toContain("`kernel`");
    expect(agentsDoc).toContain("`model`");
    expect(agentsDoc).toContain("`turn`");
    expect(agentsDoc).toContain("`../../helpers/runtime.js`");
  });
});
