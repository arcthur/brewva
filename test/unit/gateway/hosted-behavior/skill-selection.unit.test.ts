import { describe, expect, test } from "bun:test";
import type { SkillDocument } from "@brewva/brewva-vocabulary/session";
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
  pathGlobs?: readonly string[];
  references?: readonly string[];
  scripts?: readonly string[];
  invariants?: readonly string[];
  argumentHints?: readonly string[];
  outputArtifacts?: readonly string[];
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
      ...(input.whenToUse || input.pathGlobs
        ? {
            selection: {
              ...(input.whenToUse ? { whenToUse: input.whenToUse } : {}),
              ...(input.pathGlobs ? { pathGlobs: input.pathGlobs } : {}),
            },
          }
        : {}),
      ...(input.argumentHints ? { argumentHints: input.argumentHints } : {}),
      ...(input.outputArtifacts ? { outputArtifacts: input.outputArtifacts } : {}),
    },
    resources: {
      references: input.references ?? [],
      scripts: input.scripts ?? [],
      invariants: input.invariants ?? [],
    },
    authoredResources: {
      references: input.references ?? [],
      scripts: input.scripts ?? [],
      invariants: input.invariants ?? [],
    },
    inheritedResources: { references: [], scripts: [], invariants: [] },
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
      pathGlobs: ["packages/**/*.ts"],
    }),
    skill({
      name: "docs-audit",
      category: "docs",
      description: "Audit documentation coherence, references, and publishing readiness.",
      pathGlobs: ["docs/**"],
    }),
    skill({
      name: "runtime-forensics",
      category: "operator",
      description: "Inspect runtime artifacts, event streams, ledgers, WAL evidence, and traces.",
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
      selectionMode: "discover_guidance_receipt_only",
      promptPaths: [],
    });
    expect(result.renderedSection).toBe("");
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
        reasonCount: 2,
        score: 500,
        filePath: "/skills/code-review/SKILL.md",
      },
    ]);
    expect(renderedNames(result.renderedSection)).toEqual(["code-review"]);
    expect(result.renderedSection).toContain("turn-scoped prompt context");
    expect(result.renderedSection).toContain("read its filePath BEFORE acting on the task");
    expect(result.renderedSection).toContain("Do not carry a SkillCard workflow into later turns");
  });

  test("selects by path_glob and name (deterministic reasons only)", () => {
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
    const nameMatch = buildSkillShortlistContextForPrompt({
      runtime,
      prompt: "Run runtime-forensics and check database rollback safety.",
    });

    expect(pathGlob.receipt.promptPaths).toEqual(["docs/reference/skill-routing.md"]);
    expect(pathGlob.receipt.renderedSkillReasons).toContainEqual({
      name: "docs-audit",
      category: "docs",
      reasons: ["path_glob"],
      reasonCount: 1,
      score: 400,
      filePath: "/skills/docs-audit/SKILL.md",
    });
    expect(nestedTsPathGlob.receipt.renderedSkillReasons).toContainEqual({
      name: "code-review",
      category: "core",
      reasons: ["path_glob"],
      reasonCount: 1,
      score: 400,
      filePath: "/skills/code-review/SKILL.md",
    });
    expect(shallowTsPathGlob.receipt.renderedSkillReasons).toContainEqual({
      name: "code-review",
      category: "core",
      reasons: ["path_glob"],
      reasonCount: 1,
      score: 400,
      filePath: "/skills/code-review/SKILL.md",
    });
    // A docs path with no name/mention token: docs-audit shortlists on the glob
    // alone. The auto text-match reason is gone — surfacing a skill by prose
    // overlap is now discover_skills' explicit job, not the selector's.
    expect(directoryPathGlob.receipt.renderedSkillReasons).toContainEqual({
      name: "docs-audit",
      category: "docs",
      reasons: ["path_glob"],
      reasonCount: 1,
      score: 400,
      filePath: "/skills/docs-audit/SKILL.md",
    });
    // "runtime-forensics" appears as a whole word -> name_match. migration-safety,
    // which used to join on a description text_match ("database rollback"), no
    // longer auto-shortlists without a deterministic trigger.
    expect(nameMatch.receipt.renderedSkillReasons.map((entry) => entry.name)).toEqual([
      "runtime-forensics",
    ]);
    expect(nameMatch.receipt.renderedSkillReasons[0]?.reasons).toContain("name_match");
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
        reasonCount: 1,
        score: 400,
        filePath: "/skills/solution-memory/SKILL.md",
      },
    ]);
  });

  test("uses corroborating reasons as deterministic tie-break evidence", () => {
    const { runtime } = createRuntime([
      skill({
        name: "docs-audit",
        category: "docs",
        description: "Audit documentation coherence.",
        pathGlobs: ["docs/**"],
      }),
      skill({
        name: "docs-basic",
        category: "docs",
        description: "Basic documentation checks.",
        pathGlobs: ["docs/**"],
      }),
    ]);

    const result = buildSkillShortlistContextForPrompt({
      runtime,
      prompt: "Use docs-audit for docs/reference/skill-routing.md.",
    });

    expect(result.receipt.renderedSkillReasons.map((entry) => entry.name)).toEqual([
      "docs-audit",
      "docs-basic",
    ]);
    expect(result.receipt.renderedSkillReasons[0]).toMatchObject({
      reasons: ["path_glob", "name_match"],
      reasonCount: 2,
      score: 400,
    });
  });

  test("caps deterministic shortlist at eight cards and records omission counts", () => {
    // Ten skills all scoped to the same path glob: the prompt path matches every
    // one, so all ten are deterministic path_glob candidates (score 400) and the
    // 8-card cap bites, omitting the two alphabetically-last by the deterministic
    // tie-break.
    const skills = Array.from({ length: 10 }, (_, index) =>
      skill({
        name: `common-${index}`,
        category: "core",
        description: `Skill ${index} for common routing selection.`,
        pathGlobs: ["src/**"],
      }),
    );
    const { runtime } = createRuntime(skills);

    const result = buildSkillShortlistContextForPrompt({
      runtime,
      prompt: "review src/app.ts",
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

    expect(result?.systemPrompt).toContain("# Brewva SkillCard Catalog");
    expect(result?.systemPrompt).toContain("# Shortlisted Brewva SkillCards (this turn)");
    // Byte-stable catalog renders before the turn-varying shortlist so
    // shortlist churn breaks the prompt cache as late as possible.
    expect(String(result?.systemPrompt).indexOf("# Brewva SkillCard Catalog")).toBeLessThan(
      String(result?.systemPrompt).indexOf("# Shortlisted Brewva SkillCards"),
    );
    expect(result?.systemPrompt).toContain("code-review");
    // Un-shortlisted skills stay visible in the catalog layer but never gain
    // a detailed shortlist card.
    const systemPromptText = String(result?.systemPrompt);
    const shortlistPortion = systemPromptText.slice(
      systemPromptText.indexOf("# Shortlisted Brewva SkillCards"),
    );
    expect(systemPromptText).toContain("- docs-audit:");
    expect(shortlistPortion).not.toContain("docs-audit");
    expect(result?.systemPrompt).toMatch(
      /Shortlisted Brewva SkillCards[\s\S]+Current date: 2026-05-20/u,
    );
    expect(result?.message?.customType).toBe("brewva-skill-selection");
    expect(result?.message?.display).toBe(true);
    expect(result?.message?.excludeFromContext).toBe(true);
    expect(typeof result?.message?.content).toBe("string");
    expect(result?.message?.content).toContain("Available Brewva SkillCards: 4");
    expect(result?.message?.content).toContain("Candidate Brewva SkillCards: 1");
    expect(result?.message?.content).toContain("Rendered Brewva SkillCards: 1");
    expect(result?.message?.content).toContain("Prompt Paths: 0");
    expect(result?.message?.content).toContain("Selection Mode: shortlist_prompt_context");
    expect(result?.message?.content).toContain(
      "Selected Skills: code-review (explicit_mention+name_match)",
    );
    expect(result?.message?.details).toMatchObject({
      selectionId: expect.stringMatching(/^skill_selection_[a-f0-9]{16}$/u),
      explicitSkillMentionNames: ["code-review"],
      availableSkillCount: 4,
      candidateSkillCount: 1,
      renderedSkillCount: 1,
      omittedSkillCount: 3,
      selectionMode: "shortlist_prompt_context",
      promptPaths: [],
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
      promptPaths: [],
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

  test("records advisory skill invocation metadata for prompt-visible SkillCards", () => {
    const { runtime } = createRuntime([
      skill({
        name: "memory-audit",
        category: "docs",
        description: "Inspect repository memory and recall ergonomics.",
        whenToUse: "Use when work touches recall or memory behavior.",
        references: ["references/memory.md"],
        scripts: ["scripts/audit-memory.ts"],
        invariants: ["invariants/no-hidden-recall.md"],
        argumentHints: ["query", "target_root"],
        outputArtifacts: ["audit_report"],
      }),
    ]);

    const result = buildSkillShortlistContextForPrompt({
      runtime,
      prompt: "Use $memory-audit for recall behavior.",
    });

    expect(result.receipt.skillInvocationRecords).toEqual([
      {
        invocationId: `${result.receipt.selectionId}:memory-audit`,
        skillName: "memory-audit",
        category: "docs",
        sourcePath: "/skills/memory-audit/SKILL.md",
        sourcePackage: null,
        selectionTrigger: "explicit_command",
        invocationMode: "prompt_visible",
        resourceRefs: [
          { kind: "reference", path: "references/memory.md" },
          { kind: "script", path: "scripts/audit-memory.ts" },
          { kind: "invariant", path: "invariants/no-hidden-recall.md" },
        ],
        estimatedTokens: expect.any(Number),
        tokenEncoding: "o200k_base",
        tokenEstimateMethod: "gpt_bpe_approximation",
        tokenEstimateApproximation: true,
        capabilityRefs: [],
        requestedOutputArtifacts: ["audit_report"],
        argumentHints: ["query", "target_root"],
      },
    ]);
    expect(result.receipt.skillInvocationRecords[0]?.estimatedTokens).toBeGreaterThan(0);
  });

  test("bounds prompt-visible SkillCard projection and records only surfaced resource refs", () => {
    const references = Array.from({ length: 30 }, (_, index) => `references/ref-${index}.md`);
    const { runtime } = createRuntime([
      skill({
        name: "large-card",
        category: "core",
        description: `Large projection ${"description ".repeat(400)}tail-description`,
        whenToUse: `Use for large metadata ${"when ".repeat(400)}tail-when`,
        references,
        argumentHints: Array.from({ length: 20 }, (_, index) => `arg-${index}`),
        outputArtifacts: Array.from({ length: 20 }, (_, index) => `artifact-${index}`),
      }),
    ]);

    const result = buildSkillShortlistContextForPrompt({
      runtime,
      prompt: "Use $large-card.",
    });
    const record = result.receipt.skillInvocationRecords[0];

    expect(result.renderedSection).toContain("description: Large projection");
    expect(result.renderedSection).toContain("...");
    expect(result.renderedSection).toContain("(+6 omitted)");
    expect(result.renderedSection).toContain("(+4 omitted)");
    expect(result.renderedSection).not.toContain("tail-description");
    expect(result.renderedSection).not.toContain("tail-when");
    expect(record?.resourceRefs).toHaveLength(24);
    expect(record?.resourceRefs.at(-1)).toEqual({
      kind: "reference",
      path: "references/ref-23.md",
    });
    expect(result.receipt.renderedSkillContext).toMatchObject({
      textFieldMaxChars: 1536,
      listItemMaxCount: 16,
      resourceRefMaxCount: 24,
    });
  });

  test("no-candidate turns still surface the catalog (a scorer miss must not hide skills)", () => {
    const { runtime, events } = createRuntime(createSkillCatalog());
    const lifecycle = createSkillSelectionLifecycle(runtime);

    const result = lifecycle.beforeAgentStart(
      {
        prompt: "Summarize the current turn.",
        promptPaths: ["unknown/path.md"],
        systemPrompt: "base\n\nCurrent date: 2026-05-20\nCurrent working directory: /repo",
      },
      { sessionManager: { getSessionId: () => "no-skill-selection-event" } },
    );

    const resultObject = expectObject(result, "no-candidate lifecycle result");
    const message = expectObject(resultObject.message, "no-candidate lifecycle message");
    expect(message.customType).toBe("brewva-skill-selection");
    expect(message.display).toBe(false);
    expect(resultObject.systemPrompt).toContain("# Brewva SkillCard Catalog");
    expect(resultObject.systemPrompt).not.toContain("# Shortlisted Brewva SkillCards");
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({
      selectionMode: "discover_guidance_receipt_only",
      promptPaths: ["unknown/path.md"],
      renderedSkillCount: 0,
    });
  });
});

describe("skill catalog layer and widened signals", () => {
  test("catalog section is byte-identical across different prompts", () => {
    const { runtime } = createRuntime(createSkillCatalog());
    const first = buildSkillShortlistContextForPrompt({
      runtime,
      prompt: "Fix the flaky migration rollback test in migrations/2024.ts",
    });
    const second = buildSkillShortlistContextForPrompt({
      runtime,
      prompt: "totally unrelated question about weather",
    });
    expect(first.catalogSection).toBe(second.catalogSection);
    expect(first.catalogSection).toContain("# Brewva SkillCard Catalog");
    expect(first.catalogSection).toContain("- migration-safety:");
    expect(first.catalogSection).not.toContain("internal-probe");
  });

  test("catalog caps entries and points the overflow at discover_skills", () => {
    const bulk = Array.from({ length: 45 }, (_, index) =>
      skill({
        name: `bulk-skill-${String(index).padStart(2, "0")}`,
        description: `Bulk workflow number ${index}.`,
      }),
    );
    const { runtime } = createRuntime(bulk);
    const result = buildSkillShortlistContextForPrompt({ runtime, prompt: "hello" });
    expect(result.catalogSection).toContain("- bulk-skill-00:");
    expect(result.catalogSection).toContain("- bulk-skill-39:");
    expect(result.catalogSection).not.toContain("- bulk-skill-40:");
    expect(result.catalogSection).toContain("(+5 more SkillCards — search with discover_skills)");
  });

  test("recently touched tool paths surface skills as recent_path below prompt path_glob", () => {
    const { runtime } = createRuntime(createSkillCatalog());
    const result = buildSkillShortlistContextForPrompt({
      runtime,
      prompt: "please keep going",
      recentToolPaths: ["migrations/2026-07-add-index.sql"],
    });
    const rendered = result.receipt.renderedSkillReasons.find(
      (entry) => entry.name === "migration-safety",
    );
    expect(rendered).toMatchObject({ reasons: ["recent_path"], score: 300 });
    expect(result.receipt.recentToolPaths).toEqual(["migrations/2026-07-add-index.sql"]);

    const withPromptPath = buildSkillShortlistContextForPrompt({
      runtime,
      prompt: "review migrations/2026-07-add-index.sql",
    });
    const promptPathRendered = withPromptPath.receipt.renderedSkillReasons.find(
      (entry) => entry.name === "migration-safety",
    );
    expect(promptPathRendered?.reasons).toContain("path_glob");
    expect(promptPathRendered?.score).toBe(400);
  });

  test("crafted skill names cannot smuggle markdown lines into prompt sections", () => {
    const { runtime } = createRuntime([
      skill({ name: "innocent\n# Injected Section", description: "Safe description." }),
    ]);
    const result = buildSkillShortlistContextForPrompt({ runtime, prompt: "hello" });
    expect(result.catalogSection).not.toContain("\n# Injected Section");
    expect(result.catalogSection).toContain("- innocent # Injected Section: Safe description.");
  });

  test("lifecycle derives recent paths and previous adoption from the event tape", () => {
    const { runtime, events } = createRuntime(createSkillCatalog());
    const tape: Array<{ type: string; timestamp: number; payload?: object }> = [];
    (runtime.ops as { events?: object }).events = {
      records: {
        query: (
          _sessionId: string,
          query?: { type?: string; last?: number; after?: number; limit?: number },
        ) => {
          let matching = tape.filter(
            (event) =>
              (!query?.type || event.type === query.type) &&
              (query?.after === undefined || event.timestamp > query.after),
          );
          if (typeof query?.last === "number") {
            matching = matching.slice(-query.last);
          }
          if (typeof query?.limit === "number") {
            matching = matching.slice(0, query.limit);
          }
          return matching;
        },
      },
    };
    const lifecycle = createSkillSelectionLifecycle(runtime);

    // Turn 1: a prompt-path selection renders migration-safety.
    const first = lifecycle.beforeAgentStart(
      {
        prompt: "review migrations/001.sql",
        systemPrompt: "base\n\nCurrent date: 2026-05-20\nCurrent working directory: /repo",
      },
      { sessionManager: { getSessionId: () => "adoption-session" } },
    );
    const firstObject = expectObject(first, "first lifecycle result");
    const firstMessage = expectObject(firstObject.message, "first lifecycle message");
    expect(String(firstMessage.content)).toContain("Previous Selection Adoption: none recorded");
    const firstReceipt = events.at(-1)?.payload as {
      selectionId?: string;
      renderedSkillReasons?: Array<{ name: string }>;
    };
    expect(firstReceipt.renderedSkillReasons?.map((entry) => entry.name)).toContain(
      "migration-safety",
    );
    tape.push({
      type: "skill.selection.recorded",
      timestamp: 100,
      payload: events.at(-1)?.payload,
    });
    // The model read the rendered skill file, then edited a package file —
    // both as kernel commitments (the shape the projections actually read).
    tape.push({
      type: "tool.committed",
      timestamp: 110,
      payload: {
        call: { toolName: "source_read", args: { uri: "/skills/migration-safety/SKILL.md" } },
        result: { outcome: { kind: "ok" } },
      },
    });
    tape.push({
      type: "tool.committed",
      timestamp: 120,
      payload: {
        call: {
          toolName: "source_patch_prepare",
          args: { edits: [{ kind: "replace_anchor", uri: "packages/core/index.ts" }] },
        },
        result: { outcome: { kind: "ok" } },
      },
    });

    // Turn 2: bare continuation — recent_path resurfaces code-review; the
    // trace reports the previous selection's adoption.
    const second = lifecycle.beforeAgentStart(
      {
        prompt: "continue",
        systemPrompt: "base\n\nCurrent date: 2026-05-20\nCurrent working directory: /repo",
      },
      { sessionManager: { getSessionId: () => "adoption-session" } },
    );
    const secondObject = expectObject(second, "second lifecycle result");
    const message = expectObject(secondObject.message, "second lifecycle message");
    expect(String(message.content)).toContain(
      "Previous Selection Adoption: 1/1 rendered SkillCards read (migration-safety)",
    );
    const secondReceipt = events.at(-1)?.payload as {
      selectionId?: string;
      recentToolPaths?: string[];
      renderedSkillReasons?: Array<{ name: string; reasons: string[] }>;
    };
    expect(secondReceipt.recentToolPaths).toEqual([
      "packages/core/index.ts",
      "/skills/migration-safety/SKILL.md",
    ]);
    expect(
      secondReceipt.renderedSkillReasons?.find((entry) => entry.name === "code-review")?.reasons,
    ).toEqual(["recent_path"]);
    expect(secondReceipt.selectionId).not.toBe(firstReceipt.selectionId);

    // A long turn (many invocations after the early skill read) must not push
    // the read out of the adoption measurement: adoption is "since the
    // selection", not a recency tail.
    for (let index = 0; index < 80; index += 1) {
      tape.push({
        type: "tool.committed",
        timestamp: 200 + index,
        payload: {
          call: { toolName: "grep", args: { query: "x", paths: [`dir/f${index}`] } },
          result: { outcome: { kind: "ok" } },
        },
      });
    }
    const third = lifecycle.beforeAgentStart(
      {
        prompt: "continue",
        systemPrompt: "base\n\nCurrent date: 2026-05-20\nCurrent working directory: /repo",
      },
      { sessionManager: { getSessionId: () => "adoption-session" } },
    );
    const thirdObject = expectObject(third, "third lifecycle result");
    const thirdMessage = expectObject(thirdObject.message, "third lifecycle message");
    expect(String(thirdMessage.content)).toContain(
      "Previous Selection Adoption: 1/1 rendered SkillCards read (migration-safety)",
    );
  });
});
