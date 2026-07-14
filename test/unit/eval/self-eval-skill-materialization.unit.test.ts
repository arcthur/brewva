import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { composeSkillCatalog } from "../../../packages/brewva-gateway/src/hosted/internal/session/runtime-ops-builders/skills.js";
import {
  PILOT_SKILL_NAMES,
  materializeSelfEvalSkillArm,
} from "../../eval/self-eval/skill-materialization.js";

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..");

function catalogNames(workspace: string): readonly string[] {
  return composeSkillCatalog({
    workspaceRoot: workspace,
    roots: [{ root: join(workspace, "skills"), overlay: false, projectRoot: workspace }],
  }).report.loadedSkills;
}

describe("self-eval skill-arm materialization", () => {
  test("no_skill removes only the target pilot from the production catalog", () => {
    const workspace = mkdtempSync(join(tmpdir(), "self-eval-arm-none-"));
    const result = materializeSelfEvalSkillArm({
      arm: "no_skill",
      pilotSkill: "debugging",
      sourceRoot: REPO_ROOT,
      workspace,
    });

    expect(catalogNames(workspace)).toEqual(["learning-research", "review"]);
    expect(result.loadedSkills.map((skill) => skill.name)).toEqual(["learning-research", "review"]);
    expect(result.skillCorpusDigest).toMatch(/^[a-f0-9]{64}$/u);
  });

  test("kernel_scaffold exposes exactly the pilot skills with strict protocols", () => {
    const workspace = mkdtempSync(join(tmpdir(), "self-eval-arm-scaffold-"));
    const result = materializeSelfEvalSkillArm({
      arm: "kernel_scaffold",
      pilotSkill: "debugging",
      sourceRoot: REPO_ROOT,
      workspace,
    });

    expect(catalogNames(workspace)).toEqual([...PILOT_SKILL_NAMES]);
    expect(result.loadedSkills.map((skill) => skill.name)).toEqual([...PILOT_SKILL_NAMES]);
    for (const skill of PILOT_SKILL_NAMES) {
      expect(
        existsSync(join(workspace, "skills", "core", skill, "references", "strict-protocol.md")),
      ).toBe(true);
    }
  });

  test("kernel_only removes the strict scaffold only from the target pilot", () => {
    const workspace = mkdtempSync(join(tmpdir(), "self-eval-arm-kernel-"));
    const result = materializeSelfEvalSkillArm({
      arm: "kernel_only",
      pilotSkill: "debugging",
      sourceRoot: REPO_ROOT,
      workspace,
    });

    expect(catalogNames(workspace)).toEqual([...PILOT_SKILL_NAMES]);
    expect(result.loadedSkills.map((skill) => skill.name)).toEqual([...PILOT_SKILL_NAMES]);
    for (const skill of PILOT_SKILL_NAMES) {
      const root = join(workspace, "skills", "core", skill);
      const isTarget = skill === "debugging";
      expect(existsSync(join(root, "references", "strict-protocol.md"))).toBe(!isTarget);
      expect(readFileSync(join(root, "SKILL.md"), "utf8").includes("strict-protocol.md")).toBe(
        !isTarget,
      );
    }
  });
});
