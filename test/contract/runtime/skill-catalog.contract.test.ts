import { describe, expect, test } from "bun:test";
import {
  BrewvaRuntime,
  getSkillOutputContracts,
  listSkillOutputs,
  parseSkillDocument,
  resolveSkillEffectLevel,
} from "@brewva/brewva-runtime";
import { createRuntimeConfig } from "../../helpers/runtime.js";
import { repoRoot } from "./skill-contract.helpers.js";

function createCleanRuntime(): BrewvaRuntime {
  return new BrewvaRuntime({
    cwd: repoRoot(),
    config: createRuntimeConfig(),
  });
}

describe("repository catalog contracts", () => {
  test("runtime loads the new v2 catalog names", () => {
    const runtime = createCleanRuntime();

    expect(runtime.skills.get("repository-analysis")).toBeDefined();
    expect(runtime.skills.get("design")).toBeDefined();
    expect(runtime.skills.get("implementation")).toBeDefined();
    expect(runtime.skills.get("runtime-forensics")).toBeDefined();
    expect(runtime.skills.get("skill-authoring")).toBeDefined();
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
});
