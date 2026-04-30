import { describe, expect, test } from "bun:test";
import {
  deriveSkillDiagnoses,
  type SkillDiagnosisSet,
  type SkillFirstRuntimeLike,
} from "@brewva/brewva-gateway/runtime-plugins";
import type {
  LoadableSkillCategory,
  SkillDocument,
  SkillReadinessEntry,
  SkillRegistryLoadReport,
  SkillRoutingScope,
  TaskPhase,
} from "@brewva/brewva-runtime";
import {
  buildSkillRoutingCatalogEntry,
  buildSkillSelectionProfile,
  hasSelectionProfileSignals,
} from "@brewva/brewva-runtime/internal";
import { createContract } from "../runtime/skill-contract.helpers.js";

type RoutingSkillInput = {
  name: string;
  category?: LoadableSkillCategory;
  whenToUse: string;
  paths?: string[];
  triggerBullets?: string[];
  requires?: string[];
  consumes?: string[];
};

type TaskStateInput = {
  goal: string;
  expectedBehavior?: string;
  constraints?: string[];
  targets?: {
    files?: string[];
    symbols?: string[];
  };
  phase?: TaskPhase;
};

function createRoutingSkill(input: RoutingSkillInput): SkillDocument {
  const category = input.category ?? "core";
  const authoredMarkdown =
    input.triggerBullets && input.triggerBullets.length > 0
      ? [
          "# Skill",
          "",
          "## Trigger",
          "",
          ...input.triggerBullets.map((entry) => `- ${entry}`),
        ].join("\n")
      : "# Skill";
  const contract = {
    ...createContract({
      name: input.name,
      category,
      routing: { scope: category === "domain" ? "domain" : "core" },
      requires: input.requires,
      consumes: input.consumes,
    }),
    selection: {
      whenToUse: input.whenToUse,
      ...(input.paths ? { paths: input.paths } : {}),
    },
  } satisfies SkillDocument["contract"];

  return {
    name: input.name,
    description: `${input.name} skill`,
    category,
    filePath: `/tmp/skills/${category}/${input.name}/SKILL.md`,
    baseDir: `/tmp/skills/${category}/${input.name}`,
    markdown: authoredMarkdown,
    authoredMarkdown,
    inheritedMarkdown: "",
    contract,
    resources: {
      references: [],
      scripts: [],
      heuristics: [],
      invariants: [],
    },
    authoredResources: {
      references: [],
      scripts: [],
      heuristics: [],
      invariants: [],
    },
    inheritedResources: {
      references: [],
      scripts: [],
      heuristics: [],
      invariants: [],
    },
    projectGuidance: [],
    overlayFiles: [],
  };
}

function createTaskState(
  input: TaskStateInput,
): NonNullable<ReturnType<SkillFirstRuntimeLike["inspect"]["task"]["getState"]>> {
  return {
    spec: {
      goal: input.goal,
      expectedBehavior: input.expectedBehavior,
      constraints: input.constraints,
      targets: input.targets,
    },
    status: input.phase ? { phase: input.phase } : undefined,
    items: [],
    blockers: [],
  };
}

function createRoutingRuntime(input: {
  skills: SkillDocument[];
  taskState?: ReturnType<typeof createTaskState>;
  readiness?: SkillReadinessEntry[];
  activeSkillName?: string;
}): SkillFirstRuntimeLike {
  const routingScopes: SkillRoutingScope[] = ["core", "domain"];
  const isRoutableSkill = (skill: SkillDocument): boolean => {
    const scope = skill.contract.routing?.scope;
    return (
      typeof scope === "string" &&
      routingScopes.includes(scope) &&
      hasSelectionProfileSignals(buildSkillSelectionProfile(skill))
    );
  };
  const buildLoadReport = (): SkillRegistryLoadReport => {
    const loadedSkills = input.skills.map((skill) => skill.name);
    const routableSkills = input.skills.filter(isRoutableSkill).map((skill) => skill.name);

    return {
      roots: [],
      loadedSkills,
      routingEnabled: true,
      routingScopes,
      routableSkills,
      hiddenSkills: loadedSkills.filter((name) => !routableSkills.includes(name)),
      overlaySkills: [],
      projectGuidance: [],
      categories: {
        core: [],
        domain: [],
        operator: [],
        meta: [],
        internal: [],
      },
    };
  };

  return {
    inspect: {
      skills: {
        listForRouting: () =>
          input.skills.filter(isRoutableSkill).map((skill) => buildSkillRoutingCatalogEntry(skill)),
        getActive: () => (input.activeSkillName ? { name: input.activeSkillName } : undefined),
        getReadiness: () => input.readiness ?? [],
        getLatestFailure: () => undefined,
        getLoadReport: buildLoadReport,
      },
      task: {
        getState: () => input.taskState,
      },
    },
  };
}

