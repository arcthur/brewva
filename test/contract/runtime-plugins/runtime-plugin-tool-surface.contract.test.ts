import { describe, expect, test } from "bun:test";
import {
  deriveSkillDiagnoses,
  registerToolSurface,
  type ToolSurfaceRuntime,
} from "@brewva/brewva-gateway/runtime-plugins";
import { SKILL_REPAIR_ALLOWED_TOOL_NAMES } from "@brewva/brewva-runtime";
import type {
  SkillCompletionFailureRecord,
  SkillRegistryLoadReport,
  SkillRoutingScope,
  ToolEffectClass,
  ToolActionPolicy,
} from "@brewva/brewva-runtime";
import {
  buildSkillRoutingCatalogEntry,
  buildSkillSelectionProfile,
  hasSelectionProfileSignals,
} from "@brewva/brewva-runtime";
import type { BrewvaToolDefinition } from "@brewva/brewva-substrate";
import { Type } from "@sinclair/typebox";
import { createMockRuntimePluginApi, invokeHandlerAsync } from "../../helpers/runtime-plugin.js";
import {
  createRuntimeConfig,
  createRuntimeFixture as createBaseRuntimeFixture,
} from "../../helpers/runtime.js";

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
  api: ReturnType<typeof createMockRuntimePluginApi>["api"],
  names: string[],
): void {
  for (const name of names) {
    api.registerTool(createToolDefinition(name));
  }
}

