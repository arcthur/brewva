import { describe, expect, test } from "bun:test";
import { loadHostedDelegationCatalog } from "@brewva/brewva-gateway";
import type { BrewvaManagedToolDefinition } from "@brewva/brewva-tools/contracts";
import { createSubagentFanoutTool, createSubagentRunTool } from "@brewva/brewva-tools/delegation";

function collectPromptText(tool: BrewvaManagedToolDefinition): string {
  return [
    tool.description,
    tool.promptSnippet,
    ...(tool.promptGuidelines ?? []),
    JSON.stringify(tool.parameters),
  ]
    .filter(Boolean)
    .join("\n");
}

function parameterNames(tool: BrewvaManagedToolDefinition): string[] {
  return Object.keys(
    (tool.parameters as { properties?: Record<string, unknown> }).properties ?? {},
  ).toSorted();
}

describe("subagent public surface snapshot", () => {
  test("public subagent tools expose only intent-first packet fields", () => {
    const runtime = {
      orchestration: {
        subagents: {
          run: async () => ({
            ok: true,
            mode: "single",
            delegate: "explorer",
            outcomes: [],
          }),
        },
      },
    } as any;
    const forbidden = [
      "agentSpec",
      "envelope",
      "consultKind",
      "fallbackResultMode",
      "executionShape",
      "mode",
      "activeSkillName",
      "consultBrief",
    ];

    const publicTools = [
      createSubagentRunTool({ runtime }),
      createSubagentFanoutTool({ runtime }),
    ] as BrewvaManagedToolDefinition[];
    for (const tool of publicTools) {
      expect(parameterNames(tool)).not.toEqual(expect.arrayContaining(forbidden));
    }
  });

  test("public prompt guidance does not leak review lane names or diagnostic fields", () => {
    const runtime = {
      orchestration: {
        subagents: {
          run: async () => ({
            ok: true,
            mode: "single",
            delegate: "explorer",
            outcomes: [],
          }),
        },
      },
    } as any;
    const publicText = [
      collectPromptText(createSubagentRunTool({ runtime }) as BrewvaManagedToolDefinition),
      collectPromptText(createSubagentFanoutTool({ runtime }) as BrewvaManagedToolDefinition),
    ].join("\n");

    expect(publicText).toContain("explorer");
    expect(publicText).toContain("verifier");
    expect(publicText).toContain("worker");
    expect(publicText).not.toContain("review-correctness");
    expect(publicText).not.toContain("review-security");
    expect(publicText).not.toContain("agentSpec");
    expect(publicText).not.toContain("consultKind");
    expect(publicText).not.toContain("executionShape");
  });

  test("catalog public listing contains only the stable specialist names", async () => {
    const catalog = await loadHostedDelegationCatalog(process.cwd());
    const publicNames = [...catalog.agentSpecs.values()]
      .filter((agentSpec) => agentSpec.visibility === "public")
      .map((agentSpec) => agentSpec.name)
      .toSorted();

    expect(publicNames).toEqual(["explorer", "librarian", "navigator", "verifier", "worker"]);
  });
});
