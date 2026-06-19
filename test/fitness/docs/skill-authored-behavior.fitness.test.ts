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

  test("strategy documents timing pressure", () => {
    const markdown = readRepoFile("skills/core/strategy/SKILL.md");

    expect(markdown).toMatch(/why now/i);
  });

  test("architecture preserves seam discipline", () => {
    const markdown = readRepoFile("skills/core/architecture/SKILL.md");

    expect(markdown).toContain("NO DEEPENING OPPORTUNITY WITHOUT A NAMED MODULE");
    expect(markdown).toContain("deletion test");
    expect(markdown).toContain("interface as the test surface");
  });

  test("office-hours preserves diagnostic discipline from the source skill", () => {
    const markdown = readRepoFile("skills/core/office-hours/SKILL.md");

    expect(markdown).toContain("NO OFFICE HOURS WITHOUT MODE, PREMISES, AND A NEXT ASSIGNMENT");
    expect(markdown).toContain("Ask one question at a time");
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

  test("Brewva project skills preserve the accepted Bub-shaped product vision", () => {
    const criticalRules = readRepoFile("skills/project/shared/critical-rules.md");
    const sourceMap = readRepoFile("skills/project/shared/source-map.md");
    const antiPatterns = readRepoFile("skills/project/shared/anti-patterns.md");
    const runtimeArtifacts = readRepoFile("skills/project/shared/runtime-artifacts.md");
    const implementationOverlay = readRepoFile("skills/project/overlays/implementation/SKILL.md");
    const reviewOverlay = readRepoFile("skills/project/overlays/review/SKILL.md");
    const forensicsOverlay = readRepoFile("skills/project/overlays/runtime-forensics/SKILL.md");

    expect(criticalRules).toContain("receive -> orient -> authorize -> act -> verify -> continue");
    expect(criticalRules).toContain("same evidence, different authority");
    expect(criticalRules).toContain("Work Card");
    expect(criticalRules).toContain("attention_options");
    expect(criticalRules).toContain("attention_consume");
    expect(criticalRules).toContain("session.continuationAnchor");
    expect(criticalRules).toContain("SkillCards");
    expect(criticalRules).toContain("authority posture `none`");
    expect(criticalRules).toContain("verification gate manifest");
    expect(criticalRules).toContain("Advisory extension manifests");

    expect(sourceMap).toContain("packages/brewva-cli/src/operator/inspect/work-card.ts");
    expect(sourceMap).toContain("packages/brewva-tools/src/families/memory/attention-options.ts");
    expect(sourceMap).toContain("packages/brewva-gateway/src/extensions/api.ts");
    expect(sourceMap).toContain(
      "packages/brewva-gateway/src/hosted/internal/turn/runtime-turn-verification-gates.ts",
    );
    expect(sourceMap).toContain(
      "packages/brewva-gateway/src/hosted/internal/context/workbench-context.ts",
    );

    expect(antiPatterns).toContain("forensic inspect dump as the default operator surface");
    expect(antiPatterns).toContain("second memory store");
    expect(antiPatterns).toContain("block_tool");
    expect(antiPatterns).toContain("Run skill");
    expect(antiPatterns).toContain("verifier adapter");

    expect(runtimeArtifacts).toContain("tape_handoff");
    expect(runtimeArtifacts).toContain("Work Card");
    expect(runtimeArtifacts).toContain("continuation anchors");

    expect(implementationOverlay).toContain("Work Card");
    expect(implementationOverlay).toContain("Attention Options");
    expect(implementationOverlay).toContain("continuation");

    expect(reviewOverlay).toContain("Work Card");
    expect(reviewOverlay).toContain("attention option");
    expect(reviewOverlay).toContain("verification gate manifest");
    expect(reviewOverlay).toContain("advisory extension");

    expect(forensicsOverlay).toContain("Work Card");
    expect(forensicsOverlay).toContain("drill-down");
    expect(forensicsOverlay).toContain("raw replay");
  });
});
