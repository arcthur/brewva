import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadBrewvaPromptTemplates } from "@brewva/brewva-substrate/prompt";
import { createBrewvaSyntheticSourceInfo } from "@brewva/brewva-substrate/provenance";

describe("substrate provenance", () => {
  test("creates stable synthetic source info", () => {
    expect(
      createBrewvaSyntheticSourceInfo("sdk:session", {
        source: "substrate-sdk",
        scope: "sdk",
      }),
    ).toEqual({
      path: "sdk:session",
      source: "substrate-sdk",
      scope: "sdk",
    });
  });

  test("attaches typed source info to loaded prompt templates", () => {
    const root = mkdtempSync(join(tmpdir(), "brewva-provenance-"));
    const projectPrompts = join(root, ".brewva", "prompts");
    mkdirSync(projectPrompts, { recursive: true });
    writeFileSync(join(projectPrompts, "review.md"), "Review this branch.\n", "utf8");

    const templates = loadBrewvaPromptTemplates({
      cwd: root,
      agentDir: join(root, ".agent"),
      includeDefaults: true,
    });

    expect(templates).toHaveLength(1);
    expect(templates[0]?.sourceInfo).toEqual({
      path: join(projectPrompts, "review.md"),
      source: "local",
      scope: "project",
      baseDir: projectPrompts,
    });
  });
});
