import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createBrewvaRuntime } from "@brewva/brewva-runtime";
import type { BrewvaHostedRuntimePort } from "@brewva/brewva-runtime";
import {
  buildSkillSelectionProfile,
  getSkillOutputContracts,
  getSkillSemanticBindings,
  hasSelectionProfileSignals,
  listSkillOutputs,
  parseSkillDocument,
  resolveSkillEffectLevel,
} from "@brewva/brewva-runtime/skills";
import { requireDefined } from "../../helpers/assertions.js";
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

function createCleanRuntime(): BrewvaHostedRuntimePort {
  return createBrewvaRuntime({
    cwd: workspace,
    config: createRuntimeConfig(),
  }).hosted;
}

describe("repository catalog contracts", () => {
  test("runtime loads the new v2 catalog names", () => {
    const runtime = createCleanRuntime();
    const loadedSkillNames = runtime.inspect.skills.catalog.list().map((skill) => skill.name);

    expect(loadedSkillNames).toEqual(
      expect.arrayContaining([
        "repository-analysis",
        "architecture",
        "office-hours",
        "discovery",
        "learning-research",
        "strategy",
        "plan",
        "prep",
        "implementation",
        "knowledge-capture",
        "extract",
        "git",
        "verifier",
        "ship",
        "retro",
        "runtime-forensics",
        "skill-authoring",
      ]),
    );
  });

  test("renamed skill identities load under their new public names", () => {
    const runtime = createCleanRuntime();

    for (const name of ["plan", "strategy", "prep", "extract", "git"]) {
      expect(runtime.inspect.skills.catalog.get(name)?.name).toBe(name);
    }
  });

  test("review remains read_only and standalone by contract", () => {
    const review = parseSkillDocument(`${repoRoot()}/skills/core/review/SKILL.md`, "core");

    expect(resolveSkillEffectLevel(review.contract)).toBe("read_only");
    expect(review.contract.requires).toEqual([]);
    expect(review.contract.routing?.scope).toBe("core");
    expect(listSkillOutputs(review.contract)).toEqual(
      expect.arrayContaining(["review_report", "review_findings", "merge_decision"]),
    );
    expect(Object.keys(getSkillSemanticBindings(review.contract) ?? {}).toSorted()).toEqual([
      "merge_decision",
      "review_findings",
      "review_report",
    ]);
    expect(getSkillOutputContracts(review.contract)).toEqual({});
  });

  test("built-in base skills cover declared outputs through authored contracts or semantic bindings", () => {
    const runtime = createCleanRuntime();
    const missing = runtime.inspect.skills.catalog.list().flatMap((skill) => {
      const outputs = listSkillOutputs(skill.contract);
      if (outputs.length === 0) {
        return [];
      }
      const contracts = getSkillOutputContracts(skill.contract);
      const semanticBindings = getSkillSemanticBindings(skill.contract) ?? {};
      const uncovered = outputs.filter(
        (name) =>
          !Object.prototype.hasOwnProperty.call(contracts, name) &&
          !Object.prototype.hasOwnProperty.call(semanticBindings, name),
      );
      return uncovered.length === 0 ? [] : [`${skill.name}:${uncovered.join(",")}`];
    });

    expect(missing).toEqual([]);
  });

  test("semantic-bound base skills keep canonical schemas in semantic bindings instead of producer contracts", () => {
    const plan = parseSkillDocument(`${repoRoot()}/skills/core/plan/SKILL.md`, "core");
    const implementation = parseSkillDocument(
      `${repoRoot()}/skills/core/implementation/SKILL.md`,
      "core",
    );
    const review = parseSkillDocument(`${repoRoot()}/skills/core/review/SKILL.md`, "core");
    const verifier = parseSkillDocument(`${repoRoot()}/skills/core/verifier/SKILL.md`, "core");
    const ship = parseSkillDocument(`${repoRoot()}/skills/core/ship/SKILL.md`, "core");

    for (const parsed of [plan, implementation, review, verifier, ship]) {
      expect(parsed.contract.intent?.outputContracts).toBe(undefined);
      expect(Object.keys(parsed.contract.intent?.semanticBindings ?? {}).length).toBeGreaterThan(0);
      expect(getSkillOutputContracts(parsed.contract)).toEqual({});
    }
  });

  test("all routable built-in skills expose at least one selection profile signal", () => {
    const runtime = createCleanRuntime();
    const missing = runtime.inspect.skills.catalog.list().flatMap((skill) => {
      if (!runtime.inspect.skills.catalog.getLoadReport().routableSkills.includes(skill.name)) {
        return [];
      }
      if (!hasSelectionProfileSignals(buildSkillSelectionProfile(skill))) {
        return [`${skill.name}:selection`];
      }
      return [];
    });

    expect(missing).toEqual([]);
  });

  test("runtime injects shared authored behavior as inherited skill guidance", () => {
    const runtime = createCleanRuntime();
    const plan = requireDefined(
      runtime.inspect.skills.catalog.get("plan"),
      "expected built-in plan skill",
    );

    const inheritedReferences = plan.inheritedResources.references;
    const authoredReferences = plan.authoredResources.references;

    expect(inheritedReferences.some((entry) => entry.endsWith("authored-behavior.md"))).toBe(true);
    expect(authoredReferences.some((entry) => entry.endsWith("authored-behavior.md"))).toBe(false);
    expect(plan.markdown).toContain("Runtime Skill Guidance: authored-behavior");
    expect(plan.authoredMarkdown).not.toContain("Runtime Skill Guidance: authored-behavior");
  });

  test("core workflow skills declare the documented handoff graph", () => {
    const discovery = parseSkillDocument(`${repoRoot()}/skills/core/discovery/SKILL.md`, "core");
    const repositoryAnalysis = parseSkillDocument(
      `${repoRoot()}/skills/core/repository-analysis/SKILL.md`,
      "core",
    );
    const architecture = parseSkillDocument(
      `${repoRoot()}/skills/core/architecture/SKILL.md`,
      "core",
    );
    const officeHours = parseSkillDocument(
      `${repoRoot()}/skills/core/office-hours/SKILL.md`,
      "core",
    );
    const strategy = parseSkillDocument(`${repoRoot()}/skills/core/strategy/SKILL.md`, "core");
    const learningResearch = parseSkillDocument(
      `${repoRoot()}/skills/core/learning-research/SKILL.md`,
      "core",
    );
    const plan = parseSkillDocument(`${repoRoot()}/skills/core/plan/SKILL.md`, "core");
    const verifier = parseSkillDocument(`${repoRoot()}/skills/core/verifier/SKILL.md`, "core");
    const ship = parseSkillDocument(`${repoRoot()}/skills/core/ship/SKILL.md`, "core");
    const retro = parseSkillDocument(`${repoRoot()}/skills/core/retro/SKILL.md`, "core");
    const knowledgeCapture = parseSkillDocument(
      `${repoRoot()}/skills/core/knowledge-capture/SKILL.md`,
      "core",
    );
    const selfImprove = parseSkillDocument(
      `${repoRoot()}/skills/meta/self-improve/SKILL.md`,
      "meta",
    );

    expect(listSkillOutputs(repositoryAnalysis.contract)).toEqual(
      expect.arrayContaining(["repository_snapshot", "impact_map", "planning_posture"]),
    );
    expect(architecture.contract.consumes).toEqual(
      expect.arrayContaining([
        "repository_snapshot",
        "impact_map",
        "review_findings",
        "retro_findings",
      ]),
    );
    expect(listSkillOutputs(architecture.contract)).toEqual(
      expect.arrayContaining([
        "architecture_assessment",
        "deepening_opportunities",
        "interface_exploration_brief",
      ]),
    );
    expect(listSkillOutputs(officeHours.contract)).toEqual(
      expect.arrayContaining([
        "office_hours_brief",
        "mode_decision",
        "premise_challenge",
        "approach_options",
        "next_assignment",
      ]),
    );
    expect(listSkillOutputs(discovery.contract)).toEqual(
      expect.arrayContaining(["problem_frame", "scope_recommendation", "design_seed"]),
    );
    expect(discovery.contract.consumes).toEqual(
      expect.arrayContaining([
        "office_hours_brief",
        "premise_challenge",
        "approach_options",
        "next_assignment",
      ]),
    );
    expect(strategy.contract.consumes).toEqual(
      expect.arrayContaining([
        "office_hours_brief",
        "premise_challenge",
        "approach_options",
        "next_assignment",
        "problem_frame",
        "user_pains",
        "scope_recommendation",
        "design_seed",
        "open_questions",
      ]),
    );
    expect(plan.contract.consumes).toEqual(
      expect.arrayContaining([
        "planning_posture",
        "strategy_review",
        "scope_decision",
        "strategic_risks",
        "knowledge_brief",
        "precedent_refs",
        "preventive_checks",
        "precedent_query_summary",
        "precedent_consult_status",
      ]),
    );
    expect(learningResearch.contract.consumes).toEqual(
      expect.arrayContaining(["repository_snapshot", "impact_map", "planning_posture"]),
    );
    expect(verifier.contract.consumes).toEqual(
      expect.arrayContaining([
        "execution_plan",
        "risk_register",
        "implementation_targets",
        "review_report",
        "review_findings",
      ]),
    );
    expect(ship.contract.consumes).toEqual(
      expect.arrayContaining([
        "verifier_report",
        "verifier_verdict",
        "review_report",
        "verification_evidence",
      ]),
    );
    expect(retro.contract.consumes).toEqual(
      expect.arrayContaining(["ship_report", "ship_decision", "verifier_report"]),
    );
    expect(knowledgeCapture.contract.consumes).toEqual(
      expect.arrayContaining(["review_findings", "retro_findings", "verification_evidence"]),
    );
    expect(selfImprove.contract.consumes).toEqual(
      expect.arrayContaining(["retro_findings", "ship_report"]),
    );
    expect(listSkillOutputs(strategy.contract)).toEqual(
      expect.arrayContaining([
        "strategy_review",
        "scope_decision",
        "planning_posture",
        "strategic_risks",
      ]),
    );
  });
});
