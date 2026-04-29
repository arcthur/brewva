import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  BrewvaRuntime,
  deriveSkillReadiness,
  type SkillDocument,
  type SkillOutputRecord,
} from "@brewva/brewva-runtime";

function writeSkill(
  filePath: string,
  input: {
    name: string;
    outputs?: string[];
    semanticBindings?: Record<string, string>;
    consumes?: string[];
    requires?: string[];
    composableWith?: string[];
  },
): void {
  const outputs = input.outputs ?? [];
  const unboundOutputs = outputs.filter(
    (outputName) => !input.semanticBindings || !input.semanticBindings[outputName],
  );
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(
    filePath,
    [
      "---",
      `name: ${input.name}`,
      `description: ${input.name} skill`,
      "selection:",
      "  when_to_use: Use when the task needs the routed test skill.",
      "  examples: [test skill]",
      "  phases: [align]",
      "intent:",
      `  outputs: [${outputs.join(", ")}]`,
      ...(input.semanticBindings && Object.keys(input.semanticBindings).length > 0
        ? [
            "  semantic_bindings:",
            ...Object.entries(input.semanticBindings).map(
              ([outputName, schemaId]) => `    ${outputName}: ${schemaId}`,
            ),
          ]
        : []),
      ...(unboundOutputs.length > 0
        ? [
            "  output_contracts:",
            ...unboundOutputs.flatMap((outputName) => [
              `    ${outputName}:`,
              "      kind: text",
              "      min_length: 1",
            ]),
          ]
        : []),
      "effects:",
      "  allowed_effects: [workspace_read]",
      "resources:",
      "  default_lease:",
      "    max_tool_calls: 10",
      "    max_tokens: 10000",
      "  hard_ceiling:",
      "    max_tool_calls: 20",
      "    max_tokens: 20000",
      "execution_hints:",
      "  preferred_tools: [read]",
      "  fallback_tools: []",
      `consumes: [${(input.consumes ?? []).join(", ")}]`,
      `requires: [${(input.requires ?? []).join(", ")}]`,
      `composable_with: [${(input.composableWith ?? []).join(", ")}]`,
      "---",
      `# ${input.name}`,
      "",
      "## Intent",
      "",
      "Test skill.",
    ].join("\n"),
    "utf8",
  );
}

function buildReadinessSkill(input: {
  name: string;
  requires?: string[];
  consumes?: string[];
}): SkillDocument {
  return {
    name: input.name,
    description: `${input.name} skill`,
    category: "core",
    filePath: `/tmp/${input.name}/SKILL.md`,
    baseDir: `/tmp/${input.name}`,
    markdown: `# ${input.name}`,
    authoredMarkdown: `# ${input.name}`,
    inheritedMarkdown: "",
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
    contract: {
      name: input.name,
      category: "core",
      selection: {
        whenToUse: "Use when testing readiness derivation.",
        phases: ["align"],
      },
      intent: {
        outputs: [],
      },
      effects: {
        allowedEffects: ["workspace_read"],
      },
      resources: {
        defaultLease: {
          maxToolCalls: 10,
          maxTokens: 10000,
        },
        hardCeiling: {
          maxToolCalls: 20,
          maxTokens: 20000,
        },
      },
      executionHints: {
        preferredTools: ["read"],
      },
      requires: input.requires ?? [],
      consumes: input.consumes ?? [],
    },
  };
}