function expectTopSkill(
  diagnosis: SkillDiagnosisSet,
  expectedName: string,
  expectedReason: string,
): void {
  expect(diagnosis.candidates[0]?.name).toBe(expectedName);
  expect(diagnosis.candidates[0]?.basis).toBe("selection_profile");
  expect(diagnosis.candidates[0]?.reasons.join("\n")).toContain(expectedReason);
}

const architecture = createRoutingSkill({
  name: "architecture",
  whenToUse: "Assess architecture depth.",
  triggerBullets: ["Review module depth and interface locality."],
});

const implementation = createRoutingSkill({
  name: "implementation",
  whenToUse: "Implement selected code change.",
  triggerBullets: ["Apply planned implementation safely."],
  requires: ["design_spec"],
});

const review = createRoutingSkill({
  name: "review",
  whenToUse: "Review code changes.",
  triggerBullets: ["Inspect diff correctness and missing tests."],
});

const frontendDesign = createRoutingSkill({
  name: "frontend-design",
  category: "domain",
  whenToUse: "Build polished frontend UI.",
  paths: ["packages/brewva-cli/src/ui"],
});

const officeHours = createRoutingSkill({
  name: "office-hours",
  whenToUse: "Diagnose broad product idea.",
  triggerBullets: ["Clarify premise, wedge, and next assignment."],
});

