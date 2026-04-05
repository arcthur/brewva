import {
  SKILL_RECOMMENDATION_DERIVED_EVENT_TYPE,
  TOOL_SURFACE_RESOLVED_EVENT_TYPE,
  getToolGovernanceDescriptor,
  listSkillAllowedEffects,
  listSkillDeniedEffects,
  listSkillFallbackTools,
  listSkillPreferredTools,
  type SkillDocument,
} from "@brewva/brewva-runtime";
import {
  BASE_BREWVA_TOOL_NAMES,
  getBrewvaToolMetadata,
  getBrewvaToolSurface,
  MANAGED_BREWVA_TOOL_NAMES,
  OPERATOR_BREWVA_TOOL_NAMES,
  SKILL_BREWVA_TOOL_NAMES,
  isManagedBrewvaToolName,
} from "@brewva/brewva-tools";
import type {
  ExtensionAPI,
  ToolDefinition,
  ToolInfo,
  ToolResultEvent,
} from "@mariozechner/pi-coding-agent";
import {
  buildSkillRecommendationReceiptPayload,
  buildSkillFirstPolicyBlock,
  computeSkillRecommendationReceiptKey,
  deriveSkillRecommendations,
  type SkillRecommendationGateMode,
  type SkillRecommendationSet,
} from "./skill-first.js";

const CAPABILITY_REQUEST_PATTERN = /\$([a-z][a-z0-9_]*)/g;
const BUILTIN_ALWAYS_ON_TOOL_NAMES = ["read", "edit", "write"] as const;
const MANAGED_TOOL_NAME_SET = new Set(MANAGED_BREWVA_TOOL_NAMES);
const PRE_SKILL_CONTROL_PLANE_TOOL_NAMES = [
  "skill_load",
  "workflow_status",
  "session_compact",
  "task_set_spec",
  "task_view_state",
  "task_add_item",
  "task_update_item",
  "task_record_blocker",
  "task_resolve_blocker",
] as const;
const BOOTSTRAP_MANAGED_TOOL_NAMES = [
  ...PRE_SKILL_CONTROL_PLANE_TOOL_NAMES,
  "knowledge_search",
  "precedent_audit",
  "precedent_sweep",
  "deliberation_memory",
  "output_search",
  "ledger_query",
  "tape_info",
  "tape_search",
  "tape_handoff",
] as const;
const TASK_CONTEXT_MUTATION_TOOL_NAMES = new Set([
  "task_set_spec",
  "task_add_item",
  "task_update_item",
  "task_record_blocker",
  "task_resolve_blocker",
]);

type ToolSurfaceSkill = Pick<
  SkillDocument,
  "name" | "description" | "category" | "markdown" | "contract"
>;

export interface ToolSurfaceRuntime {
  config: {
    skills: {
      routing: {
        scopes: readonly string[];
      };
    };
  };
  inspect: {
    tools: {
      getGovernanceDescriptor(
        toolName: string,
        args?: Record<string, unknown>,
      ): ReturnType<typeof getToolGovernanceDescriptor>;
    };
    skills: {
      list(): ToolSurfaceSkill[];
      getActive(sessionId: string): ToolSurfaceSkill | null | undefined;
      get(name: string): ToolSurfaceSkill | undefined;
      getLoadReport(): {
        loadedSkills: string[];
        routingEnabled: boolean;
        routingScopes: readonly string[];
        routableSkills: string[];
        hiddenSkills: string[];
      };
    };
    task: {
      getState(sessionId: string):
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
    };
  };
  recordEvent(input: { sessionId: string; type: string; payload?: object }): unknown;
}

function normalizeToolName(name: string): string {
  return name.trim().toLowerCase();
}

function getSessionId(ctx: unknown): string | null {
  if (!ctx || typeof ctx !== "object" || !("sessionManager" in ctx)) {
    return null;
  }
  const sessionManager = (ctx as { sessionManager?: unknown }).sessionManager;
  if (
    !sessionManager ||
    typeof sessionManager !== "object" ||
    !("getSessionId" in sessionManager)
  ) {
    return null;
  }
  const getSessionIdFn = (sessionManager as { getSessionId?: unknown }).getSessionId;
  if (typeof getSessionIdFn !== "function") {
    return null;
  }
  const candidate = getSessionIdFn.call(sessionManager);
  return typeof candidate === "string" && candidate.trim().length > 0 ? candidate : null;
}

function normalizeToolResultContent(content: unknown): ToolResultEvent["content"] {
  return Array.isArray(content) ? (content as ToolResultEvent["content"]) : [];
}

