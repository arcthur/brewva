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
        execute: async () => ({
          content: [],
          outcome: { kind: "ok", value: null },
          details: null,
          isError: false,
        }),
      },
    ]);
    registry.upsert({
      name: "read",
      label: "read",
      description: "Read a file safely",
      parameters: Type.Object({ path: Type.String() }),
      promptSnippet: " updated \n snippet ",
      promptGuidelines: [" beta ", "gamma"],
      execute: async () => ({
        content: [],
        outcome: { kind: "ok", value: null },
        details: null,
        isError: false,
      }),
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
        execute: async () => ({
          content: [],
          outcome: { kind: "ok", value: null },
          details: null,
          isError: false,
        }),
      },
      {
        name: "write",
        label: "write",
        description: "Write",
        parameters: Type.Object({}),
        promptSnippet: "Use write carefully",
        promptGuidelines: ["Prefer write"],
        execute: async () => ({
          content: [],
          outcome: { kind: "ok", value: null },
          details: null,
          isError: false,
        }),
      },
    ]);

    const prompt = buildManagedSessionBaseSystemPrompt({
      cwd: "/tmp/demo",
      resourceLoader: {
        getCustomInstructions: () => "Base prompt",
        getAppendInstructions: () => ["Append prompt"],
        getProjectInstructions: () => ({
          files: [
            {
              path: "/tmp/demo/AGENTS.md",
              content: "Project instructions",
              fileName: "AGENTS.md",
              directory: "/tmp/demo",
              source: "ancestor",
            },
          ],
          diagnostics: [],
        }),
        getProjectInstructionsForTarget: () => ({ files: [], diagnostics: [] }),
        getTargetOnlyProjectInstructions: () => ({ files: [], diagnostics: [] }),
        getSkills: () => ({ skills: [] }),
      } as never,
      activeToolNames: ["write"],
      toolPromptInputs: registry.buildPromptInputs(["write"]),
    });

    expect(prompt).toContain("Base prompt");
    expect(prompt).toContain("Append prompt");
    expect(prompt).toContain("Project instructions");
    expect(prompt).toContain("# Operating Contract");
    expect(prompt).toContain("Use write carefully");
    expect(prompt).toContain("Prefer write");
    expect(prompt).not.toContain("Use read carefully");
    expect(prompt).not.toContain("Prefer read");
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

  test("rejects prompt inputs that do not match active tool names", () => {
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
        execute: async () => ({
          content: [],
          outcome: { kind: "ok", value: null },
          details: null,
          isError: false,
        }),
      },
      {
        name: "write",
        label: "write",
        description: "Write",
        parameters: Type.Object({}),
        promptSnippet: "Use write carefully",
        promptGuidelines: ["Prefer write"],
        execute: async () => ({
          content: [],
          outcome: { kind: "ok", value: null },
          details: null,
          isError: false,
        }),
      },
    ]);

    expect(() =>
      buildManagedSessionBaseSystemPrompt({
        cwd: "/tmp/demo",
        resourceLoader: {
          getCustomInstructions: () => "",
          getAppendInstructions: () => [],
          getProjectInstructions: () => ({ files: [], diagnostics: [] }),
          getProjectInstructionsForTarget: () => ({ files: [], diagnostics: [] }),
          getTargetOnlyProjectInstructions: () => ({ files: [], diagnostics: [] }),
          getSkills: () => ({ skills: [] }),
        } as never,
        activeToolNames: ["write"],
        toolPromptInputs: registry.buildPromptInputs(["read"]),
      }),
    ).toThrow("active tool prompt inputs must match active tool names");
  });
});
