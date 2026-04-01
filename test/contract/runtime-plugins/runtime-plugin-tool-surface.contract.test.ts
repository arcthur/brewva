import { describe, expect, test } from "bun:test";
import {
  registerToolSurface,
  type ToolSurfaceRuntime,
} from "@brewva/brewva-gateway/runtime-plugins";
import type { SkillRoutingScope } from "@brewva/brewva-runtime";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import type { ToolInfo } from "@mariozechner/pi-coding-agent";
import { createMockRuntimePluginApi, invokeHandlerAsync } from "../../helpers/runtime-plugin.js";
import {
  createRuntimeConfig,
  createRuntimeFixture as createBaseRuntimeFixture,
} from "../../helpers/runtime.js";

const EMPTY_PARAMETERS = {
  type: "object",
  properties: {},
} as unknown as ToolInfo["parameters"];

function createToolDefinition(name: string): ToolDefinition {
  return {
    name,
    label: name,
    description: `${name} description`,
    parameters: EMPTY_PARAMETERS,
    async execute() {
      return {
        content: [{ type: "text", text: name }],
        details: {},
      };
    },
  };
}

function registerTools(
  api: ReturnType<typeof createMockRuntimePluginApi>["api"],
  names: string[],
): void {
  for (const name of names) {
    api.registerTool(createToolDefinition(name));
  }
}

function createSkillDocument(
  name: string,
  allowedEffects: Array<"workspace_read" | "runtime_observe" | "local_exec">,
  preferredTools: string[],
) {
  return {
    name,
    contract: {
      name,
      category: "domain" as const,
      effects: {
        allowedEffects,
        deniedEffects: [],
      },
      resources: {
        defaultLease: { maxToolCalls: 10, maxTokens: 10000 },
        hardCeiling: { maxToolCalls: 20, maxTokens: 20000 },
      },
      executionHints: {
        preferredTools,
        fallbackTools: [],
      },
    },
  };
}

interface ToolSurfaceRuntimeOptions {
  getActive?: ToolSurfaceRuntime["skills"]["getActive"];
  getSkill?: ToolSurfaceRuntime["skills"]["get"];
  taskState?: ReturnType<ToolSurfaceRuntime["task"]["getState"]>;
  recordEvent?: ToolSurfaceRuntime["events"]["record"];
  routingScopes?: SkillRoutingScope[];
}

function createToolSurfaceRuntime(options: ToolSurfaceRuntimeOptions = {}): ToolSurfaceRuntime {
  const runtime = createBaseRuntimeFixture({
    config: createRuntimeConfig((config) => {
      config.skills.routing.enabled = true;
      config.skills.routing.scopes = options.routingScopes ?? ["core", "domain"];
    }),
  });
  Object.assign(runtime.skills, {
    getActive: options.getActive ?? (() => undefined),
    get: options.getSkill ?? (() => undefined),
  });
  if (options.taskState) {
    Object.assign(runtime.task, {
      getState: () => options.taskState!,
    });
  }
  Object.assign(runtime.events, {
    record: options.recordEvent ?? (() => undefined),
  });
  return runtime;
}

