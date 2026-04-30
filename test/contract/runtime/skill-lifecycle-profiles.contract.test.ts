import { describe, expect, test } from "bun:test";
import type { SkillContract, SkillDocument, SkillReadinessEntry } from "@brewva/brewva-runtime";
import {
  buildSkillHandoffProfile,
  buildSkillSelectionProfile,
  FIELD_TO_PLANE,
  SELECTION_PROFILE_SOURCE_FIELDS,
  type SkillFieldPath,
  type SkillHandoffProfile,
} from "@brewva/brewva-runtime/internal";
import { createContract } from "./skill-contract.helpers.js";

function createSkillDocument(): SkillDocument {
  const contract = {
    ...createContract({
      name: "architecture",
      category: "core",
      description: "forbidden description signal",
      intent: {
        outputs: ["forbidden_output_signal"],
      },
      executionHints: {
        preferredTools: ["forbidden_tool_signal"],
        fallbackTools: ["another_forbidden_tool_signal"],
        costHint: "high",
      },
      effects: {
        allowedEffects: ["workspace_write"],
        deniedEffects: ["local_exec"],
      },
      requires: ["design_spec"],
      consumes: ["implementation_plan"],
    }),
    selection: {
      whenToUse: "Use when module depth and interface locality need review.",
      paths: ["packages/brewva-runtime"],
    },
  } satisfies SkillDocument["contract"];

  return {
    name: "architecture",
    description: "forbidden description signal",
    category: "core",
    filePath: "/tmp/skills/core/architecture/SKILL.md",
    baseDir: "/tmp/skills/core/architecture",
    markdown: [
      "# Architecture",
      "",
      "## Trigger",
      "",
      "- Review module depth before implementation.",
      "- Improve seams before implementation.",
      "",
      "## Workflow",
      "",
      "Do the work.",
    ].join("\n"),
    authoredMarkdown: [
      "# Architecture",
      "",
      "## Trigger",
      "",
      "- Review module depth before implementation.",
      "- Improve seams before implementation.",
    ].join("\n"),
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

function createSkillDocumentWithFieldSentinel(
  field: SkillFieldPath,
  sentinel: string,
): SkillDocument {
  const skill = createSkillDocument();
  const contract = { ...skill.contract } as SkillContract & Record<string, unknown>;
  const mutatedSkill = { ...skill, contract } as SkillDocument & Record<string, unknown>;
  const contractRecord = contract as Record<string, unknown>;
  const skillRecord = mutatedSkill as Record<string, unknown>;

  switch (field) {
    case "category":
      skillRecord.category = sentinel;
      contractRecord.category = sentinel;
      break;
    case "routing":
      contractRecord.routing = { scope: sentinel };
      break;
    case "selection":
      contractRecord.selection = { removedWideSelectionSignal: sentinel };
      break;
    case "intent":
      contractRecord.intent = { outputs: [sentinel] };
      break;
    case "effects":
      contractRecord.effects = { allowedEffects: [sentinel], deniedEffects: [sentinel] };
      break;
    case "resources":
      contractRecord.resources = { defaultLease: { sentinel }, hardCeiling: { sentinel } };
      break;
    case "executionHints":
      contractRecord.executionHints = {
        preferredTools: [sentinel],
        fallbackTools: [sentinel],
        costHint: sentinel,
      };
      break;
    case "composableWith":
      contractRecord.composableWith = [sentinel];
      break;
    case "consumes":
      contractRecord.consumes = [sentinel];
      break;
    case "requires":
      contractRecord.requires = [sentinel];
      break;
    case "stability":
      contractRecord.stability = sentinel;
      break;
    case "description":
      skillRecord.description = sentinel;
      contractRecord.description = sentinel;
      break;
    default:
      throw new Error(`Unsupported non-selection sentinel field in test: ${field}`);
  }

  return mutatedSkill;
}

describe("skill lifecycle profiles", () => {
  test("selection profile exposes only scorer-approved source fields", () => {
    const profile = buildSkillSelectionProfile(createSkillDocument());

    expect(profile.forScorer).toEqual({
      name: "architecture",
      whenToUse: "Use when module depth and interface locality need review.",
      paths: ["packages/brewva-runtime"],
      triggerBullets: [
        "Review module depth before implementation.",
        "Improve seams before implementation.",
      ],
    });
    expect(SELECTION_PROFILE_SOURCE_FIELDS).toEqual([
      "name",
      "selection.whenToUse",
      "selection.paths",
      "authoredMarkdown.Trigger",
    ]);

    const serializedScorer = JSON.stringify(profile.forScorer);
    expect(serializedScorer).not.toContain("forbidden description signal");
    expect(serializedScorer).not.toContain("forbidden_output_signal");
    expect(serializedScorer).not.toContain("forbidden_tool_signal");
    expect(serializedScorer).not.toContain("workspace_write");
    expect(serializedScorer).not.toContain("high");
  });

  test("field ledger keeps hit-rate fields narrower than the skill contract", () => {
    expect(FIELD_TO_PLANE.selection).not.toContain("selection");
    expect(FIELD_TO_PLANE["selection.whenToUse"]).toEqual(["selection"]);
    expect(FIELD_TO_PLANE["selection.paths"]).toEqual(["selection"]);
    expect(FIELD_TO_PLANE["authoredMarkdown.Trigger"]).toEqual(["selection"]);
    expect(FIELD_TO_PLANE.name).toEqual(["discovery", "selection", "activation", "handoff"]);
    expect(FIELD_TO_PLANE.description).not.toContain("selection");
    expect(FIELD_TO_PLANE.intent).not.toContain("selection");
    expect(FIELD_TO_PLANE.effects).not.toContain("selection");
    expect(FIELD_TO_PLANE.resources).not.toContain("selection");
    expect(FIELD_TO_PLANE.executionHints).not.toContain("selection");
  });

  test("non-selection ledger fields cannot leak into the selection profile", () => {
    for (const [field, planes] of Object.entries(FIELD_TO_PLANE) as Array<
      [SkillFieldPath, readonly string[]]
    >) {
      if (planes.includes("selection")) {
        continue;
      }
      const sentinel = `forbidden_${field.replace(/[^a-zA-Z0-9]/g, "_")}_signal`;
      const skill = createSkillDocumentWithFieldSentinel(field, sentinel);
      const serializedProfile = JSON.stringify(buildSkillSelectionProfile(skill));

      expect(serializedProfile).not.toContain(sentinel);
    }
  });

  test("authored trigger bullets do not fall back to effective markdown", () => {
    const skill = {
      ...createSkillDocument(),
      markdown: "## Trigger\n\n- forbidden inherited trigger signal\n",
      authoredMarkdown: "",
    };

    const profile = buildSkillSelectionProfile(skill);

    expect(profile.forScorer.triggerBullets).toEqual([]);
    expect(JSON.stringify(profile)).not.toContain("forbidden inherited trigger signal");
  });

  test("handoff profile is a gate derived from readiness state", () => {
    const readiness: SkillReadinessEntry = {
      name: "implementation",
      category: "core",
      readiness: "blocked",
      score: -1,
      requires: ["design_spec"],
      consumes: ["architecture_assessment"],
      satisfiedRequires: [],
      missingRequires: ["design_spec"],
      satisfiedConsumes: ["architecture_assessment"],
      issues: [],
      sourceSkillNames: ["architecture"],
      sourceEventIds: ["evt-1"],
    };

    const expectedProfile: SkillHandoffProfile = {
      name: "architecture",
      category: "core",
      actionability: "blocked",
      requires: ["design_spec"],
      consumes: ["implementation_plan"],
      missingRequiredInputs: ["design_spec"],
      satisfiedRequiredInputs: [],
      satisfiedConsumedInputs: ["architecture_assessment"],
      blockingIssues: [],
      sourceSkillNames: ["architecture"],
      sourceEventIds: ["evt-1"],
    };

    expect(buildSkillHandoffProfile(createSkillDocument(), readiness)).toEqual(expectedProfile);
    expect(
      buildSkillHandoffProfile(
        {
          name: "architecture",
          category: "core",
          requires: ["design_spec"],
          consumes: ["implementation_plan"],
        },
        readiness,
      ),
    ).toEqual(expectedProfile);
  });
});
