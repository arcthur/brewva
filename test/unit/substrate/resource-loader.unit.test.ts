import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createHostedResourceLoader } from "@brewva/brewva-substrate";
import { createTestWorkspace } from "../../helpers/workspace.js";

function writeFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
}

describe("substrate resource loader", () => {
  test("loads project and global skills while respecting disabled config", async () => {
    const workspace = createTestWorkspace("resource-loader-skills");
    const globalRoot = mkdtempSync(join(tmpdir(), "brewva-resource-loader-global-"));
    const agentDir = join(globalRoot, "agent");
    mkdirSync(agentDir, { recursive: true });

    writeFile(
      join(globalRoot, "skills", "global-skill", "SKILL.md"),
      `---
name: global-skill
description: Global skill
---

Global body.
`,
    );
    writeFile(
      join(workspace, ".brewva", "skills", "project-skill", "SKILL.md"),
      `---
name: project-skill
description: Project skill
---

Project body.
`,
    );
    writeFile(
      join(workspace, ".brewva", "brewva.json"),
      JSON.stringify(
        {
          skills: {
            disabled: ["global-skill"],
          },
        },
        null,
        2,
      ),
    );

    const loader = await createHostedResourceLoader({
      cwd: workspace,
      agentDir,
    });

    expect(loader.getSkills()).toEqual({
      skills: [
        {
          name: "project-skill",
          description: "Project skill",
          filePath: join(workspace, ".brewva", "skills", "project-skill", "SKILL.md"),
          baseDir: join(workspace, ".brewva", "skills", "project-skill"),
        },
      ],
      diagnostics: [],
    });
  });

  test("loads prompt templates from global and project prompt directories", async () => {
    const workspace = createTestWorkspace("resource-loader-prompts");
    const globalRoot = mkdtempSync(join(tmpdir(), "brewva-resource-loader-prompts-"));
    const agentDir = join(globalRoot, "agent");
    mkdirSync(agentDir, { recursive: true });

    writeFile(
      join(agentDir, "prompts", "global-review.md"),
      `---
description: Review globally
---

Global review prompt.
`,
    );
    writeFile(
      join(workspace, ".brewva", "prompts", "project-cleanup.md"),
      `Project cleanup prompt.
`,
    );

    const loader = await createHostedResourceLoader({
      cwd: workspace,
      agentDir,
    });

    expect(loader.getPrompts().prompts).toEqual([
      {
        name: "global-review",
        description: "Review globally",
        content: "\nGlobal review prompt.\n",
        filePath: join(agentDir, "prompts", "global-review.md"),
      },
      {
        name: "project-cleanup",
        description: "Project cleanup prompt.",
        content: "Project cleanup prompt.\n",
        filePath: join(workspace, ".brewva", "prompts", "project-cleanup.md"),
      },
    ]);
  });
});