function extractRequestedToolNames(prompt: string): string[] {
  const requested = new Set<string>();
  for (const match of prompt.matchAll(CAPABILITY_REQUEST_PATTERN)) {
    const raw = match[1];
    if (typeof raw !== "string") continue;
    const normalized = normalizeToolName(raw);
    if (normalized.length > 0) {
      requested.add(normalized);
    }
  }
  return [...requested];
}

function isOperatorProfile(runtime: ToolSurfaceRuntime): boolean {
  const scopes = new Set(runtime.config.skills.routing.scopes);
  return scopes.has("operator") || scopes.has("meta");
}

function appendSkillName(names: string[], skillName: string | null | undefined): void {
  if (typeof skillName !== "string") return;
  const trimmed = skillName.trim();
  if (!trimmed || names.includes(trimmed)) return;
  names.push(trimmed);
}

function resolveSurfaceSkills(runtime: ToolSurfaceRuntime, sessionId: string): ToolSurfaceSkill[] {
  const names: string[] = [];
  const active = runtime.inspect.skills.getActive(sessionId);

  appendSkillName(names, active?.name);

  return names
    .map((name) => runtime.inspect.skills.get(name))
    .filter((skill): skill is ToolSurfaceSkill => skill !== undefined);
}

function resolveManagedToolGovernanceDescriptor(
  runtime: ToolSurfaceRuntime,
  toolName: string,
  dynamicToolDefinitions?: ReadonlyMap<string, ToolDefinition>,
) {
  const dynamicMetadata = getBrewvaToolMetadata(dynamicToolDefinitions?.get(toolName));
  return (
    dynamicMetadata?.governance ??
    runtime.inspect.tools.getGovernanceDescriptor(toolName) ??
    getToolGovernanceDescriptor(toolName)
  );
}

function collectSkillToolNames(
  runtime: ToolSurfaceRuntime,
  skills: ToolSurfaceSkill[],
  dynamicToolDefinitions?: ReadonlyMap<string, ToolDefinition>,
): string[] {
  const names = new Set<string>();
  for (const skill of skills) {
    for (const toolName of listSkillPreferredTools(skill.contract)) {
      names.add(normalizeToolName(toolName));
    }
    for (const toolName of listSkillFallbackTools(skill.contract)) {
      names.add(normalizeToolName(toolName));
    }
    const allowedEffects = new Set(listSkillAllowedEffects(skill.contract));
    const deniedEffects = new Set(listSkillDeniedEffects(skill.contract));
    for (const toolName of SKILL_BREWVA_TOOL_NAMES) {
      const descriptor = resolveManagedToolGovernanceDescriptor(
        runtime,
        toolName,
        dynamicToolDefinitions,
      );
      if (!descriptor) continue;
      if (descriptor.effects.some((effect) => deniedEffects.has(effect))) {
        continue;
      }
      if (descriptor.effects.every((effect) => allowedEffects.has(effect))) {
        names.add(normalizeToolName(toolName));
      }
    }
  }
  return [...names];
}

function resolveRequestedManagedToolNames(
  requestedToolNames: string[],
  knownToolNames: Set<string>,
  allowedManagedToolNames: ReadonlySet<string>,
): string[] {
  return requestedToolNames.filter((toolName) => {
    if (!knownToolNames.has(toolName)) return false;
    return isManagedBrewvaToolName(toolName) && allowedManagedToolNames.has(toolName);
  });
}

type TurnSurfacePlan = {
  requestedToolNames: string[];
  requestedManagedToolNames: string[];
  recommendationSet: SkillRecommendationSet;
  skillNames: string[];
  hasActiveSkill: boolean;
  recommendedSkillNames: string[];
  skillGateMode: SkillRecommendationGateMode;
  taskSpecReady: boolean;
  skillManagedToolNames: string[];
  lifecycleManagedToolNames: string[];
  operatorManagedToolNames: string[];
  operatorProfile: boolean;
  preSkillGateActive: boolean;
};