function createSkillDocument(
  name: string,
  allowedEffects: ToolEffectClass[],
  preferredTools: string[],
  options: {
    markdown?: string;
    authoredMarkdown?: string;
    requires?: string[];
    consumes?: string[];
    selection?: {
      whenToUse: string;
      paths?: string[];
    };
  } = {},
) {
  return {
    name,
    description: `${name} skill`,
    category: "domain" as const,
    filePath: `/tmp/skills/domain/${name}/SKILL.md`,
    baseDir: `/tmp/skills/domain/${name}`,
    markdown: options.markdown ?? "",
    authoredMarkdown: options.authoredMarkdown ?? options.markdown ?? "",
    contract: {
      name,
      category: "domain" as const,
      routing: options.selection
        ? {
            scope: "domain" as const,
          }
        : undefined,
      selection: options.selection,
      requires: options.requires,
      consumes: options.consumes,
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
  getActiveState?: ToolSurfaceRuntime["inspect"]["skills"]["getActiveState"];
  getReadiness?: NonNullable<ToolSurfaceRuntime["inspect"]["skills"]["getReadiness"]>;
  getSkill?: ToolSurfaceRuntime["inspect"]["skills"]["get"];
  listSkills?: ToolSurfaceRuntime["inspect"]["skills"]["list"];
  taskState?: ReturnType<ToolSurfaceRuntime["inspect"]["task"]["getState"]>;
  latestFailure?: SkillCompletionFailureRecord;
  recordEvent?: ToolSurfaceRuntime["recordEvent"];
  routingScopes?: SkillRoutingScope[];
  routingEnabled?: boolean;
  actionPolicies?: Array<{
    toolName: string;
    policy: ToolActionPolicy;
  }>;
}

function createToolSurfaceRuntime(options: ToolSurfaceRuntimeOptions = {}): ToolSurfaceRuntime {
  const runtime = createBaseRuntimeFixture({
    config: createRuntimeConfig((config) => {
      config.skills.routing.enabled = options.routingEnabled ?? true;
      config.skills.routing.scopes = options.routingScopes ?? ["core", "domain"];
    }),
  });
  for (const registration of options.actionPolicies ?? []) {
    runtime.maintain.tools.registerActionPolicy(registration.toolName, registration.policy);
  }
  const listSkills = options.listSkills ?? (() => []);
  const routingScopes = options.routingScopes ?? ["core", "domain"];
  const isRoutableSkill = (skill: ReturnType<typeof listSkills>[number]): boolean => {
    const scope = skill.contract.routing?.scope;
    const hasSelectionSignal = hasSelectionProfileSignals(buildSkillSelectionProfile(skill));
    return typeof scope === "string" && routingScopes.includes(scope) && hasSelectionSignal;
  };
  const buildLoadReport = (): SkillRegistryLoadReport => {
    const skills = listSkills();
    const loadedSkills = skills.map((skill) => skill.name);
    const routableSkills = skills.filter(isRoutableSkill).map((skill) => skill.name);
    return {
      roots: [],
      loadedSkills,
      routingEnabled: options.routingEnabled ?? true,
      routingScopes,
      routableSkills,
      hiddenSkills: loadedSkills.filter((name) => !routableSkills.includes(name)),
      overlaySkills: [],
      projectGuidance: [],
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
    listForRouting: () => listSkills().filter(isRoutableSkill).map(buildSkillRoutingCatalogEntry),
    getActive: options.getActive ?? (() => undefined),
    getActiveState: options.getActiveState ?? (() => undefined),
    getReadiness: options.getReadiness,
    getLatestFailure: () => options.latestFailure,
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
    recordEvent: options.recordEvent ?? ((input) => runtime.extensions.hosted.events.record(input)),
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

  test("active skill surface hides tools outside the skill effect contract", async () => {
    const extensionApi = createMockRuntimePluginApi();
    registerTools(extensionApi.api, [
      "read",
      "edit",
      "write",
      "session_compact",
      "skill_load",
      "workflow_status",
      "task_view_state",
      "grep",
      "exec",
      "process",
      "skill_complete",
      "knowledge_search",
    ]);

    const skill = createSkillDocument(
      "design",
      ["workspace_read", "runtime_observe"],
      ["read", "grep", "knowledge_search"],
    );
    const runtime = createToolSurfaceRuntime({
      getActive: () => skill,
      getSkill: (name: string) => (name === skill.name ? skill : undefined),
    });

    registerToolSurface(extensionApi.api, runtime);
    await invokeHandlerAsync(
      extensionApi.handlers,
      "before_agent_start",
      {
        type: "before_agent_start",
        prompt: "Plan the implementation before editing files.",
      },
      {
        sessionManager: {
          getSessionId: () => "tool-surface-active-skill-effect-filter",
        },
      },
    );

    expect(extensionApi.activeTools).toContain("read");
    expect(extensionApi.activeTools).toContain("grep");
    expect(extensionApi.activeTools).toContain("knowledge_search");
    expect(extensionApi.activeTools).toContain("skill_complete");
    expect(extensionApi.activeTools).toContain("skill_load");
    expect(extensionApi.activeTools).toContain("workflow_status");
    expect(extensionApi.activeTools).not.toContain("edit");
    expect(extensionApi.activeTools).not.toContain("write");
    expect(extensionApi.activeTools).not.toContain("exec");
    expect(extensionApi.activeTools).not.toContain("process");
  });

  test("repair-required skill surface is capped by the repair allowlist", async () => {
    const extensionApi = createMockRuntimePluginApi();
    registerTools(extensionApi.api, [
      "read",
      "edit",
      "write",
      "grep",
      "knowledge_search",
      "workflow_status",
      "task_view_state",
      "ledger_query",
      "tape_info",
      "reasoning_checkpoint",
      "reasoning_revert",
      "session_compact",
      "skill_complete",
      "obs_query",
    ]);

    const skill = createSkillDocument(
      "learning-research",
      ["workspace_read", "runtime_observe"],
      ["knowledge_search", "read"],
    );
    const events: Array<Record<string, unknown>> = [];
    const runtime = createToolSurfaceRuntime({
      getActive: () => skill,
      getActiveState: () => ({
        skillName: skill.name,
        phase: "repair_required",
        repairBudget: {
          remainingAttempts: 1,
          remainingToolCalls: 6,
          tokenBudget: 12_000,
        },
      }),
      getSkill: (name: string) => (name === skill.name ? skill : undefined),
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
        prompt: "Repair the skill completion. Use $read and $knowledge_search if useful.",
      },
      {
        sessionManager: {
          getSessionId: () => "tool-surface-repair-required",
        },
      },
    );

    const expectedRepairTools = [
      "workflow_status",
      "task_view_state",
      "ledger_query",
      "tape_info",
      "reasoning_checkpoint",
      "reasoning_revert",
      "session_compact",
      "skill_complete",
    ];
    expect(extensionApi.activeTools).toEqual(expectedRepairTools);
    expect(new Set(extensionApi.activeTools)).toEqual(new Set(SKILL_REPAIR_ALLOWED_TOOL_NAMES));
    expect(extensionApi.activeTools).not.toContain("read");
    expect(extensionApi.activeTools).not.toContain("grep");
    expect(extensionApi.activeTools).not.toContain("knowledge_search");
    expect(extensionApi.activeTools).not.toContain("obs_query");

    const event = events.find((input) => input.type === "tool_surface_resolved") as
      | { payload?: Record<string, unknown> }
      | undefined;
    expect(event?.payload?.repairRequired).toBe(true);
    expect(event?.payload?.requestedActivatedToolNames).toEqual([]);
    expect(event?.payload?.ignoredRequestedToolNames).toEqual(["read", "knowledge_search"]);
    expect(event?.payload?.baseActiveCount).toBe(0);
    expect(event?.payload?.externalActiveCount).toBe(0);
  });

  test("skill-scoped tools honor required routing scopes before becoming visible", async () => {
    const extensionApi = createMockRuntimePluginApi();
    registerTools(extensionApi.api, [
      "read",
      "edit",
      "write",
      "session_compact",
      "skill_load",
      "workflow_status",
      "skill_complete",
      "skill_promotion_promote",
    ]);

    const skill = createSkillDocument(
      "self-improve",
      ["memory_write", "workspace_write"],
      ["skill_promotion_promote"],
    );
    const runtime = createToolSurfaceRuntime({
      routingScopes: ["core", "domain"],
      getActive: () => skill,
      getSkill: (name: string) => (name === skill.name ? skill : undefined),
    });

    registerToolSurface(extensionApi.api, runtime);
    await invokeHandlerAsync(
      extensionApi.handlers,
      "before_agent_start",
      {
        type: "before_agent_start",
        prompt: "Materialize the approved learning proposal.",
      },
      {
        sessionManager: {
          getSessionId: () => "tool-surface-scope-denied",
        },
      },
    );

    expect(extensionApi.activeTools).not.toContain("skill_promotion_promote");

    const operatorApi = createMockRuntimePluginApi();
    registerTools(operatorApi.api, [
      "read",
      "edit",
      "write",
      "session_compact",
      "skill_load",
      "workflow_status",
      "skill_complete",
      "skill_promotion_promote",
    ]);
    const operatorRuntime = createToolSurfaceRuntime({
      routingScopes: ["core", "domain", "operator"],
      getActive: () => skill,
      getSkill: (name: string) => (name === skill.name ? skill : undefined),
    });

    registerToolSurface(operatorApi.api, operatorRuntime);
    await invokeHandlerAsync(
      operatorApi.handlers,
      "before_agent_start",
      {
        type: "before_agent_start",
        prompt: "Materialize the approved learning proposal.",
      },
      {
        sessionManager: {
          getSessionId: () => "tool-surface-scope-allowed",
        },
      },
    );

    expect(operatorApi.activeTools).toContain("skill_promotion_promote");
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

  test("interactive hosts keep question visible on the bootstrap surface without an active skill", async () => {
    const extensionApi = createMockRuntimePluginApi();
    registerTools(extensionApi.api, [
      "read",
      "edit",
      "write",
      "session_compact",
      "skill_load",
      "workflow_status",
      "question",
    ]);

    const runtime = createToolSurfaceRuntime();

    registerToolSurface(extensionApi.api, runtime);
    await invokeHandlerAsync(
      extensionApi.handlers,
      "before_agent_start",
      {
        type: "before_agent_start",
        prompt: "Inspect the workspace state and clarify requirements if they are ambiguous.",
      },
      {
        hasUI: true,
        sessionManager: {
          getSessionId: () => "tool-surface-question-interactive",
        },
      },
    );

    expect(extensionApi.activeTools).toContain("question");
  });

  test("non-interactive hosts hide question even when it is registered on the bootstrap surface", async () => {
    const extensionApi = createMockRuntimePluginApi();
    registerTools(extensionApi.api, [
      "read",
      "edit",
      "write",
      "session_compact",
      "skill_load",
      "workflow_status",
      "question",
    ]);

    const runtime = createToolSurfaceRuntime();

    registerToolSurface(extensionApi.api, runtime);
    await invokeHandlerAsync(
      extensionApi.handlers,
      "before_agent_start",
      {
        type: "before_agent_start",
        prompt: "Inspect the workspace state and clarify requirements if they are ambiguous.",
      },
      {
        hasUI: false,
        sessionManager: {
          getSessionId: () => "tool-surface-question-noninteractive",
        },
      },
    );

    expect(extensionApi.activeTools).not.toContain("question");
  });

  test("explicit requests do not surface operator-gated tools without an operator profile", async () => {
    const extensionApi = createMockRuntimePluginApi();
    registerTools(extensionApi.api, [
      "read",
      "edit",
      "write",
      "session_compact",
      "skill_load",
      "workflow_status",
      "recall_curate",
    ]);

    const runtime = createToolSurfaceRuntime();

    registerToolSurface(extensionApi.api, runtime);
    await invokeHandlerAsync(
      extensionApi.handlers,
      "before_agent_start",
      {
        type: "before_agent_start",
        prompt: "Use $recall_curate if recall ranking needs correction.",
      },
      {
        sessionManager: {
          getSessionId: () => "tool-surface-recall-curate-no-operator",
        },
      },
    );

    expect(extensionApi.activeTools).not.toContain("recall_curate");
  });

  test("explicit requests respect runtime governance routing-scope requirements, not hardcoded tool names", async () => {
    const extensionApi = createMockRuntimePluginApi();
    registerTools(extensionApi.api, [
      "read",
      "edit",
      "write",
      "session_compact",
      "skill_load",
      "workflow_status",
      "narrative_memory",
    ]);

    const runtime = createToolSurfaceRuntime({
      actionPolicies: [
        {
          toolName: "narrative_memory",
          policy: {
            actionClass: "runtime_observe",
            riskLevel: "low",
            defaultAdmission: "allow",
            maxAdmission: "allow",
            receiptPolicy: { kind: "audit", required: false },
            recoveryPolicy: { kind: "none" },
            effectClasses: ["runtime_observe"],
            requiredRoutingScopes: ["operator"],
          },
        },
      ],
    });

    registerToolSurface(extensionApi.api, runtime);
    await invokeHandlerAsync(
      extensionApi.handlers,
      "before_agent_start",
      {
        type: "before_agent_start",
        prompt: "Use $narrative_memory to inspect collaboration memory.",
      },
      {
        sessionManager: {
          getSessionId: () => "tool-surface-narrative-memory-no-operator",
        },
      },
    );

    expect(extensionApi.activeTools).not.toContain("narrative_memory");
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
      "recall_curate",
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
    expect(extensionApi.activeTools).toContain("recall_curate");
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
              paths: [".orchestrator", ".brewva"],
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

    expect(extensionApi.activeTools).toContain("read");
    expect(extensionApi.activeTools).toContain("edit");
    expect(extensionApi.activeTools).toContain("write");
    expect(extensionApi.activeTools).toContain("skill_load");
    expect(extensionApi.activeTools).toContain("workflow_status");
    expect(extensionApi.activeTools).toContain("task_set_spec");

    const event = events.find((input) => input.type === "tool_surface_resolved") as
      | { payload?: Record<string, unknown> }
      | undefined;
    expect(event?.payload?.skillActivationPosture).toEqual(
      expect.objectContaining({ kind: "recommend_task_spec" }),
    );
    expect(event?.payload?.toolAvailabilityPosture).toBe("recommend");
    expect(event?.payload?.taskSpecReady).toBe(false);
    expect(event?.payload?.candidateSkillNames).toEqual([]);
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

    expect(extensionApi.activeTools).toContain("read");
    expect(extensionApi.activeTools).toContain("knowledge_search");
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

    expect(extensionApi.activeTools).toContain("read");
    expect(extensionApi.activeTools).toContain("knowledge_search");
    expect(extensionApi.activeTools).toContain("skill_load");
    expect(extensionApi.activeTools).toContain("task_set_spec");
    expect(result).toBeUndefined();
  });

  test("task spec recommendations keep the current tool surface visible at advisory strength", async () => {
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
      "ledger_query",
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
          "repository-analysis",
          ["workspace_read", "runtime_observe"],
          ["read", "grep"],
          {
            selection: {
              whenToUse:
                "Use when the task needs repository orientation, impact analysis, or boundary mapping before design, debugging, review, or execution.",
            },
          },
        ),
        createSkillDocument("design", ["workspace_read", "runtime_observe"], ["read", "grep"], {
          selection: {
            whenToUse:
              "Use when a request needs a bounded design, explicit trade-offs, or an executable plan before code changes.",
          },
        }),
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
        prompt:
          "对比项目预期流程，判断这次 brewva 运行是否有问题，特别是 skill load 和 TUI thinking streaming。",
      },
      {
        sessionManager: {
          getSessionId: () => "tool-surface-advisory-strength-skill",
        },
      },
    );

    taskState = {
      spec: {
        goal: "Assess Brewva's current architecture against a staged design order focused on high-risk actions, minimal permissions, lifecycle, context governance, skills/hooks, and later multi-agent/platform expansion; identify what is underdesigned, overweight, or low-yield for final effectiveness.",
        expectedBehavior:
          "Produce a repository-aware architectural critique that distinguishes runtime judgment from hardcoded policy and highlights complexity or weakness with concrete evidence.",
        constraints: [
          "Read-only investigation",
          "Use repo guide and local source context",
          "Do not answer from generic memory alone",
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
        toolCallId: "tc-task-set-spec-advisory-strength",
        isError: false,
        content: [{ type: "text", text: "TaskSpec recorded." }],
      },
      {
        sessionManager: {
          getSessionId: () => "tool-surface-advisory-strength-skill",
        },
      },
    );

    expect(extensionApi.activeTools).toContain("read");
    expect(extensionApi.activeTools).toContain("edit");
    expect(extensionApi.activeTools).toContain("write");
    expect(extensionApi.activeTools).toContain("knowledge_search");
    expect(extensionApi.activeTools).toContain("skill_load");
    expect(result).toBeUndefined();
  });

  test("blocked diagnosis requires inputs instead of forcing immediate skill load", async () => {
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
    ]);

    const events: Array<Record<string, unknown>> = [];
    const implementationSkill = createSkillDocument(
      "implementation",
      ["workspace_read", "workspace_write", "runtime_observe"],
      ["edit"],
      {
        requires: ["design_spec"],
        authoredMarkdown: "## Trigger\n\n- Implement the selected fix now.\n",
        selection: {
          whenToUse: "Implement the selected fix now.",
        },
      },
    );
    const runtime = createToolSurfaceRuntime({
      listSkills: () => [implementationSkill],
      getReadiness: () => [
        {
          name: "implementation",
          category: "domain",
          readiness: "blocked",
          score: -1,
          requires: ["design_spec"],
          consumes: [],
          satisfiedRequires: [],
          missingRequires: ["design_spec"],
          satisfiedConsumes: [],
          issues: [],
          sourceSkillNames: [],
          sourceEventIds: [],
        },
      ],
      taskState: {
        spec: {
          goal: "Implement the selected fix after design is ready.",
          expectedBehavior: "Apply the planned code change safely.",
          constraints: ["Do not invent the missing design artifact"],
        },
        status: { phase: "execute" },
        items: [],
        blockers: [],
        updatedAt: null,
      },
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
        prompt: "Implement the selected fix now.",
      },
      {
        sessionManager: {
          getSessionId: () => "tool-surface-blocked-diagnosis",
        },
      },
    );

    expect(extensionApi.activeTools).toContain("read");
    expect(extensionApi.activeTools).toContain("skill_load");
    expect(extensionApi.activeTools).not.toContain("edit");
    expect(extensionApi.activeTools).not.toContain("write");

    const surfaceEvent = events.find((input) => input.type === "tool_surface_resolved") as
      | { payload?: Record<string, unknown> }
      | undefined;
    expect(surfaceEvent?.payload?.skillActivationPosture).toEqual(
      expect.objectContaining({
        kind: "require_skill_inputs",
        skillName: "implementation",
        missingRequires: ["design_spec"],
      }),
    );
    expect(surfaceEvent?.payload?.toolAvailabilityPosture).toBe("require_explore");

    const diagnosis = deriveSkillDiagnoses(runtime, {
      sessionId: "tool-surface-blocked-diagnosis",
      prompt: "Implement the selected fix now.",
    });
    expect(diagnosis.candidates[0]).toEqual(
      expect.objectContaining({
        name: "implementation",
        readiness: "blocked",
        missingRequires: ["design_spec"],
        shallowOutputRisk: "missing required inputs: design_spec",
      }),
    );
    expect(diagnosis.activationPosture).toEqual(
      expect.objectContaining({
        kind: "require_skill_inputs",
        skillName: "implementation",
        missingRequires: ["design_spec"],
      }),
    );
  });

  test("handoff gate selects a nearby actionable candidate after a blocked semantic leader", () => {
    const blockedSkill = createSkillDocument(
      "implementation",
      ["workspace_read", "workspace_write", "runtime_observe"],
      ["edit"],
      {
        authoredMarkdown: "## Trigger\n\n- selected design handoff ready\n",
        requires: ["design_spec"],
        selection: {
          whenToUse: "Implement the selected fix now.",
        },
      },
    );
    const readySkill = createSkillDocument(
      "implementation-ready",
      ["workspace_read", "workspace_write", "runtime_observe"],
      ["edit"],
      {
        consumes: ["design_spec"],
        selection: {
          whenToUse: "Apply the planned code change safely.",
        },
      },
    );
    const runtime = createToolSurfaceRuntime({
      listSkills: () => [blockedSkill, readySkill],
      getReadiness: () => [
        {
          name: "implementation",
          category: "domain",
          readiness: "blocked",
          score: -1,
          requires: ["design_spec"],
          consumes: [],
          satisfiedRequires: [],
          missingRequires: ["design_spec"],
          satisfiedConsumes: [],
          issues: [],
          sourceSkillNames: [],
          sourceEventIds: [],
        },
        {
          name: "implementation-ready",
          category: "domain",
          readiness: "ready",
          score: 12,
          requires: [],
          consumes: ["design_spec"],
          satisfiedRequires: [],
          missingRequires: [],
          satisfiedConsumes: ["design_spec"],
          issues: [],
          sourceSkillNames: ["design"],
          sourceEventIds: ["event-design-complete"],
        },
      ],
      taskState: {
        spec: {
          goal: "Implement the selected fix now.",
          expectedBehavior:
            "Apply the planned code change safely after selected design handoff ready.",
        },
        status: { phase: "execute" },
        items: [],
        blockers: [],
        updatedAt: null,
      },
    });

    const diagnosis = deriveSkillDiagnoses(runtime, {
      sessionId: "tool-surface-actionable-diagnosis",
      prompt: "Implement the selected fix now.",
    });

    const blockedCandidate = diagnosis.candidates.find((entry) => entry.name === "implementation");

    expect(diagnosis.candidates[0]).toEqual(
      expect.objectContaining({
        name: "implementation-ready",
        readiness: "ready",
        missingRequires: [],
        satisfiedConsumes: ["design_spec"],
      }),
    );
    expect(blockedCandidate).toEqual(
      expect.objectContaining({
        basis: "selection_profile",
        readiness: "blocked",
        missingRequires: ["design_spec"],
      }),
    );
    expect(blockedCandidate!.score).toBeGreaterThan(diagnosis.candidates[0]!.score);
    expect(diagnosis.activationPosture).toEqual(
      expect.objectContaining({
        kind: "require_skill_load",
        skillNames: ["implementation-ready", "implementation"],
      }),
    );
    expect(diagnosis.toolAvailabilityPosture).toBe("require_execute");
  });

  test("blocked selection candidate gates skill load even before execution", () => {
    const blockedSkill = createSkillDocument(
      "implementation",
      ["workspace_read", "workspace_write", "runtime_observe"],
      ["edit"],
      {
        requires: ["design_spec"],
        selection: {
          whenToUse: "Assess selected design handoff.",
        },
      },
    );
    const runtime = createToolSurfaceRuntime({
      listSkills: () => [blockedSkill],
      getReadiness: () => [
        {
          name: "implementation",
          category: "domain",
          readiness: "blocked",
          score: -1,
          requires: ["design_spec"],
          consumes: [],
          satisfiedRequires: [],
          missingRequires: ["design_spec"],
          satisfiedConsumes: [],
          issues: [],
          sourceSkillNames: [],
          sourceEventIds: [],
        },
      ],
      taskState: {
        spec: {
          goal: "Assess selected design handoff.",
          expectedBehavior: "Clarify what evidence is still missing.",
        },
        status: { phase: "align" },
        items: [],
        blockers: [],
        updatedAt: null,
      },
    });

    const diagnosis = deriveSkillDiagnoses(runtime, {
      sessionId: "tool-surface-blocked-align-diagnosis",
      prompt: "Assess selected design handoff.",
    });

    expect(diagnosis.activationPosture).toEqual(
      expect.objectContaining({
        kind: "require_skill_inputs",
        skillName: "implementation",
        boundary: "explore",
        missingRequires: ["design_spec"],
      }),
    );
    expect(diagnosis.toolAvailabilityPosture).toBe("require_explore");
  });

  test("handoff ready state cannot introduce a candidate outside the selection shortlist", () => {
    const implementationSkill = createSkillDocument(
      "implementation",
      ["workspace_read", "workspace_write", "runtime_observe"],
      ["edit"],
      {
        selection: {
          whenToUse: "Implement the selected fix now.",
        },
      },
    );
    const unrelatedReadySkill = createSkillDocument(
      "release-notes",
      ["workspace_read", "runtime_observe"],
      ["read"],
      {
        consumes: ["design_spec"],
        selection: {
          whenToUse: "Use when preparing release notes after a ship decision.",
        },
      },
    );
    const runtime = createToolSurfaceRuntime({
      listSkills: () => [implementationSkill, unrelatedReadySkill],
      getReadiness: () => [
        {
          name: "release-notes",
          category: "domain",
          readiness: "ready",
          score: 12,
          requires: [],
          consumes: ["design_spec"],
          satisfiedRequires: [],
          missingRequires: [],
          satisfiedConsumes: ["design_spec"],
          issues: [],
          sourceSkillNames: ["plan"],
          sourceEventIds: ["event-plan-complete"],
        },
      ],
      taskState: {
        spec: {
          goal: "Implement the selected fix now.",
          expectedBehavior: "Apply the planned code change safely.",
        },
        status: { phase: "execute" },
        items: [],
        blockers: [],
        updatedAt: null,
      },
    });

    const diagnosis = deriveSkillDiagnoses(runtime, {
      sessionId: "tool-surface-ready-not-selection-signal",
      prompt: "Implement the selected fix now.",
    });

    expect(diagnosis.candidates[0]?.name).toBe("implementation");
    expect(diagnosis.candidates.map((entry) => entry.name)).not.toContain("release-notes");
  });

  test("skill-first diagnosis ignores runtime-inherited markdown triggers", () => {
    const inheritedOnlySkill = createSkillDocument(
      "inherited-only",
      ["workspace_read", "runtime_observe"],
      ["read"],
      {
        markdown: "## Trigger\n\n- diagnose inherited runtime guidance only\n",
        authoredMarkdown: "",
        selection: {
          whenToUse: "Use when handling unrelated archive maintenance.",
        },
      },
    );
    const authoredSkill = createSkillDocument(
      "authored-trigger",
      ["workspace_read", "runtime_observe"],
      ["read"],
      {
        markdown: "## Trigger\n\n- diagnose authored routing text\n",
        authoredMarkdown: "## Trigger\n\n- diagnose authored routing text\n",
        selection: {
          whenToUse: "Use when diagnosing authored routing text.",
        },
      },
    );
    const runtime = createToolSurfaceRuntime({
      listSkills: () => [inheritedOnlySkill, authoredSkill],
      taskState: {
        spec: {
          goal: "Diagnose authored routing text.",
          expectedBehavior: "Choose the skill whose authored trigger matches.",
        },
        status: { phase: "align" },
        items: [],
        blockers: [],
        updatedAt: null,
      },
    });

    const diagnosis = deriveSkillDiagnoses(runtime, {
      sessionId: "tool-surface-authored-markdown-routing",
      prompt: "Diagnose authored routing text.",
    });

    expect(diagnosis.candidates[0]).toEqual(
      expect.objectContaining({
        name: "authored-trigger",
      }),
    );
    expect(diagnosis.candidates.map((entry) => entry.name)).not.toContain("inherited-only");
  });

  test("failed skill contracts block downstream routing and repository tools", async () => {
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
      "ledger_query",
      "tape_info",
      "reasoning_checkpoint",
      "reasoning_revert",
      "grep",
      "implementation",
      "obs_query",
    ]);

    const events: Array<Record<string, unknown>> = [];
    const runtime = createToolSurfaceRuntime({
      latestFailure: {
        skillName: "repository-analysis",
        occurredAt: 1,
        phase: "failed_contract",
        outputKeys: [],
        missing: ["repository_snapshot"],
        invalid: [],
        expectedOutputs: {},
        repairBudget: {
          maxAttempts: 2,
          usedAttempts: 2,
          remainingAttempts: 0,
          maxToolCalls: 6,
          usedToolCalls: 0,
          remainingToolCalls: 6,
          tokenBudget: 12000,
        },
      },
      listSkills: () => [
        createSkillDocument(
          "repository-analysis",
          ["workspace_read", "runtime_observe"],
          ["read", "grep"],
          {
            selection: {
              whenToUse:
                "Use when the task needs repository orientation, impact analysis, or boundary mapping before implementation.",
            },
          },
        ),
        createSkillDocument("implementation", ["workspace_read", "runtime_observe"], ["edit"], {
          selection: {
            whenToUse: "Use when the task has completed planning and is ready for implementation.",
          },
        }),
      ],
      taskState: {
        spec: {
          goal: "Analyze this repository and implement the selected fix.",
          expectedBehavior: "Use repository evidence before changing code.",
          constraints: ["Do not continue after a failed skill contract."],
        },
        status: { phase: "investigate" },
        items: [],
        blockers: [],
      },
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
        prompt: "Continue with implementation after repository analysis failed.",
      },
      {
        sessionManager: {
          getSessionId: () => "tool-surface-failed-contract",
        },
      },
    );

    expect(extensionApi.activeTools).not.toContain("read");
    expect(extensionApi.activeTools).not.toContain("grep");
    expect(extensionApi.activeTools).not.toContain("edit");
    expect(extensionApi.activeTools).not.toContain("write");
    expect(extensionApi.activeTools).not.toContain("skill_load");
    expect(extensionApi.activeTools).not.toContain("implementation");
    expect(extensionApi.activeTools).toEqual(
      expect.arrayContaining([
        "workflow_status",
        "task_view_state",
        "ledger_query",
        "tape_info",
        "reasoning_checkpoint",
        "reasoning_revert",
        "session_compact",
      ]),
    );

    const event = events.find((input) => input.type === "tool_surface_resolved") as
      | { payload?: Record<string, unknown> }
      | undefined;
    expect(event?.payload?.skillActivationPosture).toEqual(
      expect.objectContaining({ kind: "repair_failed_contract" }),
    );
    expect(event?.payload?.toolAvailabilityPosture).toBe("contract_failed");
    expect(event?.payload?.candidateSkillNames).toEqual([]);
  });

  test("task-state mutation re-evaluation reuses a single diagnosis pass", async () => {
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

  test("disabling hosted diagnosis suppresses advisory receipts without breaking tool-surface resolution", async () => {
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
    ]);

    const events: Array<Record<string, unknown>> = [];
    const runtime = createToolSurfaceRuntime({
      routingEnabled: false,
      taskState: {
        spec: {
          goal: "Find repository precedents before implementation.",
          expectedBehavior: "Keep the turn replay-safe even when routing is disabled.",
          constraints: ["Read-only investigation"],
        },
        status: { phase: "investigate" },
        items: [],
        blockers: [],
        updatedAt: null,
      },
      listSkills: () => [
        createSkillDocument(
          "learning-research",
          ["workspace_read", "runtime_observe"],
          ["knowledge_search"],
          {
            selection: {
              whenToUse:
                "Use when repository precedents and prior solutions should be consulted before implementation.",
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
        prompt: "先看一下仓库里有没有类似先例，再决定是否实现",
      },
      {
        sessionManager: {
          getSessionId: () => "tool-surface-routing-disabled",
        },
      },
    );

    expect(events.filter((input) => input.type === "tool_surface_resolved")).toHaveLength(1);
    expect(events.filter((input) => input.type === "skill_diagnosis_derived")).toHaveLength(0);
    expect(extensionApi.activeTools).toContain("workflow_status");
    expect(extensionApi.activeTools).toContain("task_set_spec");
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
    expect(events.filter((input) => input.type === "skill_diagnosis_derived")).toHaveLength(0);
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
      "recall_search",
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
    expect(extensionApi.activeTools).toContain("recall_search");
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

  test("refreshes the active tool surface after skill_load activates a skill", async () => {
    const extensionApi = createMockRuntimePluginApi();
    registerTools(extensionApi.api, ["read", "edit", "write", "session_compact"]);

    const skill = createSkillDocument(
      "learning-research",
      ["workspace_read", "runtime_observe"],
      ["read"],
    );
    let activeSkillName: string | undefined;
    const events: Array<Record<string, unknown>> = [];
    const runtime = createToolSurfaceRuntime({
      listSkills: () => [skill],
      getActive: () => (activeSkillName === skill.name ? skill : undefined),
      getSkill: (name: string) => (name === skill.name ? skill : undefined),
      recordEvent: (input: Record<string, unknown>) => {
        events.push(input);
        return undefined;
      },
    });
    const dynamicToolDefinitions = new Map(
      ["skill_load", "skill_complete", "workflow_status"].map((name) => [
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
        prompt: "Use $skill_load before researching repository precedent.",
      },
      {
        sessionManager: {
          getSessionId: () => "tool-surface-skill-load-refresh",
        },
      },
    );

    expect(extensionApi.api.getAllTools().map((tool) => tool.name)).toContain("skill_load");
    expect(extensionApi.api.getAllTools().map((tool) => tool.name)).not.toContain("skill_complete");
    expect(extensionApi.activeTools).not.toContain("skill_complete");

    activeSkillName = skill.name;
    await invokeHandlerAsync(
      extensionApi.handlers,
      "tool_result",
      {
        type: "tool_result",
        toolName: "skill_load",
        toolCallId: "tc-skill-load-refresh",
        isError: false,
        content: [{ type: "text", text: "Skill loaded." }],
      },
      {
        sessionManager: {
          getSessionId: () => "tool-surface-skill-load-refresh",
        },
      },
    );

    expect(extensionApi.api.getAllTools().map((tool) => tool.name)).toContain("skill_complete");
    expect(extensionApi.activeTools).toContain("skill_complete");
    const resolvedEvents = events.filter(
      (input) => input.type === "tool_surface_resolved",
    ) as Array<{
      payload?: Record<string, unknown>;
    }>;
    expect(resolvedEvents[resolvedEvents.length - 1]?.payload?.activeToolNames).toContain(
      "skill_complete",
    );
  });

  test("refreshes the active tool surface after skill_complete clears the active skill", async () => {
    const extensionApi = createMockRuntimePluginApi();
    registerTools(extensionApi.api, ["read", "edit", "write", "session_compact"]);

    const skill = createSkillDocument(
      "learning-research",
      ["workspace_read", "runtime_observe"],
      ["read"],
    );
    let activeSkillName: string | undefined = skill.name;
    const runtime = createToolSurfaceRuntime({
      listSkills: () => [skill],
      getActive: () => (activeSkillName === skill.name ? skill : undefined),
      getSkill: (name: string) => (name === skill.name ? skill : undefined),
    });
    const dynamicToolDefinitions = new Map(
      ["skill_load", "skill_complete", "workflow_status"].map((name) => [
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
        prompt: "Research repository precedent under the active skill.",
      },
      {
        sessionManager: {
          getSessionId: () => "tool-surface-skill-complete-refresh",
        },
      },
    );
    expect(extensionApi.activeTools).toContain("skill_complete");

    activeSkillName = undefined;
    await invokeHandlerAsync(
      extensionApi.handlers,
      "tool_result",
      {
        type: "tool_result",
        toolName: "skill_complete",
        toolCallId: "tc-skill-complete-refresh",
        isError: false,
        content: [{ type: "text", text: "Skill completed." }],
      },
      {
        sessionManager: {
          getSessionId: () => "tool-surface-skill-complete-refresh",
        },
      },
    );

    expect(extensionApi.activeTools).not.toContain("skill_complete");
  });

  test("refreshes the active tool surface after skill_complete records a repair failure", async () => {
    const extensionApi = createMockRuntimePluginApi();
    registerTools(extensionApi.api, ["read", "edit", "write", "session_compact"]);

    const skill = createSkillDocument(
      "learning-research",
      ["workspace_read", "runtime_observe"],
      ["obs_query"],
    );
    let activeSkillState: ReturnType<ToolSurfaceRuntime["inspect"]["skills"]["getActiveState"]> = {
      skillName: skill.name,
      phase: "active",
    };
    const runtime = createToolSurfaceRuntime({
      listSkills: () => [skill],
      getActive: () => skill,
      getActiveState: () => activeSkillState,
      getSkill: (name: string) => (name === skill.name ? skill : undefined),
    });
    const dynamicToolDefinitions = new Map(
      [
        "skill_load",
        "skill_complete",
        "workflow_status",
        "task_view_state",
        "ledger_query",
        "tape_info",
        "reasoning_checkpoint",
        "reasoning_revert",
        "obs_query",
      ].map((name) => [name, createToolDefinition(name)]),
    );

    registerToolSurface(extensionApi.api, runtime, {
      dynamicToolDefinitions,
    });
    await invokeHandlerAsync(
      extensionApi.handlers,
      "before_agent_start",
      {
        type: "before_agent_start",
        prompt: "Research repository precedent under the active skill.",
      },
      {
        sessionManager: {
          getSessionId: () => "tool-surface-skill-repair-refresh",
        },
      },
    );
    expect(extensionApi.activeTools).toContain("obs_query");

    activeSkillState = {
      skillName: skill.name,
      phase: "repair_required",
      repairBudget: {
        remainingAttempts: 1,
        remainingToolCalls: 4,
        tokenBudget: 8000,
      },
    };
    await invokeHandlerAsync(
      extensionApi.handlers,
      "tool_result",
      {
        type: "tool_result",
        toolName: "skill_complete",
        toolCallId: "tc-skill-repair-refresh",
        isError: true,
        content: [{ type: "text", text: "Skill completion rejected." }],
      },
      {
        sessionManager: {
          getSessionId: () => "tool-surface-skill-repair-refresh",
        },
      },
    );

    expect(extensionApi.activeTools).toContain("skill_complete");
    expect(extensionApi.activeTools).toContain("workflow_status");
    expect(extensionApi.activeTools).not.toContain("obs_query");
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
    expect(extensionApi.activeTools).not.toContain("process");
  });
});
