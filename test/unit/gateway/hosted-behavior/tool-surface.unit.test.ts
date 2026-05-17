import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SkillDocument } from "@brewva/brewva-runtime/skills";
import type { BrewvaToolDefinition } from "@brewva/brewva-substrate/tools";
import { Type } from "@sinclair/typebox";
import {
  createSkillSelectionLifecycle,
  createToolSurfaceLifecycle,
  registerToolSurface,
  registerTurnLifecyclePorts,
  type SkillSelectionRuntime,
  type ToolSurfaceRuntime,
} from "../../../../packages/brewva-gateway/src/hosted/internal/session/host-api-installation.js";
import { createMockExtensionApi, invokeHandlerAsync } from "../../../helpers/extension.js";
import {
  createRuntimeConfig,
  createRuntimeFixture as createBaseRuntimeFixture,
} from "../../../helpers/runtime.js";

function createToolDefinition(name: string): BrewvaToolDefinition {
  return {
    name,
    label: name,
    description: `${name} description`,
    parameters: Type.Object({}),
    async execute() {
      return {
        content: [{ type: "text", text: name }],
        details: {},
      };
    },
  };
}

function registerTools(
  api: ReturnType<typeof createMockExtensionApi>["api"],
  names: string[],
): void {
  for (const name of names) {
    api.registerTool(createToolDefinition(name));
  }
}

function createToolSurfaceRuntime(
  options: {
    capabilityRoot?: string;
    recordEvent?: ToolSurfaceRuntime["recordEvent"];
  } = {},
): ToolSurfaceRuntime {
  const runtime = createBaseRuntimeFixture({
    config: createRuntimeConfig((config) => {
      config.capabilities.roots = options.capabilityRoot ? [options.capabilityRoot] : [];
    }),
  });
  const recordedEvents: Array<{ sessionId: string; type: string; payload?: object }> = [];
  return {
    identity: runtime.identity,
    config: runtime.config,
    inspect: {
      events: {
        records: {
          query: (sessionId, query) =>
            recordedEvents
              .filter((event) => event.sessionId === sessionId && event.type === query.type)
              .map((event) => ({ payload: event.payload })),
        },
      },
    },
    recordEvent: (input) => {
      recordedEvents.push(input);
      return options.recordEvent?.(input) ?? runtime.extensions.hosted.events.record(input);
    },
  };
}

function createCapabilityRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "brewva-capability-root-"));
  writeFileSync(
    join(root, "observability-read.yaml"),
    [
      "name: observability-read",
      "provider: brewva",
      "domain: observability",
      "action: obs_query",
      "tool_names:",
      "  - obs_query",
      "resource_types:",
      "  - event",
      "risk_level: read",
      "requires_explicit_account: false",
      "requires_confirmation: false",
      "agent_scope: []",
      "workspace_scope: []",
      "conflicts_with: []",
      "side_effects: []",
      "env_allowlist: []",
      "inherit_env: false",
      "selection:",
      "  when_to_use: Use for observability event queries.",
      "",
    ].join("\n"),
    "utf8",
  );
  return root;
}