function resolveTurnSurfacePlan(input: {
  runtime: ToolSurfaceRuntime;
  sessionId: string;
  prompt: string;
  dynamicToolDefinitions?: ReadonlyMap<string, ToolDefinition>;
}): TurnSurfacePlan {
  const requestedToolNames = extractRequestedToolNames(input.prompt);
  const requestedManagedToolNames = requestedToolNames.filter((toolName) =>
    MANAGED_TOOL_NAME_SET.has(toolName),
  );
  const surfaceSkills = resolveSurfaceSkills(input.runtime, input.sessionId);
  const hasActiveSkill = surfaceSkills.length > 0;
  const recommendationSet = deriveSkillRecommendations(input.runtime, {
    sessionId: input.sessionId,
    prompt: input.prompt,
  });
  const skillManagedToolNames = collectSkillToolNames(
    input.runtime,
    surfaceSkills,
    input.dynamicToolDefinitions,
  ).filter((toolName) => MANAGED_TOOL_NAME_SET.has(toolName));
  const lifecycleManagedToolNames: string[] = [...BOOTSTRAP_MANAGED_TOOL_NAMES];

  if (hasActiveSkill) {
    lifecycleManagedToolNames.push("skill_complete");
  }

  const operatorProfile = isOperatorProfile(input.runtime);
  const operatorManagedToolNames = operatorProfile ? OPERATOR_BREWVA_TOOL_NAMES : [];
  const preSkillGateActive = !hasActiveSkill && recommendationSet.gateMode !== "none";

  return {
    requestedToolNames,
    requestedManagedToolNames,
    recommendationSet,
    skillNames: surfaceSkills.map((skill) => skill.name),
    hasActiveSkill,
    recommendedSkillNames: recommendationSet.recommendations.map((entry) => entry.name),
    skillGateMode: recommendationSet.gateMode,
    taskSpecReady: recommendationSet.taskSpecReady,
    skillManagedToolNames,
    lifecycleManagedToolNames: [...new Set(lifecycleManagedToolNames)],
    operatorManagedToolNames,
    operatorProfile,
    preSkillGateActive,
  };
}

function resolveActiveToolNames(input: {
  allTools: ToolInfo[];
  activeToolNames: string[];
  turnPlan: TurnSurfacePlan;
}): {
  activeToolNames: string[];
  managedActiveCount: number;
  requestedToolNames: string[];
  requestedActivatedToolNames: string[];
  ignoredRequestedToolNames: string[];
  skillNames: string[];
  recommendedSkillNames: string[];
  skillGateMode: SkillRecommendationGateMode;
  taskSpecReady: boolean;
  operatorProfile: boolean;
  baseActiveCount: number;
  skillActiveCount: number;
  operatorActiveCount: number;
  externalActiveCount: number;
  hiddenSkillCount: number;
  hiddenOperatorCount: number;
  recommendationSet: SkillRecommendationSet;
} {
  const allToolNames = input.allTools.map((tool) => normalizeToolName(tool.name));
  const knownToolNames = new Set(allToolNames);
  const active = new Set<string>();
  const turnPlan = input.turnPlan;
  for (const toolName of input.activeToolNames) {
    const normalized = normalizeToolName(toolName);
    if (!knownToolNames.has(normalized)) continue;
    if (!isManagedBrewvaToolName(normalized)) {
      if (turnPlan.preSkillGateActive) {
        continue;
      }
      active.add(normalized);
    }
  }

  const bootstrapManagedToolNames = new Set<string>(
    turnPlan.preSkillGateActive ? PRE_SKILL_CONTROL_PLANE_TOOL_NAMES : BOOTSTRAP_MANAGED_TOOL_NAMES,
  );
  const allowedRequestedManagedToolNames = turnPlan.hasActiveSkill
    ? new Set<string>(MANAGED_BREWVA_TOOL_NAMES)
    : turnPlan.preSkillGateActive
      ? new Set<string>(PRE_SKILL_CONTROL_PLANE_TOOL_NAMES)
      : new Set<string>([...BOOTSTRAP_MANAGED_TOOL_NAMES, ...OPERATOR_BREWVA_TOOL_NAMES]);
  const requestedActivatedToolNames = resolveRequestedManagedToolNames(
    turnPlan.requestedToolNames,
    knownToolNames,
    allowedRequestedManagedToolNames,
  );

  if (turnPlan.hasActiveSkill) {
    for (const toolName of BUILTIN_ALWAYS_ON_TOOL_NAMES) {
      if (knownToolNames.has(toolName)) {
        active.add(toolName);
      }
    }
    for (const toolName of BASE_BREWVA_TOOL_NAMES) {
      if (knownToolNames.has(toolName)) {
        active.add(toolName);
      }
    }
    for (const toolName of turnPlan.skillManagedToolNames) {
      if (knownToolNames.has(toolName)) {
        active.add(toolName);
      }
    }
  }

  for (const toolName of requestedActivatedToolNames) {
    active.add(toolName);
  }
  for (const toolName of bootstrapManagedToolNames) {
    if (knownToolNames.has(toolName)) {
      active.add(toolName);
    }
  }

  if (turnPlan.hasActiveSkill && knownToolNames.has("skill_complete")) {
    active.add("skill_complete");
  }
  if (knownToolNames.has("skill_load")) {
    active.add("skill_load");
  }
  if (knownToolNames.has("workflow_status")) {
    active.add("workflow_status");
  }

  if (turnPlan.operatorProfile && !turnPlan.preSkillGateActive) {
    for (const toolName of OPERATOR_BREWVA_TOOL_NAMES) {
      if (knownToolNames.has(toolName)) {
        active.add(toolName);
      }
    }
  }

  const activeToolNames = allToolNames.filter((toolName) => active.has(toolName));
  const baseActiveCount = activeToolNames.filter(
    (toolName) => getBrewvaToolSurface(toolName) === "base",
  ).length;
  const skillActiveCount = activeToolNames.filter(
    (toolName) => getBrewvaToolSurface(toolName) === "skill",
  ).length;
  const operatorActiveCount = activeToolNames.filter(
    (toolName) => getBrewvaToolSurface(toolName) === "operator",
  ).length;
  const externalActiveCount = activeToolNames.filter(
    (toolName) => getBrewvaToolSurface(toolName) === undefined,
  ).length;
  const hiddenSkillCount = allToolNames.filter(
    (toolName) => !active.has(toolName) && getBrewvaToolSurface(toolName) === "skill",
  ).length;
  const hiddenOperatorCount = allToolNames.filter(
    (toolName) => !active.has(toolName) && getBrewvaToolSurface(toolName) === "operator",
  ).length;

  return {
    activeToolNames,
    managedActiveCount: [...active].filter((toolName) => isManagedBrewvaToolName(toolName)).length,
    requestedToolNames: turnPlan.requestedToolNames.filter((toolName) =>
      knownToolNames.has(toolName),
    ),
    requestedActivatedToolNames,
    ignoredRequestedToolNames: turnPlan.requestedToolNames
      .filter((toolName) => knownToolNames.has(toolName))
      .filter((toolName) => !requestedActivatedToolNames.includes(toolName)),
    skillNames: turnPlan.skillNames,
    recommendedSkillNames: turnPlan.recommendedSkillNames,
    skillGateMode: turnPlan.skillGateMode,
    taskSpecReady: turnPlan.taskSpecReady,
    operatorProfile: turnPlan.operatorProfile,
    baseActiveCount,
    skillActiveCount,
    operatorActiveCount,
    externalActiveCount,
    hiddenSkillCount,
    hiddenOperatorCount,
    recommendationSet: turnPlan.recommendationSet,
  };
}

