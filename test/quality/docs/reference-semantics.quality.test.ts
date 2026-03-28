import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function readDoc(repoRoot: string, relativePath: string): string {
  return readFileSync(resolve(repoRoot, relativePath), "utf-8");
}

describe("docs/reference semantic contracts", () => {
  it("documents target-root scoping across tools and exec", () => {
    const repoRoot = resolve(import.meta.dirname, "../../..");
    const toolsDoc = readDoc(repoRoot, "docs/reference/tools.md");
    const configurationDoc = readDoc(repoRoot, "docs/reference/configuration.md");

    expect(toolsDoc).toContain("current task target roots");
    expect(toolsDoc).toContain("browser outputs remain workspace-root scoped");
    expect(configurationDoc).toContain(
      "`exec.workdir` is validated against the current task target roots before",
    );
  });

  it("documents adaptive verification and per-root execution semantics", () => {
    const repoRoot = resolve(import.meta.dirname, "../../..");
    const configurationDoc = readDoc(repoRoot, "docs/reference/configuration.md");
    const runtimeDoc = readDoc(repoRoot, "docs/reference/runtime.md");

    expect(configurationDoc).toContain(
      "multi-root tasks expand default verification checks per target root",
    );
    expect(configurationDoc).toContain(
      "auto-discovered `package.json` scripts run through the root package manager",
    );
    expect(runtimeDoc).toContain("default verification checks are expanded per target root");
    expect(runtimeDoc).toContain("command-backed checks are tracked as `command_passed` evidence");
  });

  it("documents verifier blockers as verification debt rather than hard blockers", () => {
    const repoRoot = resolve(import.meta.dirname, "../../..");
    const runtimeDoc = readDoc(repoRoot, "docs/reference/runtime.md");
    const toolsDoc = readDoc(repoRoot, "docs/reference/tools.md");

    expect(runtimeDoc).toContain("ordinary verifier blockers are verification debt");
    expect(toolsDoc).toContain(
      "Repository-scoped retrieval filters repository artifacts to the current task",
    );
  });
});
