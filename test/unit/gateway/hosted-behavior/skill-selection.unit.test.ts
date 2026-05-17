import { describe, expect, test } from "bun:test";
import type { SkillDocument } from "@brewva/brewva-runtime/skills";
import {
  buildSkillCatalogContextForPrompt,
  createSkillSelectionLifecycle,
  type SkillSelectionRuntime,
} from "../../../../packages/brewva-gateway/src/hosted/internal/session/host-api-installation.js";

function skill(input: {
  name: string;
  category?: SkillDocument["category"];
  description: string;
  whenToUse?: string;
  markdown?: string;
}): SkillDocument {
  return {
    name: input.name,
    description: input.description,
    category: input.category ?? "core",
    filePath: `/skills/${input.name}/SKILL.md`,
    baseDir: `/skills/${input.name}`,
    markdown: input.markdown ?? `# ${input.name}`,
    authoredMarkdown: input.markdown ?? `# ${input.name}`,
    inheritedMarkdown: "",
    card: {
      name: input.name,
      category: input.category ?? "core",
      description: input.description,
      ...(input.whenToUse ? { selection: { whenToUse: input.whenToUse } } : {}),
    },
    resources: { references: [], scripts: [], invariants: [] },
    authoredResources: { references: [], scripts: [], invariants: [] },
    inheritedResources: { references: [], scripts: [], invariants: [] },
    projectGuidance: [],
    overlayFiles: [],
  };
}

function zh(...codePoints: number[]): string {
  return String.fromCodePoint(...codePoints);
}

function createRuntime(skills: SkillDocument[]): {
  runtime: SkillSelectionRuntime;
  events: Array<{ sessionId: string; type: string; payload?: object }>;
} {
  const events: Array<{ sessionId: string; type: string; payload?: object }> = [];
  return {
    events,
    runtime: {
      inspect: {
        skills: {
          catalog: {
            list: () => skills,
            get: (name) => skills.find((entry) => entry.name === name),
          },
        },
        events: {
          records: {
            query: (sessionId, query) =>
              events
                .filter((event) => event.sessionId === sessionId && event.type === query.type)
                .map((event) => ({ payload: event.payload })),
          },
        },
      },
    },
  };
}

function createSkillCatalog(): SkillDocument[] {
  return [
    skill({
      name: "architecture",
      description:
        "Assess module depth, interface burden, boundary quality, seam placement, and testability.",
      whenToUse:
        "Use when a task asks for architecture improvement, refactoring opportunities, boundary quality, testability improvement, or codebase AI-navigability.",
    }),
    skill({
      name: "repository-analysis",
      description:
        "Build a reliable repository snapshot, impact map, path-grounded evidence, and boundary mapping before design, debugging, or review.",
      whenToUse:
        "Use when the task needs repository orientation, impact analysis, or boundary mapping before design, debugging, review, or execution.",
    }),
    skill({
      name: "runtime-forensics",
      category: "operator",
      description:
        "Inspect runtime artifacts, event streams, ledgers, projections, WAL evidence, and execution traces.",
      whenToUse:
        "Use when the task asks what happened at runtime and the answer must come from artifacts, event streams, ledgers, projections, or WAL evidence.",
    }),
    skill({
      name: "internal-probe",
      category: "internal",
      description: "Internal-only probe.",
    }),
  ];
}

function expectObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Expected ${label} to be an object`);
  }
  return value as Record<string, unknown>;
}

function expectPositiveNumber(value: unknown, label: string): void {
  if (typeof value !== "number") {
    throw new Error(`Expected ${label} to be a number`);
  }
  expect(value).toBeGreaterThan(0);
}

describe("hosted advisory skill catalog context", () => {
  test("renders every prompt-visible SkillCard and preserves all names", () => {
    const { runtime } = createRuntime(createSkillCatalog());
    const prompt = [
      zh(0x67b6, 0x6784, 0x8bbe, 0x8ba1),
      zh(0x8fb9, 0x754c),
      zh(0x8fc7, 0x5ea6, 0x590d, 0x6742),
      zh(0x94fe, 0x8def),
    ].join(" ");

    const result = buildSkillCatalogContextForPrompt({
      runtime,
      prompt,
    });

    expect(result.availableSkills.map((entry) => entry.name)).toEqual([
      "architecture",
      "repository-analysis",
      "runtime-forensics",
    ]);
    expect(result.receipt.explicitSkillMentions).toEqual([]);
    expect(result.renderedSection).toContain("# Available Brewva Skills");
    expect(result.renderedSection).toContain("If the user mentions $skill-name");
    expect(result.renderedSection).toContain("## architecture");
    expect(result.renderedSection).toContain("## repository-analysis");
    expect(result.renderedSection).toContain("## runtime-forensics");
    expect(result.renderedSection).not.toContain("internal-probe");
  });

  test("records explicit $skill mentions without using them to limit catalog injection", () => {
    const { runtime } = createRuntime(createSkillCatalog());

    const result = buildSkillCatalogContextForPrompt({
      runtime,
      prompt: "Please use $architecture for this design pass.",
    });

    expect(result.receipt.explicitSkillMentions).toEqual([
      {
        name: "architecture",
        category: "core",
        reason: "explicit_mention",
        filePath: "/skills/architecture/SKILL.md",
      },
    ]);
    expect(result.renderedSection).toContain("## architecture");
    expect(result.renderedSection).toContain("## repository-analysis");
    expect(result.renderedSection).toContain("## runtime-forensics");
  });

  test("bounds prompt context by truncating descriptions while preserving names", () => {
    const { runtime } = createRuntime(createSkillCatalog());

    const result = buildSkillCatalogContextForPrompt({
      runtime,
      prompt: "Need architecture review.",
      tokenBudget: 80,
    });

    expect(result.receipt.renderedSkillContext.truncated).toBe(true);
    expect(result.renderedSection).toContain("## architecture");
    expect(result.renderedSection).toContain("## repository-analysis");
    expect(result.renderedSection).toContain("## runtime-forensics");
  });

  test("records catalog evidence without changing tool authority", () => {
    const { runtime, events } = createRuntime(createSkillCatalog());
    const lifecycle = createSkillSelectionLifecycle(runtime, {
      record: (input) => {
        events.push({
          sessionId: input.sessionId,
          type: "skill_selection_recorded",
          payload: input.receipt,
        });
      },
    });

    const result = lifecycle.beforeAgentStart(
      { prompt: "Use $architecture", systemPrompt: "base" },
      { sessionManager: { getSessionId: () => "skill-selection-event" } },
    );

    expect(result?.systemPrompt).toContain("Available Brewva Skills");
    expect(result?.systemPrompt).toContain("architecture");
    expect(result?.systemPrompt).toContain("repository-analysis");
    expect(result?.message?.customType).toBe("brewva-skill-selection");
    expect(result?.message?.display).toBe(false);
    expect(result?.message?.excludeFromContext).toBe(true);
    expect(typeof result?.message?.content).toBe("string");
    expect(result?.message?.content).toContain("Available Brewva Skills: 3");
    expect(result?.message?.content).toContain("Explicit Brewva Skill Mentions: architecture");
    expect(result?.message?.content).toContain("Mode: available_catalog_prompt_context");
    expect(result?.message?.details).toMatchObject({
      selectionId: expect.stringMatching(/^skill_selection_[a-f0-9]{16}$/u),
      explicitSkillMentionNames: ["architecture"],
      availableSkillCount: 3,
      mode: "available_catalog_prompt_context",
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("skill_selection_recorded");
    const payload = expectObject(events[0]?.payload, "skill selection payload");
    expect(payload).toMatchObject({
      trigger: "user_message",
      mode: "available_catalog_prompt_context",
      explicitSkillMentions: [
        {
          name: "architecture",
          category: "core",
          reason: "explicit_mention",
          filePath: "/skills/architecture/SKILL.md",
        },
      ],
      availableSkillCount: 3,
    });
    const renderedSkillContext = expectObject(
      payload.renderedSkillContext,
      "rendered skill context",
    );
    expect(renderedSkillContext).toMatchObject({
      tokenEncoding: "o200k_base",
      tokenEstimateMethod: "gpt_bpe_approximation",
      tokenEstimateApproximation: true,
    });
    expectPositiveNumber(renderedSkillContext.charCount, "rendered skill char count");
    expectPositiveNumber(renderedSkillContext.estimatedTokens, "rendered skill token estimate");
  });
});
