import { describe, expect, test } from "bun:test";
import { createDiscoverSkillsTool } from "@brewva/brewva-tools/skills";
import type { SkillDocument } from "@brewva/brewva-vocabulary/session";
import { createBundledToolRuntime, createRuntimeFixture } from "../../helpers/runtime.js";

function extractText(result: { content: Array<{ type: string; text?: string }> }): string {
  return (
    result.content.find((item) => item.type === "text" && typeof item.text === "string")?.text ?? ""
  );
}

function skill(input: {
  name: string;
  description: string;
  whenToUse?: string;
  category?: SkillDocument["category"];
  references?: readonly string[];
  scripts?: readonly string[];
  invariants?: readonly string[];
  argumentHints?: readonly string[];
  outputArtifacts?: readonly string[];
}): SkillDocument {
  return {
    name: input.name,
    description: input.description,
    category: input.category ?? "core",
    filePath: `/skills/${input.name}/SKILL.md`,
    baseDir: `/skills/${input.name}`,
    markdown: `# ${input.name}`,
    authoredMarkdown: `# ${input.name}`,
    inheritedMarkdown: "",
    card: {
      name: input.name,
      category: input.category ?? "core",
      description: input.description,
      ...(input.whenToUse ? { selection: { whenToUse: input.whenToUse } } : {}),
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
    projectGuidance: [],
    overlayFiles: [],
  };
}

describe("discover_skills tool", () => {
  test("searches SkillCards with shared TF-IDF ranking", async () => {
    const runtime = createRuntimeFixture({
      capabilities: {
        skills: {
          catalog: {
            list: () => [
              skill({
                name: "architecture",
                description: "Assess architecture boundaries, module depth, and testability.",
                whenToUse: "Use when code structure and boundaries need review.",
              }),
              skill({
                name: "runtime-forensics",
                description: "Inspect runtime trace evidence, events, ledgers, and projections.",
                whenToUse: "Use when execution behavior must be explained from trace evidence.",
                references: ["references/runtime-events.md"],
                scripts: ["scripts/trace-runtime.ts"],
                invariants: ["invariants/no-authority.md"],
                argumentHints: ["session_id"],
                outputArtifacts: ["forensics_report"],
              }),
            ],
          },
        },
      },
    });
    const tool = createDiscoverSkillsTool({ runtime: createBundledToolRuntime(runtime) });
    const ctx = {
      sessionManager: {
        getSessionId: () => "discover-skills-session",
      },
    };

    const result = await tool.execute(
      "discover-skills-1",
      { query: "runtime trace evidence", limit: 5 },
      new AbortController().signal,
      async () => undefined,
      ctx as never,
    );
    const receipt = runtime.ops.skills.selection.latest("discover-skills-session") as {
      skillInvocationRecords?: Array<{
        selectionTrigger?: string;
        invocationMode?: string;
        skillName?: string;
        resourceRefs?: unknown;
        requestedOutputArtifacts?: unknown;
        argumentHints?: unknown;
      }>;
    };

    expect(result.details).toMatchObject({
      ok: true,
      searchedSkillCount: 2,
      results: [
        expect.objectContaining({
          name: "runtime-forensics",
          filePath: "/skills/runtime-forensics/SKILL.md",
          resourceRefs: [
            { kind: "reference", path: "references/runtime-events.md" },
            { kind: "script", path: "scripts/trace-runtime.ts" },
            { kind: "invariant", path: "invariants/no-authority.md" },
          ],
          argumentHints: ["session_id"],
          requestedOutputArtifacts: ["forensics_report"],
        }),
      ],
    });
    expect(extractText(result as { content: Array<{ type: string; text?: string }> })).toContain(
      "runtime-forensics",
    );
    expect(receipt.skillInvocationRecords).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          skillName: "runtime-forensics",
          selectionTrigger: "discover_only",
          invocationMode: "inspect_only",
          resourceRefs: [
            { kind: "reference", path: "references/runtime-events.md" },
            { kind: "script", path: "scripts/trace-runtime.ts" },
            { kind: "invariant", path: "invariants/no-authority.md" },
          ],
          argumentHints: ["session_id"],
          requestedOutputArtifacts: ["forensics_report"],
        }),
      ]),
    );
  });

  test("bounds discover-only SkillCard projection while preserving surfaced provenance", async () => {
    const references = Array.from({ length: 30 }, (_, index) => `references/ref-${index}.md`);
    const runtime = createRuntimeFixture({
      capabilities: {
        skills: {
          catalog: {
            list: () => [
              skill({
                name: "large-discovery",
                description: `Overflow projection ${"description ".repeat(400)}tail-description`,
                whenToUse: `Use for overflow projection ${"when ".repeat(400)}tail-when`,
                references,
                argumentHints: Array.from({ length: 20 }, (_, index) => `arg-${index}`),
                outputArtifacts: Array.from({ length: 20 }, (_, index) => `artifact-${index}`),
              }),
            ],
          },
        },
      },
    });
    const tool = createDiscoverSkillsTool({ runtime: createBundledToolRuntime(runtime) });
    const ctx = {
      sessionManager: {
        getSessionId: () => "discover-large-session",
      },
    };

    const result = await tool.execute(
      "discover-skills-large",
      { query: "overflow projection", limit: 5 },
      new AbortController().signal,
      async () => undefined,
      ctx as never,
    );
    const text = extractText(result as { content: Array<{ type: string; text?: string }> });
    const receipt = runtime.ops.skills.selection.latest("discover-large-session") as {
      skillInvocationRecords?: Array<{
        resourceRefs?: unknown[];
      }>;
    };

    expect(text).toContain("large-discovery");
    expect(text).toContain("...");
    expect(text).toContain("(+6 omitted)");
    expect(text).toContain("(+4 omitted)");
    expect(text).not.toContain("tail-description");
    expect(text).not.toContain("tail-when");
    expect(receipt.skillInvocationRecords?.[0]?.resourceRefs).toHaveLength(24);
    expect(receipt.skillInvocationRecords?.[0]?.resourceRefs?.at(-1)).toEqual({
      kind: "reference",
      path: "references/ref-23.md",
    });
  });
});
