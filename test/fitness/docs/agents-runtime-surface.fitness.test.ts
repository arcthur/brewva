import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("AGENTS runtime surface coverage", () => {
  it("documents the semantic runtime root surfaces", () => {
    const repoRoot = resolve(import.meta.dirname, "../../..");
    const agentsDoc = readFileSync(resolve(repoRoot, "AGENTS.md"), "utf-8");

    expect(agentsDoc).toContain("`root.authority`");
    expect(agentsDoc).toContain("`root.inspect`");
    expect(agentsDoc).toContain("`selectOperatorRuntimePort(instance).operator`");
    expect(agentsDoc).toContain("mixed top-level implementation surface");
  });
});
