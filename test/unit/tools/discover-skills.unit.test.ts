import { describe, expect, test } from "bun:test";
import type { SkillDocument } from "@brewva/brewva-runtime/protocol";
import { createDiscoverSkillsTool } from "@brewva/brewva-tools/skills";
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
    },
    resources: { references: [], scripts: [], invariants: [] },
    authoredResources: { references: [], scripts: [], invariants: [] },
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
              }),
            ],
          },
        },
      },
    });
    const tool = createDiscoverSkillsTool({ runtime: createBundledToolRuntime(runtime) });

    const result = await tool.execute(
      "discover-skills-1",
      { query: "runtime trace evidence", limit: 5 },
      new AbortController().signal,
      async () => undefined,
      {} as never,
    );

    expect(result.details).toMatchObject({
      ok: true,
      searchedSkillCount: 2,
      results: [
        expect.objectContaining({
          name: "runtime-forensics",
          filePath: "/skills/runtime-forensics/SKILL.md",
        }),
      ],
    });
    expect(extractText(result as { content: Array<{ type: string; text?: string }> })).toContain(
      "runtime-forensics",
    );
  });
});
