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

  test("skill authoring references the shared authored-behavior guide", () => {
    const markdown = readRepoFile("skills/meta/skill-authoring/SKILL.md");

    expect(markdown).toContain("references/authored-behavior.md");
    expect(markdown).toContain("Author the behavior, not just the schema");
  });

  test("strategy documents timing pressure and explicit scope ledgers", () => {
    const markdown = readRepoFile("skills/core/strategy/SKILL.md");

    expect(markdown).toMatch(/why now/i);
    expect(markdown).toMatch(/accepted\s*\/\s*deferred\s*\/\s*non-goals scope ledger/);
  });

  test("architecture preserves deepening language and seam discipline", () => {
    const markdown = readRepoFile("skills/core/architecture/SKILL.md");
    const language = readRepoFile("skills/core/architecture/references/language.md");
    const deepening = readRepoFile("skills/core/architecture/references/deepening.md");

    expect(markdown).toContain("NO DEEPENING OPPORTUNITY WITHOUT A NAMED MODULE");
    expect(markdown).toContain("deletion test");
    expect(markdown).toContain("interface as the test surface");
    expect(language).toContain("Module");
    expect(language).toContain("Depth");
    expect(deepening).toContain("One adapter is a hypothetical seam");
    expect(deepening).toContain("Testing Through The Deepened Interface");
  });

  test("office-hours preserves diagnostic discipline from the source skill", () => {
    const markdown = readRepoFile("skills/core/office-hours/SKILL.md");
    const startup = readRepoFile("skills/core/office-hours/references/startup-diagnostic.md");
    const builder = readRepoFile("skills/core/office-hours/references/builder-mode.md");
    const alternatives = readRepoFile(
      "skills/core/office-hours/references/premise-and-alternatives.md",
    );

    expect(markdown).toContain("NO OFFICE HOURS WITHOUT MODE, PREMISES, AND A NEXT ASSIGNMENT");
    expect(markdown).toContain("Ask one question at a time");
    expect(markdown).toContain("Office-hours compares bets, not task lists");
    expect(startup).toContain("Interest is not demand");
    expect(startup).toContain("The status quo is your real competitor");
    expect(startup).toContain("Desperate Specificity");
    expect(builder).toContain("Delight is the currency");
    expect(builder).toContain("Ship something you can show people");
    expect(alternatives).toContain("Minimal viable path");
    expect(alternatives).toContain("Ideal architecture or fullest-value path");
    expect(alternatives).toContain("Creative or lateral path");
  });

  test("verifier documents diff-aware, browser-first, and rerun-after-fix behavior", () => {
    const markdown = readRepoFile("skills/core/verifier/SKILL.md");
    const referenceMarkdown = readRepoFile(
      "skills/core/verifier/references/exploratory-regression-checklist.md",
    );

    expect(markdown).toContain("diff-aware");
    expect(referenceMarkdown).toContain("browser-first");
    expect(referenceMarkdown).toContain("rerun");
  });

  test("ship documents read-only release engineer boundaries", () => {
    const markdown = readRepoFile("skills/core/ship/SKILL.md");

    expect(markdown).toMatch(/read-only\s+release engineer/i);
    expect(markdown).toContain("PR handoff");
    expect(markdown).toContain("does not patch product code");
  });

  test("retro documents metrics-first hotspot analysis", () => {
    const markdown = readRepoFile("skills/core/retro/SKILL.md");
    const referenceMarkdown = readRepoFile("skills/core/retro/references/retrospective-lenses.md");

    expect(referenceMarkdown).toContain("Metrics-First Questions");
    expect(referenceMarkdown).toContain("most churn");
    expect(markdown).toContain("systemic");
  });

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
