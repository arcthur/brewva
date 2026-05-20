import { describe, expect, test } from "bun:test";
import type { SkillDocument } from "@brewva/brewva-runtime/protocol";
import {
  buildSkillShortlistContextForPrompt,
  createSkillSelectionLifecycle,
  type SkillSelectionRuntime,
} from "../../../../packages/brewva-gateway/src/hosted/internal/session/host-api-installation.js";

function skill(input: {
  name: string;
  category?: SkillDocument["category"];
  description: string;
  whenToUse?: string;
  triggers?: readonly string[];
  pathGlobs?: readonly string[];
  markdown?: string;
}): SkillDocument {
  const category = input.category ?? "core";
  return {
    name: input.name,
    description: input.description,
    category,
    filePath: `/skills/${input.name}/SKILL.md`,
    baseDir: `/skills/${input.name}`,
    markdown: input.markdown ?? `# ${input.name}`,
    authoredMarkdown: input.markdown ?? `# ${input.name}`,
    inheritedMarkdown: "",
    card: {
      name: input.name,
      category,
      description: input.description,
      ...(input.whenToUse || input.triggers || input.pathGlobs
        ? {
            selection: {
              ...(input.whenToUse ? { whenToUse: input.whenToUse } : {}),
              ...(input.triggers ? { triggers: input.triggers } : {}),
              ...(input.pathGlobs ? { pathGlobs: input.pathGlobs } : {}),
            },
          }
        : {}),
    },
    resources: { references: [], scripts: [], invariants: [] },
    authoredResources: { references: [], scripts: [], invariants: [] },
    inheritedResources: { references: [], scripts: [], invariants: [] },
    projectGuidance: [],
    overlayFiles: [],
  };
}

function createRuntime(skills: SkillDocument[]): {
  runtime: SkillSelectionRuntime;
  events: Array<{ sessionId: string; type: string; payload?: object }>;
} {
  const events: Array<{ sessionId: string; type: string; payload?: object }> = [];
  const latestEventPayload = (sessionId: string): object | undefined => {
    const payload = events
      .toReversed()
      .find(
        (event) => event.sessionId === sessionId && event.type === "skill_selection_recorded",
      )?.payload;
    return typeof payload === "object" && payload !== null && !Array.isArray(payload)
      ? payload
      : undefined;
  };
  return {
    events,
    runtime: {
      ops: {
        skills: {
          catalog: {
            list: () => skills,
            get: (name) => skills.find((entry) => entry.name === name),
          },
          selection: {
            latest: latestEventPayload,
            record: (sessionId, receipt) => {
              events.push({
                sessionId,
                type: "skill_selection_recorded",
                payload: receipt,
              });
            },
          },
        },
      },
    },
  };
}

function createSkillCatalog(): SkillDocument[] {
  return [
    skill({
      name: "code-review",
      description: "Review TypeScript correctness, maintainability, and regression risk.",
      whenToUse: "Use for code review passes after implementation.",
      triggers: ["review pass"],
      pathGlobs: ["packages/**/*.ts"],
    }),
    skill({
      name: "docs-audit",
      category: "docs",
      description: "Audit documentation coherence, references, and publishing readiness.",
      triggers: ["documentation audit"],
      pathGlobs: ["docs/**"],
    }),
    skill({
      name: "runtime-forensics",
      category: "operator",
      description: "Inspect runtime artifacts, event streams, ledgers, WAL evidence, and traces.",
      triggers: ["wal evidence"],
    }),
    skill({
      name: "migration-safety",
      description: "Validate database migration rollback safety and persistent data risks.",
      pathGlobs: ["migrations/**"],
    }),
    skill({
      name: "internal-probe",
      category: "internal",
      description: "Internal-only probe.",
      triggers: ["probe"],
    }),
  ];
}

function expectObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Expected ${label} to be an object`);
  }
  return value as Record<string, unknown>;
}

function renderedNames(section: string): string[] {
  return [...section.matchAll(/^## (.+)$/gmu)].map((match) => match[1] ?? "");
}

describe("hosted advisory skill shortlist context", () => {
  test("renders discover guidance when no SkillCard is deterministically shortlisted", () => {
    const { runtime } = createRuntime(createSkillCatalog());

    const result = buildSkillShortlistContextForPrompt({
      runtime,
      prompt: "Summarize the recent discussion.",
    });

    expect(result.availableSkills.map((entry) => entry.name)).toEqual([
      "code-review",
      "migration-safety",
      "docs-audit",
      "runtime-forensics",
    ]);
    expect(result.receipt).toMatchObject({
      availableSkillCount: 4,
      candidateSkillCount: 0,
      renderedSkillCount: 0,
      omittedSkillCount: 4,
      selectionMode: "discover_guidance_prompt_context",
    });
    expect(result.renderedSection).toContain("No SkillCards were deterministically shortlisted");
    expect(result.renderedSection).not.toContain("## code-review");
    expect(result.renderedSection).not.toContain("internal-probe");
  });

  test("selects explicit $skill mentions and marks SkillCards as turn-scoped", () => {
    const { runtime } = createRuntime(createSkillCatalog());

    const result = buildSkillShortlistContextForPrompt({
      runtime,
      prompt: "Please use $code-review for this patch.",
    });

    expect(result.receipt.explicitSkillMentions).toEqual([
      {
        name: "code-review",
        category: "core",
        reason: "explicit_mention",
        filePath: "/skills/code-review/SKILL.md",
      },
    ]);
    expect(result.receipt.renderedSkillReasons).toEqual([
      {
        name: "code-review",
        category: "core",
        reasons: ["explicit_mention", "name_match"],
        score: 500,
        filePath: "/skills/code-review/SKILL.md",
      },
    ]);
    expect(renderedNames(result.renderedSection)).toEqual(["code-review"]);
    expect(result.renderedSection).toContain("turn-scoped prompt context");
    expect(result.renderedSection).toContain("read its filePath first");
    expect(result.renderedSection).toContain("Do not carry a SkillCard workflow into later turns");
  });

  test("selects by path_glob, trigger, name, and description text match", () => {
    const { runtime } = createRuntime(createSkillCatalog());

    const pathGlob = buildSkillShortlistContextForPrompt({
      runtime,
      prompt: "Update docs/reference/skill-routing.md.",
    });
    const nestedTsPathGlob = buildSkillShortlistContextForPrompt({
      runtime,
      prompt: "Review packages/brewva-gateway/src/index.ts.",
    });
    const shallowTsPathGlob = buildSkillShortlistContextForPrompt({
      runtime,
      prompt: "Review packages/index.ts.",
    });
    const directoryPathGlob = buildSkillShortlistContextForPrompt({
      runtime,
      prompt: "Audit docs/solutions/model-interface.md.",
    });
    const trigger = buildSkillShortlistContextForPrompt({
      runtime,
      prompt: "Need WAL evidence for this incident.",
    });
    const nameAndText = buildSkillShortlistContextForPrompt({
      runtime,
      prompt: "Run runtime-forensics and check database rollback safety.",
    });

    expect(pathGlob.receipt.renderedSkillReasons).toContainEqual({
      name: "docs-audit",
      category: "docs",
      reasons: ["path_glob"],
      score: 400,
      filePath: "/skills/docs-audit/SKILL.md",
    });
    expect(nestedTsPathGlob.receipt.renderedSkillReasons).toContainEqual({
      name: "code-review",
      category: "core",
      reasons: ["path_glob"],
      score: 400,
      filePath: "/skills/code-review/SKILL.md",
    });
    expect(shallowTsPathGlob.receipt.renderedSkillReasons).toContainEqual({
      name: "code-review",
      category: "core",
      reasons: ["path_glob"],
      score: 400,
      filePath: "/skills/code-review/SKILL.md",
    });
    expect(directoryPathGlob.receipt.renderedSkillReasons).toContainEqual({
      name: "docs-audit",
      category: "docs",
      reasons: ["path_glob"],
      score: 400,
      filePath: "/skills/docs-audit/SKILL.md",
    });
    expect(trigger.receipt.renderedSkillReasons).toContainEqual(
      expect.objectContaining({
        name: "runtime-forensics",
        category: "operator",
        score: 300,
        filePath: "/skills/runtime-forensics/SKILL.md",
      }),
    );
    expect(trigger.receipt.renderedSkillReasons[0]?.reasons).toContain("trigger");
    expect(nameAndText.receipt.renderedSkillReasons.map((entry) => entry.name)).toEqual([
      "runtime-forensics",
      "migration-safety",
    ]);
    expect(nameAndText.receipt.renderedSkillReasons[0]?.reasons).toContain("name_match");
    expect(nameAndText.receipt.renderedSkillReasons[1]?.reasons).toEqual(["text_match"]);
  });

  test("treats directory path_globs as descendant matches", () => {
    const { runtime } = createRuntime([
      skill({
        name: "solution-memory",
        category: "docs",
        description: "Find repository-native solution memory.",
        pathGlobs: ["docs/solutions"],
      }),
    ]);

    const result = buildSkillShortlistContextForPrompt({
      runtime,
      prompt: "Check docs/solutions/model-interface-attention.md before editing.",
    });

    expect(result.receipt.renderedSkillReasons).toEqual([
      {
        name: "solution-memory",
        category: "docs",
        reasons: ["path_glob"],
        score: 400,
        filePath: "/skills/solution-memory/SKILL.md",
      },
    ]);
  });

  test("caps deterministic shortlist at eight cards and records omission counts", () => {
    const skills = Array.from({ length: 10 }, (_, index) =>
      skill({
        name: `triggered-${index}`,
        category: "core",
        description: `Skill ${index} for common trigger routing.`,
        triggers: ["common-trigger"],
      }),
    );
    const { runtime } = createRuntime(skills);

    const result = buildSkillShortlistContextForPrompt({
      runtime,
      prompt: "common-trigger",
    });

    expect(result.receipt).toMatchObject({
      availableSkillCount: 10,
      candidateSkillCount: 10,
      renderedSkillCount: 8,
      omittedSkillCount: 2,
      selectionMode: "shortlist_prompt_context",
    });
    expect(renderedNames(result.renderedSection)).toHaveLength(8);
  });

  test("keeps explicit mentions over the render cap and records the over-budget reason", () => {
    const skills = Array.from({ length: 9 }, (_, index) =>
      skill({
        name: `explicit-${index}`,
        category: "core",
        description: `Explicit skill ${index}.`,
      }),
    );
    const { runtime } = createRuntime(skills);

    const result = buildSkillShortlistContextForPrompt({
      runtime,
      prompt: skills.map((entry) => `$${entry.name}`).join(" "),
    });

    expect(result.receipt).toMatchObject({
      availableSkillCount: 9,
      candidateSkillCount: 9,
      renderedSkillCount: 9,
      omittedSkillCount: 0,
      selectionMode: "explicit_over_budget_prompt_context",
    });
    expect(result.receipt.renderedSkillContext.overBudgetReason).toBe(
      "explicit_mentions_exceed_render_cap",
    );
    expect(result.receipt.explicitSkillMentions).toHaveLength(9);
    expect(renderedNames(result.renderedSection)).toHaveLength(9);
  });

  test("records shortlist evidence without changing tool authority", () => {
    const { runtime, events } = createRuntime(createSkillCatalog());
    const lifecycle = createSkillSelectionLifecycle(runtime);

    const result = lifecycle.beforeAgentStart(
      {
        prompt: "Use $code-review",
        systemPrompt: "base\n\nCurrent date: 2026-05-20\nCurrent working directory: /repo",
      },
      { sessionManager: { getSessionId: () => "skill-selection-event" } },
    );

    expect(result?.systemPrompt).toContain("Available Brewva SkillCards");
    expect(result?.systemPrompt).toContain("code-review");
    expect(result?.systemPrompt).not.toContain("docs-audit");
    expect(result?.systemPrompt).toMatch(
      /Available Brewva SkillCards[\s\S]+Current date: 2026-05-20/u,
    );
    expect(result?.message?.customType).toBe("brewva-skill-selection");
    expect(result?.message?.display).toBe(false);
    expect(result?.message?.excludeFromContext).toBe(true);
    expect(typeof result?.message?.content).toBe("string");
    expect(result?.message?.content).toContain("Available Brewva SkillCards: 4");
    expect(result?.message?.content).toContain("Candidate Brewva SkillCards: 1");
    expect(result?.message?.content).toContain("Rendered Brewva SkillCards: 1");
    expect(result?.message?.content).toContain("Selection Mode: shortlist_prompt_context");
    expect(result?.message?.details).toMatchObject({
      selectionId: expect.stringMatching(/^skill_selection_[a-f0-9]{16}$/u),
      explicitSkillMentionNames: ["code-review"],
      availableSkillCount: 4,
      candidateSkillCount: 1,
      renderedSkillCount: 1,
      omittedSkillCount: 3,
      selectionMode: "shortlist_prompt_context",
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("skill_selection_recorded");
    const payload = expectObject(events[0]?.payload, "skill selection payload");
    expect(payload).toMatchObject({
      trigger: "user_message",
      selectionMode: "shortlist_prompt_context",
      explicitSkillMentions: [
        {
          name: "code-review",
          category: "core",
          reason: "explicit_mention",
          filePath: "/skills/code-review/SKILL.md",
        },
      ],
      availableSkillCount: 4,
      candidateSkillCount: 1,
      renderedSkillCount: 1,
      omittedSkillCount: 3,
    });
    const renderedSkillContext = expectObject(
      payload.renderedSkillContext,
      "rendered skill context",
    );
    expect(renderedSkillContext).toMatchObject({
      tokenEncoding: "o200k_base",
      tokenEstimateMethod: "gpt_bpe_approximation",
      tokenEstimateApproximation: true,
      maxRenderedSkillCount: 8,
    });
    expect(renderedSkillContext.charCount).toBeGreaterThan(0);
    expect(renderedSkillContext.estimatedTokens).toBeGreaterThan(0);
  });
});