describe("tool surface runtime plugin", () => {
  test("activates base and skill-scoped tools from the current active skill", async () => {
    const extensionApi = createMockRuntimePluginApi();
    registerTools(extensionApi.api, [
      "read",
      "edit",
      "write",
      "session_compact",
      "skill_load",
      "workflow_status",
      "grep",
      "toc_document",
      "exec",
      "skill_complete",
      "obs_query",
    ]);

    const events: Array<Record<string, unknown>> = [];
    const runtime = createToolSurfaceRuntime({
      getActive: () =>
        createSkillDocument(
          "debugging",
          ["workspace_read", "runtime_observe", "local_exec"],
          ["exec"],
        ),
      getSkill: (name: string) =>
        name === "debugging"
          ? createSkillDocument(
              "debugging",
              ["workspace_read", "runtime_observe", "local_exec"],
              ["exec"],
            )
          : undefined,
      recordEvent: (input: Record<string, unknown>) => {
        events.push(input);
        return undefined;
      },
    });

    registerToolSurface(extensionApi.api, runtime);
    await invokeHandlerAsync(
      extensionApi.handlers,
      "before_agent_start",
      {
        type: "before_agent_start",
        prompt: "investigate the failure",
      },
      {
        sessionManager: {
          getSessionId: () => "tool-surface-s1",
        },
      },
    );

    expect(extensionApi.activeTools).toContain("session_compact");
    expect(extensionApi.activeTools).toContain("skill_load");
    expect(extensionApi.activeTools).toContain("workflow_status");
    expect(extensionApi.activeTools).toContain("grep");
    expect(extensionApi.activeTools).toContain("exec");
    expect(extensionApi.activeTools).toContain("skill_complete");
    expect(extensionApi.activeTools).not.toContain("obs_query");
    expect(events.map((event) => event.type)).toContain("tool_surface_resolved");
  });

  test("explicit capability requests can surface managed tools for one turn after skill activation", async () => {
    const extensionApi = createMockRuntimePluginApi();
    registerTools(extensionApi.api, [
      "read",
      "edit",
      "write",
      "session_compact",
      "skill_load",
      "task_view_state",
      "obs_query",
    ]);

    const runtime = createToolSurfaceRuntime({
      getActive: () =>
        createSkillDocument(
          "debugging",
          ["workspace_read", "runtime_observe", "local_exec"],
          ["read"],
        ),
      getSkill: (name: string) =>
        name === "debugging"
          ? createSkillDocument(
              "debugging",
              ["workspace_read", "runtime_observe", "local_exec"],
              ["read"],
            )
          : undefined,
    });

    registerToolSurface(extensionApi.api, runtime);
    await invokeHandlerAsync(
      extensionApi.handlers,
      "before_agent_start",
      {
        type: "before_agent_start",
        prompt: "Use $task_view_state and $obs_query to inspect current runtime events.",
      },
      {
        sessionManager: {
          getSessionId: () => "tool-surface-s2",
        },
      },
    );

    expect(extensionApi.activeTools).toContain("task_view_state");
    expect(extensionApi.activeTools).toContain("obs_query");
  });

  test("explicit operator capability requests surface operator tools without an active skill", async () => {
    const extensionApi = createMockRuntimePluginApi();
    registerTools(extensionApi.api, [
      "read",
      "edit",
      "write",
      "session_compact",
      "skill_load",
      "workflow_status",
      "obs_query",
      "narrative_memory",
    ]);

    const runtime = createToolSurfaceRuntime();

    registerToolSurface(extensionApi.api, runtime);
    await invokeHandlerAsync(
      extensionApi.handlers,
      "before_agent_start",
      {
        type: "before_agent_start",
        prompt: "Use $obs_query and $narrative_memory if they would help.",
      },
      {
        sessionManager: {
          getSessionId: () => "tool-surface-operator-request-no-skill",
        },
      },
    );

    expect(extensionApi.activeTools).toContain("obs_query");
    expect(extensionApi.activeTools).toContain("narrative_memory");
  });

  test("operator profile exposes operator tools even before any skill is active", async () => {
    const extensionApi = createMockRuntimePluginApi();
    registerTools(extensionApi.api, [
      "read",
      "edit",
      "write",
      "session_compact",
      "skill_load",
      "workflow_status",
      "cost_view",
      "obs_query",
      "narrative_memory",
    ]);

    const runtime = createToolSurfaceRuntime({
      routingScopes: ["core", "operator"],
    });

    registerToolSurface(extensionApi.api, runtime);
    await invokeHandlerAsync(
      extensionApi.handlers,
      "before_agent_start",
      {
        type: "before_agent_start",
        prompt: "inspect the workspace state",
      },
      {
        sessionManager: {
          getSessionId: () => "tool-surface-operator-profile-no-skill",
        },
      },
    );

    expect(extensionApi.activeTools).toContain("cost_view");
    expect(extensionApi.activeTools).toContain("obs_query");
    expect(extensionApi.activeTools).toContain("narrative_memory");
  });

  test("tool surface records which requested managed tools were activated after admission", async () => {
    const extensionApi = createMockRuntimePluginApi();
    registerTools(extensionApi.api, [
      "read",
      "edit",
      "write",
      "session_compact",
      "skill_load",
      "task_view_state",
      "obs_query",
    ]);

    const events: Array<Record<string, unknown>> = [];
    const runtime = createToolSurfaceRuntime({
      getActive: () =>
        createSkillDocument(
          "debugging",
          ["workspace_read", "runtime_observe", "local_exec"],
          ["read"],
        ),
      getSkill: (name: string) =>
        name === "debugging"
          ? createSkillDocument(
              "debugging",
              ["workspace_read", "runtime_observe", "local_exec"],
              ["read"],
            )
          : undefined,
      recordEvent: (input: Record<string, unknown>) => {
        events.push(input);
        return undefined;
      },
    });

    registerToolSurface(extensionApi.api, runtime);
    await invokeHandlerAsync(
      extensionApi.handlers,
      "before_agent_start",
      {
        type: "before_agent_start",
        prompt: "Use $task_view_state and $obs_query to inspect the current state.",
      },
      {
        sessionManager: {
          getSessionId: () => "tool-surface-s3",
        },
      },
    );

    expect(extensionApi.activeTools).toContain("task_view_state");
    expect(extensionApi.activeTools).toContain("obs_query");
    const event = events.find((input) => input.type === "tool_surface_resolved") as
      | { payload?: Record<string, unknown> }
      | undefined;
    expect(event?.payload?.requestedActivatedToolNames).toEqual(["task_view_state", "obs_query"]);
    expect(event?.payload?.ignoredRequestedToolNames).toEqual([]);
  });

  test("investigation lifecycle tools stay visible while the session has no task spec", async () => {
    const extensionApi = createMockRuntimePluginApi();
    registerTools(extensionApi.api, [
      "read",
      "edit",
      "write",
      "session_compact",
      "task_set_spec",
      "task_view_state",
      "workflow_status",
      "task_add_item",
      "task_record_blocker",
      "ledger_query",
      "output_search",
      "tape_search",
      "tape_handoff",
    ]);

    const runtime = createToolSurfaceRuntime({
      taskState: {
        items: [],
        blockers: [],
        updatedAt: null,
      },
      getActive: () =>
        createSkillDocument("repository-analysis", ["workspace_read", "runtime_observe"], ["read"]),
      getSkill: (name: string) =>
        name === "repository-analysis"
          ? createSkillDocument(
              "repository-analysis",
              ["workspace_read", "runtime_observe"],
              ["read"],
            )
          : undefined,
    });

    registerToolSurface(extensionApi.api, runtime);
    await invokeHandlerAsync(
      extensionApi.handlers,
      "before_agent_start",
      {
        type: "before_agent_start",
        prompt: "investigate the repository layout",
      },
      {
        sessionManager: {
          getSessionId: () => "tool-surface-s-no-spec",
        },
      },
    );

    expect(extensionApi.activeTools).toContain("task_set_spec");
    expect(extensionApi.activeTools).toContain("task_view_state");
    expect(extensionApi.activeTools).toContain("workflow_status");
    expect(extensionApi.activeTools).toContain("task_add_item");
    expect(extensionApi.activeTools).toContain("task_record_blocker");
    expect(extensionApi.activeTools).toContain("ledger_query");
    expect(extensionApi.activeTools).toContain("output_search");
    expect(extensionApi.activeTools).toContain("tape_search");
    expect(extensionApi.activeTools).toContain("tape_handoff");
  });

  test("registers missing managed tools on demand before resolving the turn surface", async () => {
    const extensionApi = createMockRuntimePluginApi();
    registerTools(extensionApi.api, ["read", "edit", "write", "session_compact", "grep", "exec"]);

    const runtime = createToolSurfaceRuntime({
      getActive: () =>
        createSkillDocument(
          "debugging",
          ["workspace_read", "runtime_observe", "local_exec"],
          ["exec"],
        ),
      getSkill: (name: string) =>
        name === "debugging"
          ? createSkillDocument(
              "debugging",
              ["workspace_read", "runtime_observe", "local_exec"],
              ["exec"],
            )
          : undefined,
    });

    const dynamicToolDefinitions = new Map(
      ["skill_load", "skill_complete", "obs_query"].map((name) => [
        name,
        createToolDefinition(name),
      ]),
    );

    registerToolSurface(extensionApi.api, runtime, {
      dynamicToolDefinitions,
    });
    await invokeHandlerAsync(
      extensionApi.handlers,
      "before_agent_start",
      {
        type: "before_agent_start",
        prompt: "Use $obs_query if needed while following the selected skill.",
      },
      {
        sessionManager: {
          getSessionId: () => "tool-surface-s4",
        },
      },
    );

    expect(extensionApi.api.getAllTools().map((tool) => tool.name)).toContain("skill_load");
    expect(extensionApi.api.getAllTools().map((tool) => tool.name)).toContain("skill_complete");
    expect(extensionApi.api.getAllTools().map((tool) => tool.name)).toContain("obs_query");
    expect(extensionApi.activeTools).toContain("skill_load");
    expect(extensionApi.activeTools).toContain("skill_complete");
    expect(extensionApi.activeTools).toContain("obs_query");
  });

  test("effect-authorized managed skill tools stay visible even when not listed in execution hints", async () => {
    const extensionApi = createMockRuntimePluginApi();
    registerTools(extensionApi.api, [
      "read",
      "edit",
      "write",
      "session_compact",
      "skill_load",
      "toc_document",
      "lsp_symbols",
      "process",
    ]);

    const runtime = createToolSurfaceRuntime({
      getActive: () =>
        createSkillDocument("repository-analysis", ["workspace_read", "runtime_observe"], ["read"]),
      getSkill: (name: string) =>
        name === "repository-analysis"
          ? createSkillDocument(
              "repository-analysis",
              ["workspace_read", "runtime_observe"],
              ["read"],
            )
          : undefined,
      taskState: {
        spec: { text: "investigate" },
        status: { phase: "implement" },
        items: [],
        blockers: [],
        updatedAt: null,
      },
    });

    registerToolSurface(extensionApi.api, runtime);
    await invokeHandlerAsync(
      extensionApi.handlers,
      "before_agent_start",
      {
        type: "before_agent_start",
        prompt: "review the current repository state",
      },
      {
        sessionManager: {
          getSessionId: () => "tool-surface-authorized-read-tools",
        },
      },
    );

    expect(extensionApi.activeTools).toContain("toc_document");
    expect(extensionApi.activeTools).toContain("lsp_symbols");
    expect(extensionApi.activeTools).toContain("process");
  });
});
