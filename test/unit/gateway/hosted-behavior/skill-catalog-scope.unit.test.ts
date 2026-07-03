import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { composeSkillCatalog } from "../../../../packages/brewva-gateway/src/hosted/internal/session/runtime-ops-builders/skills.js";

function writeSkill(root: string, relativeDir: string, name: string): void {
  const dir = join(root, relativeDir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${name} guidance.\n---\n\n# ${name}\n`,
  );
}

describe("composeSkillCatalog workspace scoping", () => {
  const installRoot = mkdtempSync(join(tmpdir(), "brewva-skill-install-"));
  const foreignWorkspace = mkdtempSync(join(tmpdir(), "brewva-skill-foreign-"));
  const skillsRoot = join(installRoot, "skills");

  writeSkill(skillsRoot, "core/architecture", "architecture");
  writeSkill(skillsRoot, "domain/frontend-design", "frontend-design");
  writeSkill(skillsRoot, "project/overlays/implementation", "implementation");
  writeSkill(skillsRoot, "project/shared", "project-shared");

  afterAll(() => {
    rmSync(installRoot, { recursive: true, force: true });
    rmSync(foreignWorkspace, { recursive: true, force: true });
  });

  test("project-category skills load when the workspace is inside the catalog project", () => {
    const catalog = composeSkillCatalog({
      workspaceRoot: installRoot,
      roots: [{ root: skillsRoot, overlay: false, projectRoot: installRoot }],
    });
    expect(catalog.report.loadedSkills).toEqual([
      "architecture",
      "frontend-design",
      "implementation",
      "project-shared",
    ]);
    expect(catalog.report.outOfScopeSkills).toEqual([]);
  });

  test("project-category skills load for a workspace nested inside the project", () => {
    const nested = join(installRoot, "packages", "anything");
    mkdirSync(nested, { recursive: true });
    const catalog = composeSkillCatalog({
      workspaceRoot: nested,
      roots: [{ root: skillsRoot, overlay: false, projectRoot: installRoot }],
    });
    expect(catalog.report.loadedSkills).toContain("implementation");
    expect(catalog.report.outOfScopeSkills).toEqual([]);
  });

  test("project-category skills are excluded for a foreign workspace and reported", () => {
    const catalog = composeSkillCatalog({
      workspaceRoot: foreignWorkspace,
      roots: [{ root: skillsRoot, overlay: false, projectRoot: installRoot }],
    });
    expect(catalog.report.loadedSkills).toEqual(["architecture", "frontend-design"]);
    expect(catalog.skills.map((skill) => skill.name)).toEqual(["architecture", "frontend-design"]);
    expect(catalog.report.outOfScopeSkills).toEqual(["implementation", "project-shared"]);
  });

  test("workspace overlay project skills stay in scope for their own workspace", () => {
    const overlayRoot = join(foreignWorkspace, ".brewva", "skills");
    writeSkill(overlayRoot, "project/overlays/local-guidance", "local-guidance");
    const catalog = composeSkillCatalog({
      workspaceRoot: foreignWorkspace,
      roots: [
        { root: skillsRoot, overlay: false, projectRoot: installRoot },
        { root: overlayRoot, overlay: true, projectRoot: foreignWorkspace },
      ],
    });
    expect(catalog.report.loadedSkills).toEqual([
      "architecture",
      "frontend-design",
      "local-guidance",
    ]);
    expect(catalog.report.overlaySkills).toEqual(["local-guidance"]);
    expect(catalog.report.outOfScopeSkills).toEqual(["implementation", "project-shared"]);
  });

  test("an in-scope overlay skill sharing a name with an out-of-scope skill is not reported", () => {
    const overlayRoot = join(foreignWorkspace, ".brewva", "skills");
    writeSkill(overlayRoot, "project/overlays/implementation", "implementation");
    const catalog = composeSkillCatalog({
      workspaceRoot: foreignWorkspace,
      roots: [
        { root: skillsRoot, overlay: false, projectRoot: installRoot },
        { root: overlayRoot, overlay: true, projectRoot: foreignWorkspace },
      ],
    });
    expect(catalog.report.loadedSkills).toContain("implementation");
    expect(catalog.report.outOfScopeSkills).not.toContain("implementation");
  });
});
