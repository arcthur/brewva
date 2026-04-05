import { describe, expect, test } from "bun:test";
import {
  registerToolSurface,
  type ToolSurfaceRuntime,
} from "@brewva/brewva-gateway/runtime-plugins";
import type { SkillRegistryLoadReport, SkillRoutingScope, TaskPhase } from "@brewva/brewva-runtime";
import { recordRuntimeEvent } from "@brewva/brewva-runtime/internal";
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
  options: {
    markdown?: string;
    selection?: {
      whenToUse: string;
      examples?: string[];
      paths?: string[];
      phases?: TaskPhase[];
    };
  } = {},
) {
  return {
    name,
    description: `${name} skill`,
    category: "domain" as const,
    markdown: options.markdown ?? "",
    contract: {
      name,
      category: "domain" as const,
      routing: options.selection
        ? {
            scope: "domain" as const,
          }
        : undefined,
      selection: options.selection,
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
  getActive?: ToolSurfaceRuntime["inspect"]["skills"]["getActive"];
  getSkill?: ToolSurfaceRuntime["inspect"]["skills"]["get"];
  listSkills?: ToolSurfaceRuntime["inspect"]["skills"]["list"];
  taskState?: ReturnType<ToolSurfaceRuntime["inspect"]["task"]["getState"]>;
  recordEvent?: ToolSurfaceRuntime["recordEvent"];
  routingScopes?: SkillRoutingScope[];
}

function createToolSurfaceRuntime(options: ToolSurfaceRuntimeOptions = {}): ToolSurfaceRuntime {
  const runtime = createBaseRuntimeFixture({
    config: createRuntimeConfig((config) => {
      config.skills.routing.enabled = true;
      config.skills.routing.scopes = options.routingScopes ?? ["core", "domain"];
    }),
  });
  const listSkills = options.listSkills ?? (() => []);
  const routingScopes = options.routingScopes ?? ["core", "domain"];
  const buildLoadReport = (): SkillRegistryLoadReport => {
    const skills = listSkills();
    const loadedSkills = skills.map((skill) => skill.name);
    const routableSkills = skills
      .filter((skill) => {
        const scope = skill.contract.routing?.scope;
        return typeof scope === "string" && routingScopes.includes(scope);
      })
      .map((skill) => skill.name);
    return {
      roots: [],
      loadedSkills,
      routingEnabled: true,
      routingScopes,
      routableSkills,
      hiddenSkills: loadedSkills.filter((name) => !routableSkills.includes(name)),
      overlaySkills: [],
      sharedContextFiles: [],
      categories: {
        core: [],
        domain: [],
        operator: [],
        meta: [],
        internal: [],
      },
    };
  };
  Object.assign(runtime.inspect.skills, {
    list: listSkills,
    getActive: options.getActive ?? (() => undefined),
    get: options.getSkill ?? (() => undefined),
    getLoadReport: buildLoadReport,
  });
  if (options.taskState) {
    Object.assign(runtime.inspect.task, {
      getState: () => options.taskState!,
    });
  }
  return {
    config: runtime.config,
    inspect: {
      tools: runtime.inspect.tools,
      skills: runtime.inspect.skills,
      task: runtime.inspect.task,
    },
    recordEvent: options.recordEvent ?? ((input) => recordRuntimeEvent(runtime, input)),
  };
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

  test("missing task spec prunes default repository tools into the bootstrap surface", async () => {
    const extensionApi = createMockRuntimePluginApi();
    registerTools(extensionApi.api, [
      "read",
      "edit",
      "write",
      "session_compact",
      "skill_load",
      "workflow_status",
      "task_set_spec",
      "task_view_state",
      "knowledge_search",
      "output_search",
      "grep",
    ]);

    const events: Array<Record<string, unknown>> = [];
    const runtime = createToolSurfaceRuntime({
      listSkills: () => [
        createSkillDocument(
          "runtime-forensics",
          ["workspace_read", "runtime_observe"],
          ["ledger_query"],
          {
            selection: {
              whenToUse:
                "Use when the task asks what happened at runtime and the answer must come from traces, ledgers, projections, or artifacts.",
              examples: [
                "Analyze this session trace.",
                "Explain the runtime events and ledger evidence.",
              ],
              paths: [".orchestrator", ".brewva"],
              phases: ["investigate", "verify"],
            },
          },
        ),
        createSkillDocument(
          "repository-analysis",
          ["workspace_read", "runtime_observe"],
          ["read"],
          {
            selection: {
              whenToUse:
                "Use when the task needs repository orientation, impact analysis, or boundary mapping before implementation.",
              examples: [
                "Analyze this repository before changing code.",
                "Map the impacted modules and boundaries.",
              ],
              phases: ["align", "investigate"],
            },
          },
        ),
      ],
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
        prompt: "分析这个 session trace、runtime 事件、ledger 和 projection，看看是否合理。",
      },
      {
        sessionManager: {
          getSessionId: () => "tool-surface-skill-first",
        },
      },
    );

    expect(extensionApi.activeTools).not.toContain("read");
    expect(extensionApi.activeTools).not.toContain("edit");
    expect(extensionApi.activeTools).not.toContain("write");
    expect(extensionApi.activeTools).toContain("skill_load");
    expect(extensionApi.activeTools).toContain("workflow_status");
    expect(extensionApi.activeTools).toContain("task_set_spec");

    const event = events.find((input) => input.type === "tool_surface_resolved") as
      | { payload?: Record<string, unknown> }
      | undefined;
    expect(event?.payload?.skillGateMode).toBe("task_spec_required");
    expect(event?.payload?.taskSpecReady).toBe(false);
    expect(event?.payload?.recommendedSkillNames).toEqual([]);
  });

  test("task spec updates can trigger same-turn skill-first recovery for multilingual prompts", async () => {
    const extensionApi = createMockRuntimePluginApi();
    registerTools(extensionApi.api, [
      "read",
      "edit",
      "write",
      "session_compact",
      "skill_load",
      "workflow_status",
      "task_set_spec",
      "task_view_state",
      "task_add_item",
      "task_update_item",
      "task_record_blocker",
      "task_resolve_blocker",
      "knowledge_search",
      "output_search",
    ]);

    let taskState:
      | {
          spec?: unknown;
          status?: {
            phase?: string;
          };
          items?: unknown[];
          blockers?: unknown[];
          updatedAt?: unknown;
        }
      | undefined;
    const events: Array<Record<string, unknown>> = [];

    const runtime = createToolSurfaceRuntime({
      listSkills: () => [
        createSkillDocument(
          "learning-research",
          ["workspace_read", "runtime_observe"],
          ["knowledge_search"],
          {
            markdown: [
              "# Learning Research",
              "",
              "## Trigger",
              "",
              "- planning posture is `moderate`, `complex`, or `high_risk`",
              "- review needs repository precedent rather than only diff-local reasoning",
            ].join("\n"),
            selection: {
              whenToUse:
                "Use when a non-trivial task needs repository precedents, prior failure patterns, or preventive guidance before deeper execution.",
              examples: [
                "Find prior repository solutions for this problem.",
                "Look up precedent before we implement this.",
                "Gather repository-specific guidance for this debugging task.",
              ],
              phases: ["align", "investigate"],
            },
          },
        ),
      ],
      taskState,
      recordEvent: (input: Record<string, unknown>) => {
        events.push(input);
        return undefined;
      },
    });
    Object.assign(runtime.inspect.task, {
      getState: () => taskState,
    });

    registerToolSurface(extensionApi.api, runtime);
    await invokeHandlerAsync(
      extensionApi.handlers,
      "before_agent_start",
      {
        type: "before_agent_start",
        prompt:
          "对比下本项目和 /Users/bytedance/new_py/kimi-cli，这是一个高质量的 agent 架构实现，我想知道从你的角度，有什么可以从 kimi-cli 学习的，可以帮我大幅度增强能力，或减化实现达到更好的效果",
      },
      {
        sessionManager: {
          getSessionId: () => "tool-surface-multilingual-recovery",
        },
      },
    );

    expect(extensionApi.activeTools).not.toContain("read");
    expect(extensionApi.activeTools).not.toContain("knowledge_search");
    expect(extensionApi.activeTools).toContain("task_set_spec");
    expect(extensionApi.activeTools).toContain("workflow_status");

    taskState = {
      spec: {
        goal: "Compare the current Brewva project with the local kimi-cli repository and identify architecture patterns, capability enablers, and simplifications Brewva could adopt for stronger agent behavior or lower implementation complexity.",
        targets: {
          files: [
            "AGENTS.md",
            "docs/architecture/system-architecture.md",
            "docs/reference/runtime.md",
            "/Users/bytedance/new_py/kimi-cli",
          ],
          symbols: ["BrewvaRuntime"],
        },
        expectedBehavior:
          "Produce an evidence-backed comparison of architecture, strengths, gaps, and concrete recommendations prioritized by leverage and implementation complexity.",
        constraints: [
          "Read-only investigation",
          "Consult repository-native solution docs via knowledge_search for non-trivial review work",
          "Prefer authoritative docs and key entrypoints over broad speculation",
        ],
      },
      status: { phase: "investigate" },
      items: [],
      blockers: [],
      updatedAt: null,
    };

    const result = await invokeHandlerAsync<{ content?: Array<{ text?: string }> }>(
      extensionApi.handlers,
      "tool_result",
      {
        type: "tool_result",
        toolName: "task_set_spec",
        toolCallId: "tc-task-set-spec",
        isError: false,
        content: [{ type: "text", text: "TaskSpec recorded." }],
      },
      {
        sessionManager: {
          getSessionId: () => "tool-surface-multilingual-recovery",
        },
      },
    );

    expect(extensionApi.activeTools).not.toContain("read");
    expect(extensionApi.activeTools).not.toContain("knowledge_search");
    expect(extensionApi.activeTools).toContain("skill_load");
    expect(extensionApi.activeTools).toContain("task_set_spec");
    expect(result?.content?.[0]?.text).toContain("[Brewva Skill-First Refresh]");
    expect(result?.content?.[0]?.text).toContain("learning-research");
    const recommendationEvent = events.findLast(
      (input) => input.type === "skill_recommendation_derived",
    ) as { payload?: Record<string, unknown> } | undefined;
    expect(recommendationEvent?.payload?.gateMode).toBe("skill_load_required");
    expect(recommendationEvent?.payload?.taskSpecReady).toBe(true);
    expect(recommendationEvent?.payload?.recommendations).toEqual([
      expect.objectContaining({
        name: "learning-research",
        primary: true,
      }),
    ]);
  });

  test("task-state mutation re-evaluation reuses a single recommendation pass", async () => {
    const extensionApi = createMockRuntimePluginApi();
    registerTools(extensionApi.api, [
      "read",
      "edit",
      "write",
      "session_compact",
      "skill_load",
      "workflow_status",
      "task_set_spec",
      "task_view_state",
      "task_add_item",
      "task_update_item",
      "task_record_blocker",
      "task_resolve_blocker",
      "knowledge_search",
    ]);

    let taskState = {
      spec: {
        goal: "Find repository precedents and architecture patterns that improve agent behavior.",
        expectedBehavior:
          "Route the investigation through the most relevant repository-analysis skill before deeper tool work.",
        constraints: ["Read-only investigation"],
      },
      status: { phase: "investigate" },
      items: [],
      blockers: [],
      updatedAt: null,
    };
    let getStateCalls = 0;

    const runtime = createToolSurfaceRuntime({
      listSkills: () => [
        createSkillDocument(
          "learning-research",
          ["workspace_read", "runtime_observe"],
          ["knowledge_search"],
          {
            markdown: [
              "# Learning Research",
              "",
              "## Trigger",
              "",
              "- investigate repository precedent",
            ].join("\n"),
            selection: {
              whenToUse:
                "Use when a non-trivial task needs repository precedents, prior failure patterns, or preventive guidance before deeper execution.",
              examples: ["Look up precedent before we implement this."],
              phases: ["investigate"],
            },
          },
        ),
      ],
    });
    Object.assign(runtime.inspect.task, {
      getState: () => {
        getStateCalls += 1;
        return taskState;
      },
    });

    registerToolSurface(extensionApi.api, runtime);
    await invokeHandlerAsync(
      extensionApi.handlers,
      "before_agent_start",
      {
        type: "before_agent_start",
        prompt: "请先看看仓库里有没有类似的先例，然后再决定怎么推进实现",
      },
      {
        sessionManager: {
          getSessionId: () => "tool-surface-single-pass",
        },
      },
    );

    getStateCalls = 0;
    const result = await invokeHandlerAsync(
      extensionApi.handlers,
      "tool_result",
      {
        type: "tool_result",
        toolName: "task_set_spec",
        toolCallId: "tc-task-set-spec-single-pass",
        isError: false,
        content: [{ type: "text", text: "TaskSpec already recorded." }],
      },
      {
        sessionManager: {
          getSessionId: () => "tool-surface-single-pass",
        },
      },
    );

    expect(result).toBeUndefined();
    expect(getStateCalls).toBe(1);
  });

  test("session shutdown clears cached tool-surface session state", async () => {
    const extensionApi = createMockRuntimePluginApi();
    registerTools(extensionApi.api, [
      "read",
      "edit",
      "write",
      "session_compact",
      "skill_load",
      "workflow_status",
      "task_set_spec",
      "task_view_state",
      "task_add_item",
      "task_update_item",
      "task_record_blocker",
      "task_resolve_blocker",
      "knowledge_search",
      "output_search",
    ]);

    let taskState:
      | {
          spec?: unknown;
          status?: {
            phase?: string;
          };
          items?: unknown[];
          blockers?: unknown[];
          updatedAt?: unknown;
        }
      | undefined;
    const events: Array<Record<string, unknown>> = [];

    const runtime = createToolSurfaceRuntime({
      listSkills: () => [
        createSkillDocument(
          "learning-research",
          ["workspace_read", "runtime_observe"],
          ["knowledge_search"],
          {
            markdown: [
              "# Learning Research",
              "",
              "## Trigger",
              "",
              "- investigate repository precedent",
            ].join("\n"),
            selection: {
              whenToUse:
                "Use when a non-trivial task needs repository precedents, prior failure patterns, or preventive guidance before deeper execution.",
              examples: ["Find prior repository solutions for this problem."],
              phases: ["investigate"],
            },
          },
        ),
      ],
      recordEvent: (input: Record<string, unknown>) => {
        events.push(input);
        return undefined;
      },
    });
    Object.assign(runtime.inspect.task, {
      getState: () => taskState,
    });

    registerToolSurface(extensionApi.api, runtime);
    await invokeHandlerAsync(
      extensionApi.handlers,
      "before_agent_start",
      {
        type: "before_agent_start",
        prompt: "先帮我看下仓库里有没有类似问题的先例",
      },
      {
        sessionManager: {
          getSessionId: () => "tool-surface-session-shutdown",
        },
      },
    );

    await invokeHandlerAsync(
      extensionApi.handlers,
      "session_shutdown",
      {
        type: "session_shutdown",
      },
      {
        sessionManager: {
          getSessionId: () => "tool-surface-session-shutdown",
        },
      },
    );

    taskState = {
      spec: {
        goal: "Find repository precedents and summarize the strongest architecture recommendations.",
        expectedBehavior:
          "Re-enter skill-first routing and require the relevant research skill before broader tool use.",
        constraints: ["Read-only investigation"],
      },
      status: { phase: "investigate" },
      items: [],
      blockers: [],
      updatedAt: null,
    };

    const result = await invokeHandlerAsync(
      extensionApi.handlers,
      "tool_result",
      {
        type: "tool_result",
        toolName: "task_set_spec",
        toolCallId: "tc-task-set-spec-after-shutdown",
        isError: false,
        content: [{ type: "text", text: "TaskSpec recorded after shutdown." }],
      },
      {
        sessionManager: {
          getSessionId: () => "tool-surface-session-shutdown",
        },
      },
    );

    expect(result).toBeUndefined();
    expect(events.filter((input) => input.type === "tool_surface_resolved")).toHaveLength(1);
    expect(events.filter((input) => input.type === "skill_recommendation_derived")).toHaveLength(0);
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
