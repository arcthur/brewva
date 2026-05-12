import { describe, expect, test } from "bun:test";
import { Type } from "@sinclair/typebox";
import { createToolSchemaSnapshot } from "../../../packages/brewva-gateway/src/hosted/internal/provider/cache/index.js";
import {
  buildManagedSessionBaseSystemPrompt,
  ManagedSessionToolRegistry,
} from "../../../packages/brewva-gateway/src/hosted/internal/session/managed-agent/tool-registry.js";

describe("managed-agent-session tool registry", () => {
  test("upsert replaces same-name tool and keeps normalized prompt metadata", () => {
    const registry = new ManagedSessionToolRegistry({
      resolveSchemaSnapshot: (tools) =>
        createToolSchemaSnapshot(
          tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
          })),
        ),
    });

    registry.replaceAll([
      {
        name: "read",
        label: "read",
        description: "Read a file",
        parameters: Type.Object({}),
        promptSnippet: " line one \n line two ",
        promptGuidelines: [" alpha ", "alpha", "beta "],
        execute: async () => ({ content: [], details: null }),
      },
    ]);
    registry.upsert({
      name: "read",
      label: "read",
      description: "Read a file safely",
      parameters: Type.Object({ path: Type.String() }),
      promptSnippet: " updated \n snippet ",
      promptGuidelines: [" beta ", "gamma"],
      execute: async () => ({ content: [], details: null }),
    });

    expect(registry.listRegisteredTools()).toHaveLength(1);
    expect(
      registry.resolveDefinitions(["read", "missing"]).map((tool) => tool.description),
    ).toEqual(["Read a file safely"]);
    expect(registry.buildPromptInputs(["read"])).toEqual({
      selectedTools: ["read"],
      toolSnippets: { read: "updated snippet" },
      promptGuidelines: ["beta", "gamma"],
    });
  });

  test("builds base system prompt from active tools only", () => {
    const registry = new ManagedSessionToolRegistry({
      resolveSchemaSnapshot: (tools) =>
        createToolSchemaSnapshot(
          tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
          })),
        ),
    });

    registry.replaceAll([
      {
        name: "read",
        label: "read",
        description: "Read",
        parameters: Type.Object({}),
        promptSnippet: "Use read carefully",
        promptGuidelines: ["Prefer read"],
        execute: async () => ({ content: [], details: null }),
      },
      {
        name: "write",
        label: "write",
        description: "Write",
        parameters: Type.Object({}),
        promptSnippet: "Use write carefully",
        promptGuidelines: ["Prefer write"],
        execute: async () => ({ content: [], details: null }),
      },
    ]);

    const prompt = buildManagedSessionBaseSystemPrompt({
      cwd: "/tmp/demo",
      resourceLoader: {
        getSystemPrompt: () => "Base prompt",
        getAppendSystemPrompt: () => ["Append prompt"],
        getAgentsFiles: () => ({ agentsFiles: [] }),
        getSkills: () => ({ skills: [] }),
      } as never,
      activeToolNames: ["write"],
      toolPromptInputs: registry.buildPromptInputs(["write"]),
    });

    expect(prompt).toContain("Base prompt");
    expect(prompt).toContain("Base prompt");
    expect(registry.buildPromptInputs(["write"])).toEqual({
      selectedTools: ["write"],
      toolSnippets: { write: "Use write carefully" },
      promptGuidelines: ["Prefer write"],
    });
    expect(registry.buildPromptInputs(["read"])).toEqual({
      selectedTools: ["read"],
      toolSnippets: { read: "Use read carefully" },
      promptGuidelines: ["Prefer read"],
    });
  });
});
