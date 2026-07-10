import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { parseSkillDocument } from "@brewva/brewva-vocabulary/session";
import { extractInstructedToolNames } from "../../../packages/brewva-gateway/src/hosted/internal/session/skills/skill-selection.js";

// The calibration-report skill is the auto-research assembly's methodology
// carrier: when it renders, the tools its document instructs must surface
// through the instructed-tool pull channel. This test wires the REAL file
// through the REAL parser and extractor so a doc edit that breaks the chain
// (renaming a tool, dropping the backticks) fails here instead of silently
// starving the scheduled session.
describe("calibration-report skill contract", () => {
  const skillPath = resolve(import.meta.dir, "../../../skills/core/calibration-report/SKILL.md");

  test("parses as a valid skill document with the expected identity", () => {
    const doc = parseSkillDocument(skillPath, "core");
    expect(doc.name).toBe("calibration-report");
    expect(doc.card.selection?.whenToUse).toContain("advisory surfaces");
  });

  test("instructs exactly the tools the pass procedure needs", () => {
    const doc = parseSkillDocument(skillPath, "core");
    expect(extractInstructedToolNames(doc.markdown)).toEqual(["exec", "workbench_note"]);
  });

  test("carries the report-only boundary in its body", () => {
    const doc = parseSkillDocument(skillPath, "core");
    expect(doc.markdown).toContain("never");
    expect(doc.markdown).toMatch(/rule changes land as reviewed code/);
  });
});
