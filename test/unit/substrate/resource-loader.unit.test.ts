import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createHostedResourceLoader } from "@brewva/brewva-substrate/resources";
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
        sourceInfo: {
          path: join(agentDir, "prompts", "global-review.md"),
          source: "local",
          scope: "user",
          baseDir: join(agentDir, "prompts"),
        },
      },
      {
        name: "project-cleanup",
        description: "Project cleanup prompt.",
        content: "Project cleanup prompt.\n",
        filePath: join(workspace, ".brewva", "prompts", "project-cleanup.md"),
        sourceInfo: {
          path: join(workspace, ".brewva", "prompts", "project-cleanup.md"),
          source: "local",
          scope: "project",
          baseDir: join(workspace, ".brewva", "prompts"),
        },
      },
    ]);
  });

  test("loads dual project instruction files in global and ancestor order", async () => {
    const workspace = createTestWorkspace("resource-loader-project-instructions");
    const cwd = join(workspace, "packages", "app");
    const globalRoot = mkdtempSync(join(tmpdir(), "brewva-resource-loader-instructions-"));
    const agentDir = join(globalRoot, "agent");
    mkdirSync(cwd, { recursive: true });
    mkdirSync(agentDir, { recursive: true });

    writeFile(join(agentDir, "CLAUDE.md"), "Global Claude\n");
    writeFile(join(agentDir, "AGENTS.md"), "Global Agents\n");
    writeFile(join(workspace, "CLAUDE.md"), "Root Claude\n");
    writeFile(join(workspace, "AGENTS.md"), "Root Agents\n");
    writeFile(join(workspace, "packages", "AGENTS.md"), "Packages Agents\n");
    writeFile(join(cwd, "CLAUDE.md"), "App Claude\n");

    const loader = await createHostedResourceLoader({
      cwd,
      agentDir,
    });

    expect(
      loader.getProjectInstructions().files.map((file) => ({
        path: file.path,
        source: file.source,
      })),
    ).toEqual([
      { path: join(agentDir, "CLAUDE.md"), source: "global" },
      { path: join(agentDir, "AGENTS.md"), source: "global" },
      { path: join(workspace, "CLAUDE.md"), source: "ancestor" },
      { path: join(workspace, "AGENTS.md"), source: "ancestor" },
      { path: join(workspace, "packages", "AGENTS.md"), source: "ancestor" },
      { path: join(cwd, "CLAUDE.md"), source: "ancestor" },
    ]);
  });

  test("adds target nested project instructions without blocking outside-cwd targets", async () => {
    const workspace = createTestWorkspace("resource-loader-target-instructions");
    const globalRoot = mkdtempSync(join(tmpdir(), "brewva-resource-loader-target-"));
    const agentDir = join(globalRoot, "agent");
    mkdirSync(agentDir, { recursive: true });

    writeFile(join(workspace, "AGENTS.md"), "Root Agents\n");
    writeFile(join(workspace, "packages", "CLAUDE.md"), "Packages Claude\n");
    writeFile(join(workspace, "packages", "app", "AGENTS.md"), "App Agents\n");

    const loader = await createHostedResourceLoader({
      cwd: workspace,
      agentDir,
    });

    expect(
      loader.getProjectInstructionsForTarget("packages/app/src/index.ts").files.map((file) => ({
        path: file.path,
        source: file.source,
      })),
    ).toEqual([
      { path: join(workspace, "AGENTS.md"), source: "ancestor" },
      { path: join(workspace, "packages", "CLAUDE.md"), source: "target" },
      { path: join(workspace, "packages", "app", "AGENTS.md"), source: "target" },
    ]);
    expect(
      loader.getTargetOnlyProjectInstructions("packages/app/src/index.ts").files.map((file) => ({
        path: file.path,
        source: file.source,
      })),
    ).toEqual([
      { path: join(workspace, "packages", "CLAUDE.md"), source: "target" },
      { path: join(workspace, "packages", "app", "AGENTS.md"), source: "target" },
    ]);

    const outside = loader.getProjectInstructionsForTarget(
      join(tmpdir(), "brewva-outside-target.ts"),
    );
    expect(outside.files.map((file) => file.path)).toEqual([join(workspace, "AGENTS.md")]);
    expect(outside.diagnostics).toContainEqual({
      path: join(tmpdir(), "brewva-outside-target.ts"),
      message: "target_path_outside_cwd",
    });
    const outsideTargetOnly = loader.getTargetOnlyProjectInstructions(
      join(tmpdir(), "brewva-outside-target.ts"),
    );
    expect(outsideTargetOnly.files).toEqual([]);
    expect(outsideTargetOnly.diagnostics).toContainEqual({
      path: join(tmpdir(), "brewva-outside-target.ts"),
      message: "target_path_outside_cwd",
    });
  });
});
