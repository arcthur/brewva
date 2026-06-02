import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrewvaHostedResourceLoader } from "@brewva/brewva-substrate/resources";
import { buildSkillCommandText } from "../../../packages/brewva-gateway/src/hosted/internal/session/managed-agent/prompt-content.js";

function createResourceLoaderWithSkill(input: {
  name: string;
  filePath: string;
  baseDir: string;
}): BrewvaHostedResourceLoader {
  return {
    getExtensions: () => ({ extensions: [], errors: [] }),
    getSkills: () => ({
      skills: [
        {
          name: input.name,
          description: "",
          filePath: input.filePath,
          baseDir: input.baseDir,
        },
      ],
      diagnostics: [],
    }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getProjectInstructions: () => ({ files: [], diagnostics: [] }),
    getProjectInstructionsForTarget: () => ({ files: [], diagnostics: [] }),
    getTargetOnlyProjectInstructions: () => ({ files: [], diagnostics: [] }),
    getResourceProviders: () => [],
    registerResourceProvider: () => () => {},
    getCustomInstructions: () => undefined,
    getAppendInstructions: () => [],
    reload: async () => {},
  };
}

describe("managed-agent prompt content", () => {
  test("expands skill commands through the shared frontmatter parser", () => {
    const baseDir = mkdtempSync(join(tmpdir(), "brewva-prompt-content-"));
    const filePath = join(baseDir, "SKILL.md");
    writeFileSync(
      filePath,
      "\uFEFF---\r\nname: example\r\ndescription: Example\r\n---\r\n\r\nUse the shared parser.\r\n",
      "utf8",
    );

    const text = buildSkillCommandText(
      "/skill:example extra args",
      createResourceLoaderWithSkill({ name: "example", filePath, baseDir }),
    );

    expect(text).toContain('<skill name="example"');
    expect(text).toContain("Use the shared parser.");
    expect(text).toContain("extra args");
    expect(text).not.toContain("description: Example");
    expect(text).not.toContain("\uFEFF");
  });
});
