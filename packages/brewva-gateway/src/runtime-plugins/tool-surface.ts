import {
  TOOL_SURFACE_RESOLVED_EVENT_TYPE,
  getToolGovernanceDescriptor,
  listSkillAllowedEffects,
  listSkillDeniedEffects,
  listSkillFallbackTools,
  listSkillPreferredTools,
  type SkillContract,
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
import type { ExtensionAPI, ToolDefinition, ToolInfo } from "@mariozechner/pi-coding-agent";

const CAPABILITY_REQUEST_PATTERN = /\$([a-z][a-z0-9_]*)/g;
const BUILTIN_ALWAYS_ON_TOOL_NAMES = ["read", "edit", "write"] as const;
const MANAGED_TOOL_NAME_SET = new Set(MANAGED_BREWVA_TOOL_NAMES);
const BOOTSTRAP_MANAGED_TOOL_NAMES = [
  "skill_load",
  "workflow_status",
  "session_compact",
  "task_set_spec",
  "task_view_state",
  "task_add_item",
  "task_update_item",
  "task_record_blocker",
  "task_resolve_blocker",
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

type ToolSurfaceSkill = {
  name: string;
  contract: SkillContract;
};

export interface ToolSurfaceRuntime {
  config: {
    skills: {
      routing: {
        scopes: readonly string[];
      };
    };
  };
  tools?: {
    getGovernanceDescriptor?(
      toolName: string,
      args?: Record<string, unknown>,
    ): ReturnType<typeof getToolGovernanceDescriptor>;
  };
  skills: {
    getActive(sessionId: string): ToolSurfaceSkill | null | undefined;
    get(name: string): ToolSurfaceSkill | undefined;
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
  events: {
    record(input: { sessionId: string; type: string; payload?: object }): unknown;
  };
}

function normalizeToolName(name: string): string {
  return name.trim().toLowerCase();
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
  const active = runtime.skills.getActive(sessionId);

  appendSkillName(names, active?.name);

  return names
    .map((name) => runtime.skills.get(name))
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
    runtime.tools?.getGovernanceDescriptor?.(toolName) ??
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
  skillNames: string[];
  hasActiveSkill: boolean;
  skillManagedToolNames: string[];
  lifecycleManagedToolNames: string[];
  operatorManagedToolNames: string[];
  operatorProfile: boolean;
};

function resolveTurnSurfacePlan(input: {
  runtime: ToolSurfaceRuntime;
  sessionId: string;
  prompt: string;
  dynamicToolDefinitions?: ReadonlyMap<string, ToolDefinition>;
}): TurnSurfacePlan {
  const requestedToolNames = extractRequestedToolNames(input.prompt);
  const requestedManagedToolNames = extractRequestedToolNames(input.prompt).filter((toolName) =>
    MANAGED_TOOL_NAME_SET.has(toolName),
  );
  const surfaceSkills = resolveSurfaceSkills(input.runtime, input.sessionId);
  const hasActiveSkill = surfaceSkills.length > 0;
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

  return {
    requestedToolNames,
    requestedManagedToolNames,
    skillNames: surfaceSkills.map((skill) => skill.name),
    hasActiveSkill,
    skillManagedToolNames,
    lifecycleManagedToolNames: [...new Set(lifecycleManagedToolNames)],
    operatorManagedToolNames,
    operatorProfile,
  };
}

function resolveActiveToolNames(input: {
  runtime: ToolSurfaceRuntime;
  sessionId: string;
  prompt: string;
  allTools: ToolInfo[];
  activeToolNames: string[];
  dynamicToolDefinitions?: ReadonlyMap<string, ToolDefinition>;
}): {
  activeToolNames: string[];
  managedActiveCount: number;
  requestedToolNames: string[];
  requestedActivatedToolNames: string[];
  ignoredRequestedToolNames: string[];
  skillNames: string[];
  operatorProfile: boolean;
  baseActiveCount: number;
  skillActiveCount: number;
  operatorActiveCount: number;
  externalActiveCount: number;
  hiddenSkillCount: number;
  hiddenOperatorCount: number;
} {
  const allToolNames = input.allTools.map((tool) => normalizeToolName(tool.name));
  const knownToolNames = new Set(allToolNames);
  const active = new Set<string>();
  const turnPlan = resolveTurnSurfacePlan({
    runtime: input.runtime,
    sessionId: input.sessionId,
    prompt: input.prompt,
    dynamicToolDefinitions: input.dynamicToolDefinitions,
  });

  for (const toolName of input.activeToolNames) {
    const normalized = normalizeToolName(toolName);
    if (!knownToolNames.has(normalized)) continue;
    if (!isManagedBrewvaToolName(normalized)) {
      active.add(normalized);
    }
  }

  const bootstrapManagedToolNames = new Set<string>(BOOTSTRAP_MANAGED_TOOL_NAMES);
  const allowedRequestedManagedToolNames = turnPlan.hasActiveSkill
    ? new Set<string>(MANAGED_BREWVA_TOOL_NAMES)
    : new Set<string>([...bootstrapManagedToolNames, ...OPERATOR_BREWVA_TOOL_NAMES]);
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
  for (const toolName of BOOTSTRAP_MANAGED_TOOL_NAMES) {
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

  if (turnPlan.operatorProfile) {
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
    operatorProfile: turnPlan.operatorProfile,
    baseActiveCount,
    skillActiveCount,
    operatorActiveCount,
    externalActiveCount,
    hiddenSkillCount,
    hiddenOperatorCount,
  };
}

export interface RegisterToolSurfaceOptions {
  dynamicToolDefinitions?: ReadonlyMap<string, ToolDefinition>;
}

export interface ToolSurfaceLifecycle {
  beforeAgentStart: (event: unknown, ctx: unknown) => undefined;
}

function registerMissingManagedTools(input: {
  extensionApi: ExtensionAPI;
  runtime: ToolSurfaceRuntime;
  sessionId: string;
  prompt: string;
  dynamicToolDefinitions?: ReadonlyMap<string, ToolDefinition>;
  knownToolNames: Set<string>;
}): void {
  if (!input.dynamicToolDefinitions || input.dynamicToolDefinitions.size === 0) return;

  const turnPlan = resolveTurnSurfacePlan({
    runtime: input.runtime,
    sessionId: input.sessionId,
    prompt: input.prompt,
    dynamicToolDefinitions: input.dynamicToolDefinitions,
  });
  const namesToEnsure = [
    ...turnPlan.requestedManagedToolNames,
    ...turnPlan.skillManagedToolNames,
    ...turnPlan.lifecycleManagedToolNames,
    ...turnPlan.operatorManagedToolNames,
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
  return {
    beforeAgentStart(event, ctx) {
      const rawEvent = event as { prompt?: unknown };
      const allToolsGetter = (extensionApi as { getAllTools?: () => ToolInfo[] }).getAllTools;
      const activeToolsGetter = (extensionApi as { getActiveTools?: () => string[] })
        .getActiveTools;
      const setActiveTools = (extensionApi as { setActiveTools?: (toolNames: string[]) => void })
        .setActiveTools;
      if (
        typeof allToolsGetter !== "function" ||
        typeof activeToolsGetter !== "function" ||
        typeof setActiveTools !== "function"
      ) {
        return undefined;
      }

      const allTools = allToolsGetter.call(extensionApi);
      if (!Array.isArray(allTools) || allTools.length === 0) {
        return undefined;
      }

      const prompt = typeof rawEvent.prompt === "string" ? rawEvent.prompt : "";
      const sessionId = (
        ctx as { sessionManager: { getSessionId: () => string } }
      ).sessionManager.getSessionId();
      const knownToolNames = new Set(allTools.map((tool) => normalizeToolName(tool.name)));
      registerMissingManagedTools({
        extensionApi,
        runtime,
        sessionId,
        prompt,
        dynamicToolDefinitions: options.dynamicToolDefinitions,
        knownToolNames,
      });
      const refreshedTools = allToolsGetter.call(extensionApi);
      if (!Array.isArray(refreshedTools) || refreshedTools.length === 0) {
        return undefined;
      }
      const resolved = resolveActiveToolNames({
        runtime,
        sessionId,
        prompt,
        allTools: refreshedTools,
        activeToolNames: activeToolsGetter.call(extensionApi),
        dynamicToolDefinitions: options.dynamicToolDefinitions,
      });
      setActiveTools.call(extensionApi, resolved.activeToolNames);

      runtime.events.record({
        sessionId,
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
          operatorProfile: resolved.operatorProfile,
          baseActiveCount: resolved.baseActiveCount,
          skillActiveCount: resolved.skillActiveCount,
          operatorActiveCount: resolved.operatorActiveCount,
          externalActiveCount: resolved.externalActiveCount,
          hiddenSkillCount: resolved.hiddenSkillCount,
          hiddenOperatorCount: resolved.hiddenOperatorCount,
        },
      });
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
}