type ResolvedToolSurface = ReturnType<typeof resolveActiveToolNames>;

function computeSkillEnforcementKey(
  resolved: Pick<ResolvedToolSurface, "skillNames" | "recommendedSkillNames" | "skillGateMode">,
): string {
  if (resolved.skillNames.length > 0) {
    return "";
  }
  if (
    resolved.skillGateMode !== "skill_load_required" ||
    resolved.recommendedSkillNames.length === 0
  ) {
    return "";
  }
  return `skill_load_required:${resolved.recommendedSkillNames.join(",")}`;
}

export interface RegisterToolSurfaceOptions {
  dynamicToolDefinitions?: ReadonlyMap<string, ToolDefinition>;
}

export interface ToolSurfaceLifecycle {
  beforeAgentStart: (event: unknown, ctx: unknown) => undefined;
  toolResult: (
    event: unknown,
    ctx: unknown,
  ) =>
    | {
        content?: ToolResultEvent["content"];
      }
    | undefined;
  sessionShutdown: (event: unknown, ctx: unknown) => undefined;
}

function resolveAndActivateToolSurface(input: {
  extensionApi: ExtensionAPI;
  runtime: ToolSurfaceRuntime;
  sessionId: string;
  prompt: string;
  dynamicToolDefinitions?: ReadonlyMap<string, ToolDefinition>;
}): ResolvedToolSurface | undefined {
  const allToolsGetter = (input.extensionApi as { getAllTools?: () => ToolInfo[] }).getAllTools;
  const activeToolsGetter = (input.extensionApi as { getActiveTools?: () => string[] })
    .getActiveTools;
  const setActiveTools = (input.extensionApi as { setActiveTools?: (toolNames: string[]) => void })
    .setActiveTools;
  if (
    typeof allToolsGetter !== "function" ||
    typeof activeToolsGetter !== "function" ||
    typeof setActiveTools !== "function"
  ) {
    return undefined;
  }

  const allTools = allToolsGetter.call(input.extensionApi);
  if (!Array.isArray(allTools) || allTools.length === 0) {
    return undefined;
  }

  const turnPlan = resolveTurnSurfacePlan({
    runtime: input.runtime,
    sessionId: input.sessionId,
    prompt: input.prompt,
    dynamicToolDefinitions: input.dynamicToolDefinitions,
  });
  const knownToolNames = new Set(allTools.map((tool) => normalizeToolName(tool.name)));
  registerMissingManagedTools({
    extensionApi: input.extensionApi,
    dynamicToolDefinitions: input.dynamicToolDefinitions,
    knownToolNames,
    turnPlan,
  });
  const refreshedTools = allToolsGetter.call(input.extensionApi);
  if (!Array.isArray(refreshedTools) || refreshedTools.length === 0) {
    return undefined;
  }
  const resolved = resolveActiveToolNames({
    allTools: refreshedTools,
    activeToolNames: activeToolsGetter.call(input.extensionApi),
    turnPlan,
  });
  setActiveTools.call(input.extensionApi, resolved.activeToolNames);

  input.runtime.recordEvent({
    sessionId: input.sessionId,
    type: TOOL_SURFACE_RESOLVED_EVENT_TYPE,
    payload: {
      availableCount: refreshedTools.length,
      activeCount: resolved.activeToolNames.length,
      managedCount: MANAGED_BREWVA_TOOL_NAMES.length,
      managedActiveCount: resolved.managedActiveCount,
      requestedToolNames: resolved.requestedToolNames,
      requestedActivatedToolNames: resolved.requestedActivatedToolNames,
      ignoredRequestedToolNames: resolved.ignoredRequestedToolNames,
      skillNames: resolved.skillNames,
      recommendedSkillNames: resolved.recommendedSkillNames,
      skillGateMode: resolved.skillGateMode,
      taskSpecReady: resolved.taskSpecReady,
      operatorProfile: resolved.operatorProfile,
      baseActiveCount: resolved.baseActiveCount,
      skillActiveCount: resolved.skillActiveCount,
      operatorActiveCount: resolved.operatorActiveCount,
      externalActiveCount: resolved.externalActiveCount,
      hiddenSkillCount: resolved.hiddenSkillCount,
      hiddenOperatorCount: resolved.hiddenOperatorCount,
    },
  });

  return resolved;
}

