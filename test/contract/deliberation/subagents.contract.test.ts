import { describe, expect, test } from "bun:test";
import {
  buildDelegationPacketForActiveSkill,
  planDelegationForActiveSkill,
  recommendSubagentProfile,
} from "@brewva/brewva-deliberation";
import type { SkillDocument } from "@brewva/brewva-runtime";

function createSkillDocument(input: {
  name: string;
  outputs?: string[];
  preferredTools?: string[];
  fallbackTools?: string[];
  effectLevel?: "read_only" | "mutation";
}): SkillDocument {
  return {
    name: input.name,
    description: `${input.name} description`,
    category: "core",
    filePath: `/tmp/${input.name}.md`,
    baseDir: "/tmp",
    markdown: `# ${input.name}`,
    contract: {
      name: input.name,
      category: "core",
      intent: {
        outputs: input.outputs ?? [],
      },
      effects: {
        allowedEffects: input.effectLevel === "mutation" ? ["workspace_write"] : ["workspace_read"],
      },
      resources: {
        defaultLease: {
          maxToolCalls: 4,
          maxTokens: 8000,
        },
        hardCeiling: {
          maxToolCalls: 4,
          maxTokens: 8000,
        },
      },
      executionHints: {
        preferredTools: input.preferredTools ?? ["read"],
        fallbackTools: input.fallbackTools ?? ["grep"],
        costHint: "medium",
      },
      stability: "stable",
      routing: {
        scope: "core",
      },
    },
    resources: {
      references: [],
      scripts: [],
      heuristics: [],
      invariants: [],
    },
    sharedContextFiles: [],
    overlayFiles: [],
  };
}

describe("deliberation subagent helpers", () => {
  test("buildDelegationPacketForActiveSkill carries active skill metadata and execution hints", () => {
    const reviewSkill = createSkillDocument({
      name: "review",
      outputs: ["findings", "verification_evidence"],
      preferredTools: ["lsp_diagnostics"],
      fallbackTools: ["grep"],
    });
    const runtime = {
      skills: {
        getActive() {
          return reviewSkill;
        },
      },
    } as any;

    const packet = buildDelegationPacketForActiveSkill({
      runtime,
      sessionId: "session-review",
      objective: "Review the recent runtime changes",
      preferredSkills: ["review"],
    });

    expect(packet).toMatchObject({
      activeSkillName: "review",
      requiredOutputs: ["findings", "verification_evidence"],
      executionHints: {
        preferredTools: ["lsp_diagnostics"],
        fallbackTools: ["grep"],
        preferredSkills: ["review"],
      },
      effectCeiling: {
        posture: "observe",
      },
    });
  });

  test("recommendSubagentProfile prefers patch-worker for mutation-oriented implementation slices", () => {
    const implementationSkill = createSkillDocument({
      name: "implementation",
      outputs: ["change_set"],
      effectLevel: "mutation",
    });
    const runtime = {
      skills: {
        getActive() {
          return implementationSkill;
        },
      },
    } as any;

    const recommendation = recommendSubagentProfile({
      runtime,
      sessionId: "session-implementation",
      objective: "Implement the config patch for delegation merge flow",
      allowMutation: true,
      taskCount: 2,
    });

    expect(recommendation).toMatchObject({
      profile: "patch-worker",
      mode: "parallel",
      posture: "reversible_mutate",
      confidence: "high",
    });
  });

  test("planDelegationForActiveSkill combines profile choice with a packet ready for delegation", () => {
    const designSkill = createSkillDocument({
      name: "design",
      outputs: ["design_brief"],
      preferredTools: ["read_spans"],
      fallbackTools: ["grep"],
    });
    const runtime = {
      skills: {
        getActive() {
          return designSkill;
        },
      },
    } as any;

    const plan = planDelegationForActiveSkill({
      runtime,
      sessionId: "session-design",
      objective: "Map the gateway/session boundaries",
      constraints: ["Stay within gateway and runtime packages."],
      taskCount: 1,
    });

    expect(plan.recommendation.profile).toBe("researcher");
    expect(plan.packet.activeSkillName).toBe("design");
    expect(plan.packet.executionHints?.preferredTools).toEqual(["read_spans"]);
    expect(plan.packet.constraints).toEqual(["Stay within gateway and runtime packages."]);
  });
});
