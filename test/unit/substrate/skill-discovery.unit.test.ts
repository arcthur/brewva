import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createHostedResourceLoader } from "@brewva/brewva-substrate/resources";
import { createTestWorkspace } from "../../helpers/workspace.js";

// Fixture creation for the budget cases writes thousands of paths; the bare
// bun test 5s default is too tight on loaded machines.
setDefaultTimeout(60_000);

function writeSkill(path: string, name: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    `---
name: ${name}
description: ${name} description
---

${name} body.
`,
    "utf8",
  );
}

describe("substrate skill discovery walk containment", () => {
  test("does not descend into node_modules when collecting skills", async () => {
    const workspace = createTestWorkspace("skill-discovery-node-modules");
    const globalRoot = mkdtempSync(join(tmpdir(), "brewva-skill-discovery-nm-"));
    const agentDir = join(globalRoot, "agent");
    mkdirSync(agentDir, { recursive: true });

    writeSkill(join(globalRoot, "skills", "real-skill", "SKILL.md"), "real-skill");
    writeSkill(
      join(globalRoot, "skills", "real-skill", "node_modules", "dep", "SKILL.md"),
      "leaked-dependency-skill",
    );

    const loader = await createHostedResourceLoader({ cwd: workspace, agentDir });

    expect(loader.getSkills().skills.map((skill) => skill.name)).toEqual(["real-skill"]);
    // Skipping ignored directories is intentional pruning, not truncation.
    expect(loader.getSkills().diagnostics).toEqual([]);
  });

  test("does not qualify a root as skill root through node_modules content", async () => {
    // Covers the hasSkillDocuments probe: the only SKILL.md lives inside
    // node_modules, so the global root must not qualify at all.
    const workspace = createTestWorkspace("skill-discovery-nm-probe");
    const globalRoot = mkdtempSync(join(tmpdir(), "brewva-skill-discovery-nm-probe-"));
    const agentDir = join(globalRoot, "agent");
    mkdirSync(agentDir, { recursive: true });

    writeSkill(join(globalRoot, "node_modules", "dep", "SKILL.md"), "leaked-dependency-skill");

    const loader = await createHostedResourceLoader({ cwd: workspace, agentDir });

    expect(loader.getSkills().skills).toEqual([]);
  });

  test("stops descending past the discovery depth cap", async () => {
    const workspace = createTestWorkspace("skill-discovery-depth");
    const globalRoot = mkdtempSync(join(tmpdir(), "brewva-skill-discovery-depth-"));
    const agentDir = join(globalRoot, "agent");
    mkdirSync(agentDir, { recursive: true });

    writeSkill(join(globalRoot, "skills", "shallow-skill", "SKILL.md"), "shallow-skill");
    const deepSegments = Array.from({ length: 16 }, (_, index) => `level-${index}`);
    writeSkill(join(globalRoot, ...deepSegments, "SKILL.md"), "buried-skill");

    const loader = await createHostedResourceLoader({ cwd: workspace, agentDir });

    expect(loader.getSkills().skills.map((skill) => skill.name)).toEqual(["shallow-skill"]);
    expect(loader.getSkills().diagnostics.map((diagnostic) => diagnostic.message)).toContain(
      "skill_discovery_truncated: walk budget exceeded",
    );
  });

  test("stops walking once the per-root directory budget is exhausted", async () => {
    const workspace = createTestWorkspace("skill-discovery-budget");
    const globalRoot = mkdtempSync(join(tmpdir(), "brewva-skill-discovery-budget-"));
    const agentDir = join(globalRoot, "agent");
    mkdirSync(agentDir, { recursive: true });

    // A SKILL.md directly under the root keeps qualification deterministic
    // regardless of which directories the bounded walk reaches.
    writeSkill(join(globalRoot, "SKILL.md"), "root-skill");
    for (let branch = 0; branch < 40; branch += 1) {
      for (let leaf = 0; leaf < 35; leaf += 1) {
        mkdirSync(join(globalRoot, `branch-${branch}`, `leaf-${leaf}`), { recursive: true });
      }
    }

    const loader = await createHostedResourceLoader({ cwd: workspace, agentDir });

    expect(loader.getSkills().skills.map((skill) => skill.name)).toEqual(["root-skill"]);
    expect(loader.getSkills().diagnostics.map((diagnostic) => diagnostic.message)).toContain(
      "skill_discovery_truncated: walk budget exceeded",
    );
  });

  test("reports truncation when the qualification probe gives up on a huge root", async () => {
    // The probe walking a huge skill-free root must not silently drop it:
    // a misconfigured skills.root would otherwise just yield zero skills.
    const workspace = createTestWorkspace("skill-discovery-probe-budget");
    const globalRoot = mkdtempSync(join(tmpdir(), "brewva-skill-discovery-probe-"));
    const agentDir = join(globalRoot, "agent");
    mkdirSync(agentDir, { recursive: true });

    for (let branch = 0; branch < 40; branch += 1) {
      for (let leaf = 0; leaf < 35; leaf += 1) {
        mkdirSync(join(globalRoot, `branch-${branch}`, `leaf-${leaf}`), { recursive: true });
      }
    }

    const loader = await createHostedResourceLoader({ cwd: workspace, agentDir });

    expect(loader.getSkills().skills).toEqual([]);
    expect(loader.getSkills().diagnostics).toContainEqual({
      path: globalRoot,
      message: "skill_discovery_truncated: walk budget exceeded",
    });
  });

  test("stops descending after a giant flat directory exhausts the entry budget", async () => {
    // Shared OS temp dirs are wide-first: one readdir returns tens of
    // thousands of entries. Root-level files must still be matched.
    const workspace = createTestWorkspace("skill-discovery-entries");
    const globalRoot = mkdtempSync(join(tmpdir(), "brewva-skill-discovery-entries-"));
    const agentDir = join(globalRoot, "agent");
    mkdirSync(agentDir, { recursive: true });

    writeSkill(join(globalRoot, "SKILL.md"), "root-skill");
    mkdirSync(join(globalRoot, "unreached"), { recursive: true });
    writeSkill(join(globalRoot, "unreached", "buried", "SKILL.md"), "buried-skill");
    for (let index = 0; index < 11_000; index += 1) {
      writeFileSync(join(globalRoot, `filler-${index}.txt`), "", "utf8");
    }

    const loader = await createHostedResourceLoader({ cwd: workspace, agentDir });

    expect(loader.getSkills().skills.map((skill) => skill.name)).toEqual(["root-skill"]);
    expect(loader.getSkills().diagnostics.map((diagnostic) => diagnostic.message)).toContain(
      "skill_discovery_truncated: walk budget exceeded",
    );
  });
});
