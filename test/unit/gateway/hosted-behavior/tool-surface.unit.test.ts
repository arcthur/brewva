import { describe, expect, test } from "bun:test";
import type { SkillRoutingScope } from "@brewva/brewva-runtime/skills";
import type { BrewvaToolDefinition } from "@brewva/brewva-substrate/tools";
import { Type } from "@sinclair/typebox";
import {
  registerToolSurface,
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
    routingScopes?: readonly SkillRoutingScope[];
    recordEvent?: ToolSurfaceRuntime["recordEvent"];
  } = {},
): ToolSurfaceRuntime {
  const runtime = createBaseRuntimeFixture({
    config: createRuntimeConfig((config) => {
      config.skills.routing.scopes = [...(options.routingScopes ?? ["core", "domain"])];
    }),
  });
  return {
    config: runtime.config,
    recordEvent: options.recordEvent ?? ((input) => runtime.extensions.hosted.events.record(input)),
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
    expect(surfaceEvent?.payload?.removedGates).toEqual([
      "task_spec",
      "active_skill",
      "repair_posture",
    ]);
  });

  test("keeps operator tools behind operator scope instead of skill routing", async () => {
    const extensionApi = createMockExtensionApi();
    registerTools(extensionApi.api, ["grep", "obs_query", "obs_snapshot"]);
    const runtime = createToolSurfaceRuntime({ routingScopes: ["core", "domain", "operator"] });

    registerToolSurface(extensionApi.api, runtime);
    await invokeHandlerAsync(
      extensionApi.handlers,
      "before_agent_start",
      { prompt: "Use $obs_query if useful" },
      createContext(),
    );

    expect(extensionApi.activeTools).toContain("grep");
    expect(extensionApi.activeTools).toContain("obs_query");
    expect(extensionApi.activeTools).toContain("obs_snapshot");
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