function registerMissingManagedTools(input: {
  extensionApi: ExtensionAPI;
  dynamicToolDefinitions?: ReadonlyMap<string, ToolDefinition>;
  knownToolNames: Set<string>;
  turnPlan: TurnSurfacePlan;
}): void {
  if (!input.dynamicToolDefinitions || input.dynamicToolDefinitions.size === 0) return;
  const namesToEnsure = [
    ...(input.turnPlan.preSkillGateActive
      ? input.turnPlan.requestedManagedToolNames.filter((toolName) =>
          PRE_SKILL_CONTROL_PLANE_TOOL_NAMES.includes(
            toolName as (typeof PRE_SKILL_CONTROL_PLANE_TOOL_NAMES)[number],
          ),
        )
      : input.turnPlan.requestedManagedToolNames),
    ...(input.turnPlan.preSkillGateActive ? [] : input.turnPlan.skillManagedToolNames),
    ...input.turnPlan.lifecycleManagedToolNames,
    ...(input.turnPlan.preSkillGateActive ? [] : input.turnPlan.operatorManagedToolNames),
  ];

  for (const toolName of new Set(namesToEnsure)) {
    if (input.knownToolNames.has(toolName)) continue;
    const toolDefinition = input.dynamicToolDefinitions.get(toolName);
    if (!toolDefinition) continue;
    input.extensionApi.registerTool(toolDefinition);
    input.knownToolNames.add(toolName);
  }
}