function skill(input: {
  name: string;
  description: string;
  whenToUse: string;
  markdown?: string;
}): SkillDocument {
  return {
    name: input.name,
    description: input.description,
    category: "core",
    filePath: `/skills/${input.name}/SKILL.md`,
    baseDir: `/skills/${input.name}`,
    markdown: input.markdown ?? `# ${input.name}`,
    authoredMarkdown: input.markdown ?? `# ${input.name}`,
    inheritedMarkdown: "",
    card: {
      name: input.name,
      category: "core",
      description: input.description,
      selection: {
        whenToUse: input.whenToUse,
      },
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

function createSkillCatalog(): SkillDocument[] {
  return [
    skill({
      name: "architecture",
      description:
        "Architecture improvement, refactoring opportunities, boundary quality, interface burden, seam placement, and testability.",
      whenToUse:
        "Use when a task asks for architecture improvement, refactoring opportunities, shallow module detection, boundary quality, testability improvement, or codebase AI-navigability.",
    }),
    skill({
      name: "repository-analysis",
      description:
        "Repository snapshot, impact analysis, path-grounded evidence, and boundary mapping before design, debugging, or review.",
      whenToUse:
        "Use when the task needs repository orientation, impact analysis, or boundary mapping before design, debugging, review, or execution.",
    }),
  ];
}

function createIntegratedRuntime(
  options: {
    recordEvent?: ToolSurfaceRuntime["recordEvent"];
  } = {},
): ToolSurfaceRuntime & SkillSelectionRuntime {
  const recordedEvents: Array<{ sessionId: string; type: string; payload?: object }> = [];
  const runtime = createToolSurfaceRuntime({
    recordEvent: (input) => {
      recordedEvents.push(input);
      return options.recordEvent?.(input);
    },
  });
  const skills = createSkillCatalog();
  return {
    ...runtime,
    inspect: {
      ...runtime.inspect,
      skills: {
        catalog: {
          list: () => skills,
          get: (name) => skills.find((entry) => entry.name === name),
        },
      },
      events: {
        records: {
          query: (sessionId, query) =>
            recordedEvents
              .filter((event) => event.sessionId === sessionId && event.type === query.type)
              .map((event) => ({ payload: event.payload })),
        },
      },
    },
    recordEvent: (input) => {
      recordedEvents.push(input);
      return options.recordEvent?.(input);
    },
  };
}

function createContext(sessionId = "tool-surface-session", hasUI = true) {
  return {
    hasUI,
    sessionManager: {
      getSessionId: () => sessionId,
    },
  };
}

describe("model-operated tool surface hosted behavior", () => {
  test("exposes non-operator managed tools without TaskSpec or active-skill gates", async () => {
    const extensionApi = createMockExtensionApi();
    registerTools(extensionApi.api, [
      "read",
      "edit",
      "write",
      "grep",
      "exec",
      "task_set_spec",
      "obs_query",
    ]);
    const events: Array<{ type: string; payload?: Record<string, unknown> }> = [];
    const runtime = createToolSurfaceRuntime({
      recordEvent: (input) => {
        events.push(input as { type: string; payload?: Record<string, unknown> });
        return undefined;
      },
    });

    registerToolSurface(extensionApi.api, runtime);
    await invokeHandlerAsync(
      extensionApi.handlers,
      "before_agent_start",
      { prompt: "Implement it" },
      createContext(),
    );

    expect(extensionApi.activeTools).toContain("grep");
    expect(extensionApi.activeTools).toContain("exec");
    expect(extensionApi.activeTools).toContain("task_set_spec");
    expect(extensionApi.activeTools).not.toContain("obs_query");

    const surfaceEvent = events.find((event) => event.type === "tool_surface_resolved");
    expect(surfaceEvent?.payload?.modelOperated).toBe(true);
    expect(surfaceEvent?.payload?.removedGates).toEqual(["task_spec", "repair_posture"]);
    expect(surfaceEvent?.payload?.skillSurfaceToolActiveCount).toBeGreaterThanOrEqual(0);
    expect(surfaceEvent?.payload).not.toHaveProperty("skillActiveCount");
  });

  test("keeps operator tools hidden without selected capability authority", async () => {
    const extensionApi = createMockExtensionApi();
    registerTools(extensionApi.api, ["grep", "obs_query", "obs_snapshot"]);
    const runtime = createToolSurfaceRuntime();

    registerToolSurface(extensionApi.api, runtime);
    await invokeHandlerAsync(
      extensionApi.handlers,
      "before_agent_start",
      { prompt: "Use $obs_query if useful" },
      createContext(),
    );

    expect(extensionApi.activeTools).toContain("grep");
    expect(extensionApi.activeTools).not.toContain("obs_query");
    expect(extensionApi.activeTools).not.toContain("obs_snapshot");
  });

  test("exposes selected operator capability tools and records a durable receipt", async () => {
    const extensionApi = createMockExtensionApi();
    registerTools(extensionApi.api, ["grep", "obs_query"]);
    const events: Array<{ type: string; payload?: Record<string, unknown> }> = [];
    const runtime = createToolSurfaceRuntime({
      capabilityRoot: createCapabilityRoot(),
      recordEvent: (input) => {
        events.push(input as { type: string; payload?: Record<string, unknown> });
        return undefined;
      },
    });

    registerToolSurface(extensionApi.api, runtime);
    await invokeHandlerAsync(
      extensionApi.handlers,
      "before_agent_start",
      { prompt: "/capability:observability-read inspect events", systemPrompt: "base" },
      createContext(),
    );

    expect(extensionApi.activeTools).toContain("grep");
    expect(extensionApi.activeTools).toContain("obs_query");
    expect(events.some((event) => event.type === "capability_selection_recorded")).toBe(true);
  });

  test("carries previous capability receipt on tool-only turns", async () => {
    const extensionApi = createMockExtensionApi();
    registerTools(extensionApi.api, ["grep", "obs_query"]);
    const events: Array<{ type: string; payload?: Record<string, unknown> }> = [];
    const runtime = createToolSurfaceRuntime({
      capabilityRoot: createCapabilityRoot(),
      recordEvent: (input) => {
        events.push(input as { type: string; payload?: Record<string, unknown> });
        return undefined;
      },
    });

    registerToolSurface(extensionApi.api, runtime);
    await invokeHandlerAsync(
      extensionApi.handlers,
      "before_agent_start",
      { prompt: "/capability:observability-read inspect events" },
      createContext("carry-session"),
    );
    await invokeHandlerAsync(
      extensionApi.handlers,
      "before_agent_start",
      { prompt: "" },
      createContext("carry-session"),
    );

    const receipts = events.filter((event) => event.type === "capability_selection_recorded");
    expect(receipts).toHaveLength(2);
    expect(receipts[1]?.payload?.trigger).toBe("carried");
    expect(receipts[1]?.payload?.carried_from).toBe(receipts[0]?.payload?.selection_id);
    expect(extensionApi.activeTools).toContain("obs_query");
  });

  test("threads the skill catalog into prompt context and tool-surface trace", async () => {
    const extensionApi = createMockExtensionApi();
    registerTools(extensionApi.api, ["read", "grep", "exec", "task_set_spec"]);
    const events: Array<{ type: string; payload?: Record<string, unknown> }> = [];
    const runtime = createIntegratedRuntime({
      recordEvent: (input) => {
        events.push(input as { type: string; payload?: Record<string, unknown> });
        return undefined;
      },
    });

    registerTurnLifecyclePorts(extensionApi.api, [
      createSkillSelectionLifecycle(runtime, {
        record: (input) => {
          runtime.recordEvent({
            sessionId: input.sessionId,
            type: "skill_selection_recorded",
            payload: input.receipt,
          });
        },
      }),
      createToolSurfaceLifecycle(extensionApi.api, runtime),
    ]);
    const prompt = [
      "background-and-parallelism.md",
      "context",
      zh(0x67b6, 0x6784, 0x8bbe, 0x8ba1),
      zh(0x94fe, 0x8def),
      zh(0x8fc7, 0x5ea6, 0x590d, 0x6742),
      zh(0x8fb9, 0x754c),
      zh(0x6587, 0x6863),
    ].join(" ");

    const result = await invokeHandlerAsync<{ systemPrompt?: string }>(
      extensionApi.handlers,
      "before_agent_start",
      { prompt, systemPrompt: "base" },
      createContext("selected-skill-tool-surface"),
    );

    expect(result.systemPrompt).toContain("Available Brewva Skills");
    expect(result.systemPrompt).toContain("architecture");
    expect(result.systemPrompt).toContain("repository-analysis");
    expect(events.some((event) => event.type === "skill_selection_recorded")).toBe(true);
    const surfaceEvent = events.find((event) => event.type === "tool_surface_resolved");
    expect(surfaceEvent?.payload?.explicitSkillMentionNames).toEqual([]);
    expect(surfaceEvent?.payload?.skillSelectionId).toEqual(expect.any(String));
    expect(surfaceEvent?.payload?.skillSelectionMode).toBe("available_catalog_prompt_context");
    expect(surfaceEvent?.payload?.skillSurfaceToolActiveCount).toBeGreaterThanOrEqual(0);
    expect(surfaceEvent?.payload).not.toHaveProperty("skillActiveCount");
  });

  test("registers dynamic non-operator tools eagerly and leaves operator tools scoped", async () => {
    const extensionApi = createMockExtensionApi();
    registerTools(extensionApi.api, ["read"]);
    const dynamicToolDefinitions = new Map<string, BrewvaToolDefinition>([
      ["grep", createToolDefinition("grep")],
      ["workbench_compact", createToolDefinition("workbench_compact")],
      ["obs_query", createToolDefinition("obs_query")],
    ]);
    const runtime = createToolSurfaceRuntime();

    registerToolSurface(extensionApi.api, runtime, { dynamicToolDefinitions });
    await invokeHandlerAsync(
      extensionApi.handlers,
      "before_agent_start",
      { prompt: "" },
      createContext(),
    );

    expect(extensionApi.activeTools).toContain("grep");
    expect(extensionApi.activeTools).toContain("workbench_compact");
    expect(extensionApi.activeTools).not.toContain("obs_query");
  });

  test("hides interactive question when the host has no UI", async () => {
    const extensionApi = createMockExtensionApi();
    registerTools(extensionApi.api, ["question", "grep"]);
    const runtime = createToolSurfaceRuntime();

    registerToolSurface(extensionApi.api, runtime);
    await invokeHandlerAsync(
      extensionApi.handlers,
      "before_agent_start",
      { prompt: "Need input" },
      createContext("headless-tool-surface", false),
    );

    expect(extensionApi.activeTools).toContain("grep");
    expect(extensionApi.activeTools).not.toContain("question");
  });
});
