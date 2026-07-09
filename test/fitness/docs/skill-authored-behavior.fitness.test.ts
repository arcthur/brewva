import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function repoRoot(): string {
  return resolve(import.meta.dirname, "../../..");
}

function readRepoFile(relativePath: string): string {
  return readFileSync(resolve(repoRoot(), relativePath), "utf-8");
}

describe("skill authored behavior coverage", () => {
  for (const relativePath of [
    "skills/core/repository-analysis/SKILL.md",
    "skills/core/architecture/SKILL.md",
    "skills/core/office-hours/SKILL.md",
    "skills/core/discovery/SKILL.md",
    "skills/core/learning-research/SKILL.md",
    "skills/core/strategy/SKILL.md",
    "skills/core/plan/SKILL.md",
    "skills/core/debugging/SKILL.md",
    "skills/core/implementation/SKILL.md",
    "skills/core/review/SKILL.md",
    "skills/core/verifier/SKILL.md",
    "skills/core/ship/SKILL.md",
    "skills/core/retro/SKILL.md",
    "skills/core/knowledge-capture/SKILL.md",
    "skills/operator/runtime-forensics/SKILL.md",
    "skills/domain/agent-browser/SKILL.md",
    "skills/domain/ci-iteration/SKILL.md",
    "skills/domain/frontend-design/SKILL.md",
    "skills/domain/github/SKILL.md",
    "skills/domain/goal-loop/SKILL.md",
    "skills/domain/predict-review/SKILL.md",
    "skills/domain/extract/SKILL.md",
    "skills/domain/telegram/SKILL.md",
    "skills/operator/git/SKILL.md",
    "skills/meta/self-improve/SKILL.md",
    "skills/meta/skill-authoring/SKILL.md",
  ]) {
    test(`${relativePath} documents operating protocol and handoff behavior`, () => {
      const markdown = readRepoFile(relativePath);

      expect(markdown).toContain("## Workflow");
      expect(markdown).toContain("## Decision Protocol");
      expect(markdown).toContain("## Handoff Expectations");
    });
  }

  test("predict-review maps perspectives to canonical built-in agent specs", () => {
    const skillMarkdown = readRepoFile("skills/domain/predict-review/SKILL.md");
    const referenceMarkdown = readRepoFile(
      "skills/domain/predict-review/references/perspectives.md",
    );

    expect(skillMarkdown).toContain("references/perspectives.md");
    expect(skillMarkdown).toContain("verification_evidence");
    expect(skillMarkdown).not.toContain("`reviewer`");
    expect(skillMarkdown).not.toContain("`researcher`");
    expect(skillMarkdown).not.toContain("`verifier`");

    expect(referenceMarkdown).toContain("review-boundaries");
    expect(referenceMarkdown).toContain("review-security");
    expect(referenceMarkdown).toContain("review-operability");
    expect(referenceMarkdown).toContain("review-concurrency");
    expect(referenceMarkdown).toContain("review-compatibility");
    expect(referenceMarkdown).toContain("`verifier`");
    expect(referenceMarkdown).not.toContain("`reviewer`");
    expect(referenceMarkdown).not.toContain("`researcher`");
  });
});