describe("skill readiness runtime contract", () => {
  test("uses composableWith as a runtime activation gate", () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-skill-composable-"));
    writeSkill(join(workspace, ".brewva/skills/core/composable-active/SKILL.md"), {
      name: "composable-active",
      composableWith: ["composable-next"],
    });
    writeSkill(join(workspace, ".brewva/skills/core/composable-next/SKILL.md"), {
      name: "composable-next",
    });
    writeSkill(join(workspace, ".brewva/skills/core/composable-base/SKILL.md"), {
      name: "composable-base",
    });
    writeSkill(join(workspace, ".brewva/skills/core/composable-requester/SKILL.md"), {
      name: "composable-requester",
      composableWith: ["composable-base"],
    });
    writeSkill(join(workspace, ".brewva/skills/core/composable-blocked/SKILL.md"), {
      name: "composable-blocked",
    });

    const runtime = new BrewvaRuntime({ cwd: workspace });

    expect(runtime.authority.skills.activate("active-allows-session", "composable-active").ok).toBe(
      true,
    );
    expect(runtime.authority.skills.activate("active-allows-session", "composable-next").ok).toBe(
      true,
    );

    expect(runtime.authority.skills.activate("next-allows-session", "composable-base").ok).toBe(
      true,
    );
    expect(
      runtime.authority.skills.activate("next-allows-session", "composable-requester").ok,
    ).toBe(true);

    expect(runtime.authority.skills.activate("blocked-session", "composable-base").ok).toBe(true);
    expect(runtime.authority.skills.activate("blocked-session", "composable-blocked")).toEqual({
      ok: false,
      reason:
        "Active skill 'composable-base' must be completed before activating 'composable-blocked'.",
    });
  });

  test("classifies and scores candidate readiness from produced skill outputs", () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-skill-readiness-"));
    writeSkill(join(workspace, ".brewva/skills/core/readiness-producer/SKILL.md"), {
      name: "readiness-producer",
      outputs: ["design_spec"],
    });
    writeSkill(join(workspace, ".brewva/skills/core/readiness-ready/SKILL.md"), {
      name: "readiness-ready",
      consumes: ["design_spec"],
      requires: ["design_spec"],
    });
    writeSkill(join(workspace, ".brewva/skills/core/readiness-available/SKILL.md"), {
      name: "readiness-available",
      consumes: ["verification_evidence"],
      requires: ["design_spec"],
    });
    writeSkill(join(workspace, ".brewva/skills/core/readiness-blocked/SKILL.md"), {
      name: "readiness-blocked",
      consumes: ["review_report"],
      requires: ["missing_plan"],
    });

    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "skill-readiness-classification";

    expect(runtime.authority.skills.activate(sessionId, "readiness-producer").ok).toBe(true);
    expect(
      runtime.authority.skills.complete(sessionId, {
        design_spec: "Use artifact readiness as a runtime contract.",
      }).ok,
    ).toBe(true);

    const readiness = runtime.inspect.skills.getReadiness(sessionId);
    const testReadiness = readiness.filter((entry) => entry.name.startsWith("readiness-"));

    expect(testReadiness.map((entry) => entry.name)).toEqual([
      "readiness-ready",
      "readiness-available",
      "readiness-blocked",
    ]);
    expect(testReadiness.map((entry) => [entry.name, entry.readiness, entry.score])).toEqual([
      ["readiness-ready", "ready", 15],
      ["readiness-available", "available", 3],
      ["readiness-blocked", "blocked", -1],
    ]);
    expect(testReadiness[0]).toEqual(
      expect.objectContaining({
        satisfiedRequires: ["design_spec"],
        satisfiedConsumes: ["design_spec"],
        missingRequires: [],
      }),
    );
    expect(testReadiness[2]).toEqual(
      expect.objectContaining({
        satisfiedRequires: [],
        satisfiedConsumes: [],
        missingRequires: ["missing_plan"],
      }),
    );
  });

  test("preserves semantic-bound consumed output issues on readiness entries", () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-skill-readiness-semantic-"));
    writeSkill(join(workspace, ".brewva/skills/core/semantic-risk-producer/SKILL.md"), {
      name: "semantic-risk-producer",
      outputs: ["risk_register"],
      semanticBindings: {
        risk_register: "planning.risk_register.v2",
      },
    });
    writeSkill(join(workspace, ".brewva/skills/core/semantic-risk-consumer/SKILL.md"), {
      name: "semantic-risk-consumer",
      consumes: ["risk_register"],
      requires: ["risk_register"],
    });

    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "skill-readiness-semantic-issues";

    expect(runtime.authority.skills.activate(sessionId, "semantic-risk-producer").ok).toBe(true);
    expect(
      runtime.authority.skills.complete(sessionId, {
        risk_register: [
          {
            risk: "Downstream consumers need canonical evidence references.",
            category: "runtime_coordination",
            severity: "high",
            mitigation: "Surface normalization issues in readiness.",
            owner_lane: "review-correctness",
          },
        ],
      }).ok,
    ).toBe(true);

    const readiness = runtime.inspect.skills.getReadiness(sessionId, {
      targetSkillName: "semantic-risk-consumer",
    });

    expect(readiness).toEqual([
      expect.objectContaining({
        name: "semantic-risk-consumer",
        readiness: "blocked",
        missingRequires: ["risk_register"],
        sourceSkillNames: ["semantic-risk-producer"],
        issues: expect.arrayContaining([
          expect.objectContaining({
            outputName: "risk_register",
            path: "risk_register[0].required_evidence",
            tier: "tier_b",
            blockingConsumer: "workflow",
            schemaId: "planning.risk_register.v2",
          }),
        ]),
      }),
    ]);
  });

  test("normalizes completed outputs once before scoring readiness candidates", () => {
    let outputEnumerationCount = 0;
    const trackedOutputs = new Proxy(
      {
        design_spec: "Shared design context for many downstream skills.",
      },
      {
        ownKeys(target) {
          outputEnumerationCount += 1;
          return Reflect.ownKeys(target);
        },
      },
    );
    const skillOutputs = new Map<string, SkillOutputRecord>([
      [
        "producer",
        {
          skillName: "producer",
          completedAt: 1,
          outputs: trackedOutputs,
        },
      ],
    ]);
    const skills = [
      buildReadinessSkill({ name: "producer" }),
      buildReadinessSkill({ name: "consumer-a", requires: ["design_spec"] }),
      buildReadinessSkill({ name: "consumer-b", requires: ["design_spec"] }),
      buildReadinessSkill({ name: "consumer-c", consumes: ["design_spec"] }),
    ];

    const readiness = deriveSkillReadiness({ skills, skillOutputs });

    expect(readiness.map((entry) => entry.name)).toEqual([
      "consumer-c",
      "consumer-a",
      "consumer-b",
    ]);
    expect(outputEnumerationCount).toBeLessThanOrEqual(2);
  });

  test("returns a targeted readiness entry for one skill", () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-skill-readiness-target-"));
    writeSkill(join(workspace, ".brewva/skills/core/target-consumer/SKILL.md"), {
      name: "target-consumer",
      requires: ["design_spec"],
    });

    const runtime = new BrewvaRuntime({ cwd: workspace });
    const readiness = runtime.inspect.skills.getReadiness("skill-readiness-target", {
      targetSkillName: "target-consumer",
    });

    expect(readiness).toEqual([
      expect.objectContaining({
        name: "target-consumer",
        readiness: "blocked",
        missingRequires: ["design_spec"],
      }),
    ]);
  });
});
