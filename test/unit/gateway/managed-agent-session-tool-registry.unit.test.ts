import { describe, expect, test } from "bun:test";
import type { BrewvaAgentProtocolTool } from "@brewva/brewva-substrate/agent-protocol";
import type { BrewvaToolDefinition } from "@brewva/brewva-substrate/tools";
import { Type } from "@sinclair/typebox";
import { createToolSchemaSnapshot } from "../../../packages/brewva-gateway/src/hosted/internal/provider/cache/index.js";
import {
  buildManagedSessionBaseSystemPrompt,
  ManagedSessionToolRegistry,
  type ManagedSessionToolApplicationDeps,
} from "../../../packages/brewva-gateway/src/hosted/internal/session/managed-agent/tool-registry.js";

function emptyResourceLoader(): never {
  return {
    getCustomInstructions: () => "",
    getAppendInstructions: () => [],
    getProjectInstructions: () => ({ files: [], diagnostics: [] }),
    getProjectInstructionsForTarget: () => ({ files: [], diagnostics: [] }),
    getTargetOnlyProjectInstructions: () => ({ files: [], diagnostics: [] }),
    getSkills: () => ({ skills: [] }),
  } as never;
}

function makeTool(name: string): BrewvaToolDefinition {
  return {
    name,
    label: name,
    description: `${name} description`,
    parameters: Type.Object({}),
    promptSnippet: `Use ${name} carefully`,
    execute: async () => ({
      content: [],
      outcome: { kind: "ok", value: null },
      details: null,
      isError: false,
    }),
  } as BrewvaToolDefinition;
}

interface OrchestrationProbe {
  registry: ManagedSessionToolRegistry;
  deps: ManagedSessionToolApplicationDeps;
  activeAgentTools: BrewvaAgentProtocolTool[];
  calls: Array<{ kind: "base-context" | "base-system-prompt"; systemPrompt: string }>;
}

function createOrchestrationProbe(): OrchestrationProbe {
  const probe: OrchestrationProbe = {
    registry: new ManagedSessionToolRegistry({
      cwd: "/tmp/demo",
      resourceLoader: emptyResourceLoader(),
      resolveSchemaSnapshot: (tools) =>
        createToolSchemaSnapshot(
          tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
          })),
        ),
    }),
    deps: {} as ManagedSessionToolApplicationDeps,
    activeAgentTools: [],
    calls: [],
  };
  probe.deps = {
    createToolContext: () => ({}) as never,
    // Mirror the session's live-agent read: active tool names come from the
    // live transcript that applyBaseContext just installed, not the registry.
    getActiveToolNames: () => probe.activeAgentTools.map((tool) => tool.name),
    applyBaseContext: (input) => {
      probe.activeAgentTools = input.tools;
      probe.calls.push({ kind: "base-context", systemPrompt: input.systemPrompt });
    },
    applyBaseSystemPrompt: (systemPrompt) => {
      probe.calls.push({ kind: "base-system-prompt", systemPrompt });
    },
  };
  return probe;
}

describe("managed-agent-session tool registry", () => {
  test("upsert replaces same-name tool and keeps normalized prompt metadata", () => {
    const registry = new ManagedSessionToolRegistry({
      cwd: "/tmp/demo",
      resourceLoader: emptyResourceLoader(),
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
      cwd: "/tmp/demo",
      resourceLoader: emptyResourceLoader(),
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
      cwd: "/tmp/demo",
      resourceLoader: emptyResourceLoader(),
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

describe("managed-agent-session tool registry orchestration", () => {
  test("refreshTools applies the registry-owned tool set and recomputes the base prompt", () => {
    const probe = createOrchestrationProbe();
    probe.registry.replaceAll([makeTool("read"), makeTool("write")]);

    probe.registry.refreshTools(probe.deps);

    expect(probe.activeAgentTools.map((tool) => tool.name)).toEqual(["read", "write"]);
    expect(probe.calls).toHaveLength(1);
    expect(probe.calls[0]?.kind).toBe("base-context");
    expect(probe.registry.currentBaseSystemPrompt).toContain("Use read carefully");
    expect(probe.registry.currentBaseSystemPrompt).toContain("Use write carefully");
    expect(probe.calls[0]?.systemPrompt).toBe(probe.registry.currentBaseSystemPrompt);
  });

  test("registerHostedTool then refreshTools keeps a single registry-owned source of truth", () => {
    const probe = createOrchestrationProbe();
    probe.registry.replaceAll([makeTool("read")]);
    probe.registry.refreshTools(probe.deps);

    // Late registration must be visible to a subsequent refresh, proving there
    // is no stale duplicate array feeding replaceAll.
    probe.registry.registerHostedTool(makeTool("late"), probe.deps);
    expect(probe.registry.listRegisteredTools().map((tool) => tool.name)).toEqual(["read", "late"]);

    probe.registry.refreshTools(probe.deps);
    expect(probe.activeAgentTools.map((tool) => tool.name)).toEqual(["read", "late"]);
  });

  test("registerHostedTool recomputes prompt only (applyBaseSystemPrompt), not tools", () => {
    const probe = createOrchestrationProbe();
    probe.registry.replaceAll([makeTool("read")]);
    probe.registry.refreshTools(probe.deps);
    const toolsAfterRefresh = probe.activeAgentTools;
    probe.calls.length = 0;

    probe.registry.registerHostedTool(makeTool("late"), probe.deps);

    expect(probe.calls).toHaveLength(1);
    expect(probe.calls[0]?.kind).toBe("base-system-prompt");
    // Tools surface is untouched by registerHostedTool (prompt-only path).
    expect(probe.activeAgentTools).toBe(toolsAfterRefresh);
    expect(probe.calls[0]?.systemPrompt).toBe(probe.registry.currentBaseSystemPrompt);
  });

  test("setActiveTools narrows the active tool set via applyBaseContext", () => {
    const probe = createOrchestrationProbe();
    probe.registry.replaceAll([makeTool("read"), makeTool("write")]);
    probe.registry.refreshTools(probe.deps);
    probe.calls.length = 0;

    probe.registry.setActiveTools(["write"], probe.deps);

    expect(probe.calls).toHaveLength(1);
    expect(probe.calls[0]?.kind).toBe("base-context");
    expect(probe.activeAgentTools.map((tool) => tool.name)).toEqual(["write"]);
    expect(probe.registry.currentBaseSystemPrompt).toContain("Use write carefully");
    expect(probe.registry.currentBaseSystemPrompt).not.toContain("Use read carefully");
  });
});
