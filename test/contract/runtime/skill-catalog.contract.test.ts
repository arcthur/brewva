import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  BrewvaRuntime,
  getSkillOutputContracts,
  listSkillOutputs,
  parseSkillDocument,
  resolveSkillEffectLevel,
} from "@brewva/brewva-runtime";
import { createRuntimeConfig } from "../../helpers/runtime.js";
import { cleanupWorkspace, createTestWorkspace } from "../../helpers/workspace.js";
import { repoRoot } from "./skill-contract.helpers.js";

let workspace = "";

beforeEach(() => {
  workspace = createTestWorkspace("skill-catalog-contract");
});

afterEach(() => {
  if (workspace) cleanupWorkspace(workspace);
});

function createCleanRuntime(): BrewvaRuntime {
  return new BrewvaRuntime({
    cwd: workspace,
    config: createRuntimeConfig(),
  });
}

describe("repository catalog contracts", () => {
  test("runtime loads the new v2 catalog names", () => {
    const runtime = createCleanRuntime();
    const loadedSkillNames = runtime.skills.list().map((skill) => skill.name);

    expect(loadedSkillNames).toEqual(
      expect.arrayContaining([
        "repository-analysis",
        "discovery",
        "strategy-review",
        "design",
        "implementation",
        "qa",
        "ship",
        "retro",
        "runtime-forensics",
        "skill-authoring",
      ]),
    );
  });

  test("review remains read_only and standalone by contract", () => {
    const review = parseSkillDocument(`${repoRoot()}/skills/core/review/SKILL.md`, "core");

    expect(resolveSkillEffectLevel(review.contract)).toBe("read_only");
    expect(review.contract.requires).toEqual([]);
    expect(review.contract.routing?.scope).toBe("core");
    expect(listSkillOutputs(review.contract)).toEqual(
      expect.arrayContaining(["review_report", "review_findings", "merge_decision"]),
    );
    expect(Object.keys(getSkillOutputContracts(review.contract)).toSorted()).toEqual([
      "merge_decision",
      "review_findings",
      "review_report",
    ]);
  });

  test("built-in base skills declare explicit output contracts for every declared output", () => {
    const runtime = createCleanRuntime();
    const missing = runtime.skills.list().flatMap((skill) => {
      const outputs = listSkillOutputs(skill.contract);
      if (outputs.length === 0) {
        return [];
      }
      const contracts = getSkillOutputContracts(skill.contract);
      const uncovered = outputs.filter(
        (name) => !Object.prototype.hasOwnProperty.call(contracts, name),
      );
      return uncovered.length === 0 ? [] : [`${skill.name}:${uncovered.join(",")}`];
    });

    expect(missing).toEqual([]);
  });

  test("core workflow skills declare the documented handoff graph", () => {
    const discovery = parseSkillDocument(`${repoRoot()}/skills/core/discovery/SKILL.md`, "core");
    const strategyReview = parseSkillDocument(
      `${repoRoot()}/skills/core/strategy-review/SKILL.md`,
      "core",
    );
    const design = parseSkillDocument(`${repoRoot()}/skills/core/design/SKILL.md`, "core");
    const qa = parseSkillDocument(`${repoRoot()}/skills/core/qa/SKILL.md`, "core");
    const ship = parseSkillDocument(`${repoRoot()}/skills/core/ship/SKILL.md`, "core");
    const retro = parseSkillDocument(`${repoRoot()}/skills/core/retro/SKILL.md`, "core");
    const selfImprove = parseSkillDocument(
      `${repoRoot()}/skills/meta/self-improve/SKILL.md`,
      "meta",
    );

    expect(listSkillOutputs(discovery.contract)).toEqual(
      expect.arrayContaining(["problem_frame", "scope_recommendation", "design_seed"]),
    );
    expect(strategyReview.contract.consumes).toEqual(
      expect.arrayContaining([
        "problem_frame",
        "user_pains",
        "scope_recommendation",
        "design_seed",
        "open_questions",
      ]),
    );
    expect(design.contract.consumes).toEqual(
      expect.arrayContaining(["strategy_review", "scope_decision", "strategic_risks"]),
    );
    expect(qa.contract.consumes).toEqual(
      expect.arrayContaining(["risk_register", "review_report", "review_findings"]),
    );
    expect(ship.contract.consumes).toEqual(
      expect.arrayContaining(["qa_report", "qa_verdict", "review_report", "verification_evidence"]),
    );
    expect(retro.contract.consumes).toEqual(
      expect.arrayContaining(["ship_report", "ship_decision", "qa_report"]),
    );
    expect(selfImprove.contract.consumes).toEqual(
      expect.arrayContaining(["retro_findings", "ship_report"]),
    );
    expect(listSkillOutputs(strategyReview.contract)).toEqual(
      expect.arrayContaining(["strategy_review", "scope_decision", "strategic_risks"]),
    );
  });
});