export function createToolSurfaceLifecycle(
  extensionApi: ExtensionAPI,
  runtime: ToolSurfaceRuntime,
  options: RegisterToolSurfaceOptions = {},
): ToolSurfaceLifecycle {
  const latestPromptBySession = new Map<string, string>();
  const skillEnforcementKeyBySession = new Map<string, string>();
  const recommendationReceiptKeyBySession = new Map<string, string>();

  return {
    beforeAgentStart(event, ctx) {
      const rawEvent = event as { prompt?: unknown };
      const prompt = typeof rawEvent.prompt === "string" ? rawEvent.prompt : "";
      const sessionId = getSessionId(ctx);
      if (!sessionId) {
        return undefined;
      }

      latestPromptBySession.set(sessionId, prompt);
      const resolved = resolveAndActivateToolSurface({
        extensionApi,
        runtime,
        sessionId,
        prompt,
        dynamicToolDefinitions: options.dynamicToolDefinitions,
      });
      if (resolved) {
        skillEnforcementKeyBySession.set(sessionId, computeSkillEnforcementKey(resolved));
        recommendationReceiptKeyBySession.set(
          sessionId,
          computeSkillRecommendationReceiptKey(resolved.recommendationSet),
        );
      } else {
        skillEnforcementKeyBySession.delete(sessionId);
        recommendationReceiptKeyBySession.delete(sessionId);
      }
      return undefined;
    },
    toolResult(event, ctx) {
      const rawEvent = event as {
        toolName?: unknown;
        isError?: unknown;
        content?: unknown;
      };
      if (rawEvent.isError === true) {
        return undefined;
      }

      const sessionId = getSessionId(ctx);
      if (!sessionId) {
        return undefined;
      }

      const toolName =
        typeof rawEvent.toolName === "string" ? normalizeToolName(rawEvent.toolName) : "";
      if (!TASK_CONTEXT_MUTATION_TOOL_NAMES.has(toolName)) {
        return undefined;
      }

      const prompt = latestPromptBySession.get(sessionId)?.trim();
      if (!prompt) {
        return undefined;
      }

      const resolved = resolveAndActivateToolSurface({
        extensionApi,
        runtime,
        sessionId,
        prompt,
        dynamicToolDefinitions: options.dynamicToolDefinitions,
      });
      if (!resolved) {
        return undefined;
      }

      const nextKey = computeSkillEnforcementKey(resolved);
      const previousKey = skillEnforcementKeyBySession.get(sessionId) ?? "";
      skillEnforcementKeyBySession.set(sessionId, nextKey);
      if (!nextKey || nextKey === previousKey) {
        return undefined;
      }

      const recommendations = resolved.recommendationSet;
      const nextReceiptKey = computeSkillRecommendationReceiptKey(recommendations);
      const previousReceiptKey = recommendationReceiptKeyBySession.get(sessionId) ?? "";
      recommendationReceiptKeyBySession.set(sessionId, nextReceiptKey);
      if (nextReceiptKey && nextReceiptKey !== previousReceiptKey) {
        const payload = buildSkillRecommendationReceiptPayload(recommendations);
        if (payload) {
          runtime.recordEvent({
            sessionId,
            type: SKILL_RECOMMENDATION_DERIVED_EVENT_TYPE,
            payload,
          });
        }
      }
      const policyBlock = buildSkillFirstPolicyBlock(recommendations);
      if (
        recommendations.activeSkillName ||
        recommendations.gateMode !== "skill_load_required" ||
        recommendations.recommendations.length === 0 ||
        !policyBlock
      ) {
        return undefined;
      }

      return {
        content: [
          {
            type: "text",
            text: [
              "[Brewva Skill-First Refresh]",
              `Task state changed after \`${toolName}\` and Brewva now requires \`skill_load\` before deeper tool work.`,
              policyBlock,
            ].join("\n"),
          },
          ...normalizeToolResultContent(rawEvent.content),
        ],
      };
    },
    sessionShutdown(_event, ctx) {
      const sessionId = getSessionId(ctx);
      if (!sessionId) {
        return undefined;
      }
      latestPromptBySession.delete(sessionId);
      skillEnforcementKeyBySession.delete(sessionId);
      recommendationReceiptKeyBySession.delete(sessionId);
      return undefined;
    },
  };
}

export function registerToolSurface(
  extensionApi: ExtensionAPI,
  runtime: ToolSurfaceRuntime,
  options: RegisterToolSurfaceOptions = {},
): void {
  const hooks = extensionApi as unknown as {
    on(event: string, handler: (event: unknown, ctx: unknown) => unknown): void;
  };
  const lifecycle = createToolSurfaceLifecycle(extensionApi, runtime, options);
  hooks.on("before_agent_start", lifecycle.beforeAgentStart);
  hooks.on("tool_result", lifecycle.toolResult);
  hooks.on("session_shutdown", lifecycle.sessionShutdown);
}