describe("skill routing target-semantics eval fixtures", () => {
  test("no TaskSpec bootstrap gates implementation instead of guessing a skill", () => {
    const diagnosis = deriveSkillDiagnoses(
      createRoutingRuntime({ skills: [architecture, implementation, review] }),
      {
        sessionId: "routing-eval-bootstrap",
        prompt: "Implement the selected fix now.",
      },
    );

    expect(diagnosis.activationPosture).toEqual({
      kind: "require_task_spec",
      boundary: "mutation",
    });
    expect(diagnosis.candidates).toEqual([]);
  });

  test("architecture task routes to architecture from selection prose", () => {
    const diagnosis = deriveSkillDiagnoses(
      createRoutingRuntime({
        skills: [architecture, implementation, review],
        taskState: createTaskState({
          goal: "Assess architecture depth.",
          expectedBehavior: "Review module depth and interface locality.",
          phase: "investigate",
        }),
      }),
      {
        sessionId: "routing-eval-architecture",
        prompt: "Assess the architecture before coding.",
      },
    );

    expectTopSkill(diagnosis, "architecture", "Assess architecture depth.");
  });

  test("implementation routes only after TaskSpec is present", () => {
    const diagnosis = deriveSkillDiagnoses(
      createRoutingRuntime({
        skills: [architecture, implementation, review],
        readiness: [
          {
            name: "implementation",
            category: "core",
            readiness: "blocked",
            score: -1,
            requires: ["design_spec"],
            consumes: [],
            satisfiedRequires: [],
            missingRequires: ["design_spec"],
            satisfiedConsumes: [],
            issues: [],
            sourceSkillNames: [],
            sourceEventIds: [],
          },
        ],
        taskState: createTaskState({
          goal: "Implement selected code change.",
          expectedBehavior: "Apply planned implementation safely.",
          phase: "execute",
        }),
      }),
      {
        sessionId: "routing-eval-implementation",
        prompt: "Implement the selected fix now.",
      },
    );

    expectTopSkill(diagnosis, "implementation", "Implement selected code change.");
    expect(diagnosis.activationPosture).toMatchObject({
      kind: "require_skill_inputs",
      skillName: "implementation",
      boundary: "execute",
    });
  });

  test("broad idea routes to office-hours when TaskSpec captures premise diagnosis", () => {
    const diagnosis = deriveSkillDiagnoses(
      createRoutingRuntime({
        skills: [officeHours, architecture, review],
        taskState: createTaskState({
          goal: "Diagnose broad product idea.",
          expectedBehavior: "Clarify premise, wedge, and next assignment.",
          phase: "align",
        }),
      }),
      {
        sessionId: "routing-eval-broad-idea",
        prompt: "I have a broad product idea and need the first useful framing.",
      },
    );

    expectTopSkill(diagnosis, "office-hours", "Diagnose broad product idea.");
  });

  test("review task routes to review from selection prose", () => {
    const diagnosis = deriveSkillDiagnoses(
      createRoutingRuntime({
        skills: [architecture, implementation, review],
        taskState: createTaskState({
          goal: "Review code changes.",
          expectedBehavior: "Inspect diff correctness and missing tests.",
          phase: "verify",
        }),
      }),
      {
        sessionId: "routing-eval-review",
        prompt: "Review this patch.",
      },
    );

    expectTopSkill(diagnosis, "review", "Review code changes.");
  });

  test("frontend path routes to frontend-design through selection paths", () => {
    const diagnosis = deriveSkillDiagnoses(
      createRoutingRuntime({
        skills: [frontendDesign, architecture, implementation],
        taskState: createTaskState({
          goal: "Build polished frontend UI.",
          expectedBehavior: "Update the shell UI without layout regressions.",
          targets: { files: ["packages/brewva-cli/src/ui/Shell.tsx"] },
          phase: "execute",
        }),
      }),
      {
        sessionId: "routing-eval-frontend-path",
        prompt: "Refine packages/brewva-cli/src/ui/Shell.tsx.",
      },
    );

    expectTopSkill(diagnosis, "frontend-design", "path:packages/brewva-cli/src/ui");
  });

  test("active skill continuation suppresses new routing candidates", () => {
    const diagnosis = deriveSkillDiagnoses(
      createRoutingRuntime({
        skills: [architecture, implementation, review],
        activeSkillName: "implementation",
        taskState: createTaskState({
          goal: "Review code changes.",
          phase: "verify",
        }),
      }),
      {
        sessionId: "routing-eval-active-continuation",
        prompt: "Review this patch.",
      },
    );

    expect(diagnosis.activeSkillName).toBe("implementation");
    expect(diagnosis.activationPosture).toEqual({ kind: "none" });
    expect(diagnosis.candidates).toEqual([]);
  });

  test("blocked semantic leader requires inputs unless an actionable shortlist candidate exists", () => {
    const implementationReady = createRoutingSkill({
      name: "implementation-ready",
      whenToUse: "Implement selected code change.",
      triggerBullets: ["Apply planned implementation safely."],
      consumes: ["design_spec"],
    });
    const diagnosis = deriveSkillDiagnoses(
      createRoutingRuntime({
        skills: [implementation, implementationReady],
        readiness: [
          {
            name: "implementation",
            category: "core",
            readiness: "blocked",
            score: -1,
            requires: ["design_spec"],
            consumes: [],
            satisfiedRequires: [],
            missingRequires: ["design_spec"],
            satisfiedConsumes: [],
            issues: [],
            sourceSkillNames: [],
            sourceEventIds: [],
          },
          {
            name: "implementation-ready",
            category: "core",
            readiness: "ready",
            score: 12,
            requires: [],
            consumes: ["design_spec"],
            satisfiedRequires: [],
            missingRequires: [],
            satisfiedConsumes: ["design_spec"],
            issues: [],
            sourceSkillNames: ["plan"],
            sourceEventIds: ["evt-plan"],
          },
        ],
        taskState: createTaskState({
          goal: "Implement selected code change.",
          expectedBehavior: "Apply planned implementation safely.",
          phase: "execute",
        }),
      }),
      {
        sessionId: "routing-eval-blocked-handoff",
        prompt: "Implement the selected fix now.",
      },
    );

    expect(diagnosis.candidates[0]?.name).toBe("implementation-ready");
    expect(diagnosis.candidates[0]?.readiness).toBe("ready");
    expect(diagnosis.candidates.map((candidate) => candidate.name)).toContain("implementation");
    expect(
      diagnosis.candidates.find((candidate) => candidate.name === "implementation"),
    ).toMatchObject({
      readiness: "blocked",
      missingRequires: ["design_spec"],
    });
  });

  test("explicit skill name can select the named skill through the name source", () => {
    const diagnosis = deriveSkillDiagnoses(
      createRoutingRuntime({
        skills: [architecture, review],
        taskState: createTaskState({
          goal: "Use the review skill.",
          expectedBehavior: "Review code changes.",
          phase: "verify",
        }),
      }),
      {
        sessionId: "routing-eval-explicit-name",
        prompt: "Use the review skill for this.",
      },
    );

    expectTopSkill(diagnosis, "review", "review");
  });

  test("no credible selection signal produces no skill candidate", () => {
    const diagnosis = deriveSkillDiagnoses(
      createRoutingRuntime({
        skills: [architecture, implementation, review],
        taskState: createTaskState({
          goal: "Summarize lunch menu preferences.",
          expectedBehavior: "List dietary constraints.",
          phase: "align",
        }),
      }),
      {
        sessionId: "routing-eval-no-skill",
        prompt: "Summarize lunch menu preferences.",
      },
    );

    expect(diagnosis.activationPosture).toEqual({ kind: "none" });
    expect(diagnosis.candidates).toEqual([]);
  });
});
