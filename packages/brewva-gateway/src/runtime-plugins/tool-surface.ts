import {
  SKILL_REPAIR_ALLOWED_TOOL_NAMES,
  SKILL_RECOMMENDATION_DERIVED_EVENT_TYPE,
  TOOL_SURFACE_RESOLVED_EVENT_TYPE,
  deriveToolGovernanceDescriptor,
  getToolActionPolicy,
  listSkillAllowedEffects,
  listSkillDeniedEffects,
  listSkillFallbackTools,
  listSkillPreferredTools,
  type SkillCompletionFailureRecord,
  type SkillDocument,
  type ToolEffectClass,
} from "@brewva/brewva-runtime";
import type {
  InternalHostPluginApi as ExtensionAPI,
  BrewvaHostToolInfo as ToolInfo,
  BrewvaHostToolResultEvent as ToolResultEvent,
  BrewvaToolDefinition as ToolDefinition,
} from "@brewva/brewva-substrate";
import {
  BASE_BREWVA_TOOL_NAMES,
  CONTROL_PLANE_BREWVA_TOOL_NAMES,
  getBrewvaToolSurface,
  MANAGED_BREWVA_TOOL_NAMES,
  OPERATOR_BREWVA_TOOL_NAMES,
  SKILL_BREWVA_TOOL_NAMES,
  isManagedBrewvaToolName,
} from "@brewva/brewva-tools";
import {
  buildSkillRecommendationReceiptPayload,
  buildSkillFirstPolicyBlock,
  computeSkillRecommendationReceiptKey,
  deriveSkillRecommendations,
  type SkillClassificationHint,
  type SkillRecommendationSet,
  type ToolAvailabilityPosture,
} from "./skill-first.js";

const CAPABILITY_REQUEST_PATTERN = /\$([a-z][a-z0-9_]*)/g;
const BUILTIN_ALWAYS_ON_TOOL_NAMES = ["read", "edit", "write"] as const;
const MANAGED_TOOL_NAME_SET = new Set(MANAGED_BREWVA_TOOL_NAMES);
const REPAIR_ALLOWED_TOOL_NAME_SET = new Set<string>(SKILL_REPAIR_ALLOWED_TOOL_NAMES);
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
const FAILED_CONTRACT_CONTROL_PLANE_TOOL_NAMES = [
  "workflow_status",
  "task_view_state",
  "ledger_query",
  "tape_info",
  "reasoning_checkpoint",
  "reasoning_revert",
  "session_compact",
] as const;
const BOOTSTRAP_MANAGED_TOOL_NAMES = [
  ...PRE_SKILL_CONTROL_PLANE_TOOL_NAMES,
  "recall_search",
  "knowledge_search",
  "precedent_audit",
  "precedent_sweep",
  "deliberation_memory",
  "output_search",
  "ledger_query",
  "tape_info",
  "tape_handoff",
] as const;
const TASK_CONTEXT_MUTATION_TOOL_NAMES = new Set([
  "task_set_spec",
  "task_add_item",
  "task_update_item",
  "task_record_blocker",
  "task_resolve_blocker",
]);
const SKILL_LIFECYCLE_MUTATION_TOOL_NAMES = new Set(["skill_load", "skill_complete"]);
const TOOL_SURFACE_REFRESH_TOOL_NAMES = new Set([
  ...TASK_CONTEXT_MUTATION_TOOL_NAMES,
  ...SKILL_LIFECYCLE_MUTATION_TOOL_NAMES,
]);

type ToolSurfaceSkill = Pick<
  SkillDocument,
  "name" | "description" | "category" | "markdown" | "contract"
>;

type ToolSurfaceSkillState = {
  skillName: string;
  phase: "active" | "repair_required";
  repairBudget?: {
    remainingAttempts: number;
    remainingToolCalls: number;
    tokenBudget: number;
    usedTokens?: number;
  };
};

type ActiveSkillEffectPolicy = {
  active: boolean;
  allowedEffects: ReadonlySet<ToolEffectClass>;
  deniedEffects: ReadonlySet<ToolEffectClass>;
};

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
      getActionPolicy(
        toolName: string,
        args?: Record<string, unknown>,
      ): ReturnType<typeof getToolActionPolicy>;
    };
    skills: {
      list(): ToolSurfaceSkill[];
      getActive(sessionId: string): ToolSurfaceSkill | null | undefined;
      getActiveState(sessionId: string): ToolSurfaceSkillState | undefined;
      getLatestFailure?(sessionId: string): SkillCompletionFailureRecord | undefined;
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

function resolveSurfaceSkills(runtime: ToolSurfaceRuntime, sessionId: string): ToolSurfaceSkill[] {
  const active = runtime.inspect.skills.getActive(sessionId);
  if (active) {
    return [active];
  }

  return [];
}

function resolveManagedToolGovernanceDescriptor(
  runtime: ToolSurfaceRuntime,
  toolName: string,
  _dynamicToolDefinitions?: ReadonlyMap<string, ToolDefinition>,
) {
  const policy = runtime.inspect.tools.getActionPolicy(toolName) ?? getToolActionPolicy(toolName);
  return policy ? deriveToolGovernanceDescriptor(policy) : undefined;
}

function routingScopesAllowTool(
  runtime: ToolSurfaceRuntime,
  descriptor: ReturnType<typeof deriveToolGovernanceDescriptor> | undefined,
): boolean {
  const requiredRoutingScopes = descriptor?.requiredRoutingScopes ?? [];
  if (requiredRoutingScopes.length === 0) {
    return true;
  }
  const routingScopes = new Set(runtime.config.skills.routing.scopes);
  return requiredRoutingScopes.some((scope) => routingScopes.has(scope));
}

function collectRequestableOperatorManagedToolNames(
  runtime: ToolSurfaceRuntime,
  knownToolNames: ReadonlySet<string>,
  dynamicToolDefinitions?: ReadonlyMap<string, ToolDefinition>,
): string[] {
  return OPERATOR_BREWVA_TOOL_NAMES.filter((toolName) => {
    if (!knownToolNames.has(toolName)) {
      return false;
    }
    const descriptor = resolveManagedToolGovernanceDescriptor(
      runtime,
      toolName,
      dynamicToolDefinitions,
    );
    if (!descriptor) {
      return false;
    }
    return routingScopesAllowTool(runtime, descriptor);
  });
}

function collectSkillToolNames(
  runtime: ToolSurfaceRuntime,
  skills: ToolSurfaceSkill[],
  dynamicToolDefinitions?: ReadonlyMap<string, ToolDefinition>,
): string[] {
  const names = new Set<string>();
  for (const skill of skills) {
    for (const toolName of listSkillPreferredTools(skill.contract)) {
      const descriptor = resolveManagedToolGovernanceDescriptor(
        runtime,
        toolName,
        dynamicToolDefinitions,
      );
      if (!routingScopesAllowTool(runtime, descriptor)) {
        continue;
      }
      names.add(normalizeToolName(toolName));
    }
    for (const toolName of listSkillFallbackTools(skill.contract)) {
      const descriptor = resolveManagedToolGovernanceDescriptor(
        runtime,
        toolName,
        dynamicToolDefinitions,
      );
      if (!routingScopesAllowTool(runtime, descriptor)) {
        continue;
      }
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
      if (!routingScopesAllowTool(runtime, descriptor)) {
        continue;
      }
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

function resolveActiveSkillEffectPolicy(skills: ToolSurfaceSkill[]): ActiveSkillEffectPolicy {
  const allowedEffects = new Set<ToolEffectClass>();
  const deniedEffects = new Set<ToolEffectClass>();
  for (const skill of skills) {
    for (const effect of listSkillAllowedEffects(skill.contract)) {
      allowedEffects.add(effect);
    }
    for (const effect of listSkillDeniedEffects(skill.contract)) {
      deniedEffects.add(effect);
    }
  }
  return {
    active: skills.length > 0,
    allowedEffects,
    deniedEffects,
  };
}

function isToolAllowedByActiveSkillEffectPolicy(input: {
  runtime: ToolSurfaceRuntime;
  toolName: string;
  effectPolicy: ActiveSkillEffectPolicy;
  lifecycleManagedToolNames: ReadonlySet<string>;
  dynamicToolDefinitions?: ReadonlyMap<string, ToolDefinition>;
}): boolean {
  if (!input.effectPolicy.active) {
    return true;
  }
  if (
    getBrewvaToolSurface(input.toolName) === "control_plane" ||
    input.lifecycleManagedToolNames.has(input.toolName)
  ) {
    return true;
  }

  const descriptor = resolveManagedToolGovernanceDescriptor(
    input.runtime,
    input.toolName,
    input.dynamicToolDefinitions,
  );
  if (!descriptor) {
    return false;
  }
  if (descriptor.effects.some((effect) => input.effectPolicy.deniedEffects.has(effect))) {
    return false;
  }
  return descriptor.effects.every((effect) => input.effectPolicy.allowedEffects.has(effect));
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
  repairRequired: boolean;
  recommendedSkillNames: string[];
  skillActivationPosture: SkillRecommendationSet["activationPosture"];
  toolAvailabilityPosture: ToolAvailabilityPosture;
  taskSpecReady: boolean;
  skillManagedToolNames: string[];
  lifecycleManagedToolNames: string[];
  operatorManagedToolNames: string[];
  operatorProfile: boolean;
  activeSkillEffectPolicy: ActiveSkillEffectPolicy;
};

function isLifecycleManagedTool(toolName: string): boolean {
  return (
    PRE_SKILL_CONTROL_PLANE_TOOL_NAMES.includes(
      toolName as (typeof PRE_SKILL_CONTROL_PLANE_TOOL_NAMES)[number],
    ) || toolName === "skill_complete"
  );
}

function isContractRepairManagedTool(toolName: string): boolean {
  return FAILED_CONTRACT_CONTROL_PLANE_TOOL_NAMES.includes(
    toolName as (typeof FAILED_CONTRACT_CONTROL_PLANE_TOOL_NAMES)[number],
  );
}

function isReadLikeToolPolicy(runtime: ToolSurfaceRuntime, toolName: string): boolean {
  const policy = runtime.inspect.tools.getActionPolicy(toolName) ?? getToolActionPolicy(toolName);
  if (!policy) {
    return false;
  }
  return policy.actionClass === "workspace_read" || policy.actionClass === "runtime_observe";
}

function isToolAllowedForPosture(input: {
  runtime: ToolSurfaceRuntime;
  toolName: string;
  posture: ToolAvailabilityPosture;
  managed: boolean;
}): boolean {
  if (input.posture === "none" || input.posture === "recommend") {
    return true;
  }
  if (input.posture === "contract_failed") {
    return input.managed && isContractRepairManagedTool(input.toolName);
  }
  if (input.posture === "require_execute") {
    return input.managed && isLifecycleManagedTool(input.toolName);
  }
  return (
    (input.managed && isLifecycleManagedTool(input.toolName)) ||
    isReadLikeToolPolicy(input.runtime, input.toolName)
  );
}

function collectPostureAllowedManagedToolNames(
  runtime: ToolSurfaceRuntime,
  posture: ToolAvailabilityPosture,
): string[] {
  return MANAGED_BREWVA_TOOL_NAMES.filter((toolName) =>
    isToolAllowedForPosture({
      runtime,
      toolName,
      posture,
      managed: true,
    }),
  );
}

function resolveAllowedRequestedManagedToolNames(input: {
  runtime: ToolSurfaceRuntime;
  knownToolNames: ReadonlySet<string>;
  turnPlan: TurnSurfacePlan;
  dynamicToolDefinitions?: ReadonlyMap<string, ToolDefinition>;
}): Set<string> {
  if (input.turnPlan.repairRequired) {
    return new Set(
      SKILL_REPAIR_ALLOWED_TOOL_NAMES.filter((toolName) => input.knownToolNames.has(toolName)),
    );
  }

  const postureAllowedManagedToolNames = collectPostureAllowedManagedToolNames(
    input.runtime,
    input.turnPlan.toolAvailabilityPosture,
  );
  if (input.turnPlan.hasActiveSkill) {
    return new Set(postureAllowedManagedToolNames);
  }

  const requestableOperatorManagedToolNames = collectRequestableOperatorManagedToolNames(
    input.runtime,
    input.knownToolNames,
    input.dynamicToolDefinitions,
  );
  return new Set(
    [
      ...input.turnPlan.lifecycleManagedToolNames,
      ...requestableOperatorManagedToolNames,
      ...input.turnPlan.operatorManagedToolNames,
    ].filter((toolName) => postureAllowedManagedToolNames.includes(toolName)),
  );
}

function resolveTurnSurfacePlan(input: {
  runtime: ToolSurfaceRuntime;
  sessionId: string;
  prompt: string;
  dynamicToolDefinitions?: ReadonlyMap<string, ToolDefinition>;
  classificationHints?: readonly SkillClassificationHint[];
}): TurnSurfacePlan {
  const requestedToolNames = extractRequestedToolNames(input.prompt);
  const requestedManagedToolNames = requestedToolNames.filter((toolName) =>
    MANAGED_TOOL_NAME_SET.has(toolName),
  );
  const surfaceSkills = resolveSurfaceSkills(input.runtime, input.sessionId);
  const activeSkillState = input.runtime.inspect.skills.getActiveState(input.sessionId);
  const hasActiveSkill = surfaceSkills.length > 0;
  const repairRequired = activeSkillState?.phase === "repair_required";
  const recommendationSet = deriveSkillRecommendations(input.runtime, {
    sessionId: input.sessionId,
    prompt: input.prompt,
    classificationHints: input.classificationHints,
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
  const toolAvailabilityPosture = hasActiveSkill
    ? "none"
    : recommendationSet.toolAvailabilityPosture;

  return {
    requestedToolNames,
    requestedManagedToolNames,
    recommendationSet,
    skillNames: surfaceSkills.map((skill) => skill.name),
    hasActiveSkill,
    repairRequired,
    recommendedSkillNames: recommendationSet.recommendations.map((entry) => entry.name),
    skillActivationPosture: recommendationSet.activationPosture,
    toolAvailabilityPosture,
    taskSpecReady: recommendationSet.taskSpecReady,
    skillManagedToolNames,
    lifecycleManagedToolNames: [...new Set(lifecycleManagedToolNames)],
    operatorManagedToolNames,
    operatorProfile,
    activeSkillEffectPolicy: resolveActiveSkillEffectPolicy(surfaceSkills),
  };
}

function resolveVisibleActiveToolNames(input: {
  allToolNames: string[];
  active: ReadonlySet<string>;
  runtime: ToolSurfaceRuntime;
  turnPlan: TurnSurfacePlan;
  dynamicToolDefinitions?: ReadonlyMap<string, ToolDefinition>;
}): string[] {
  const lifecycleManagedToolNames = new Set(input.turnPlan.lifecycleManagedToolNames);
  return input.allToolNames.filter((toolName) => {
    if (!input.active.has(toolName)) {
      return false;
    }
    if (input.turnPlan.repairRequired && !REPAIR_ALLOWED_TOOL_NAME_SET.has(toolName)) {
      return false;
    }
    return isToolAllowedByActiveSkillEffectPolicy({
      runtime: input.runtime,
      toolName,
      effectPolicy: input.turnPlan.activeSkillEffectPolicy,
      lifecycleManagedToolNames,
      dynamicToolDefinitions: input.dynamicToolDefinitions,
    });
  });
}

function filterActivatedRequestedToolNames(
  requestedActivatedToolNames: string[],
  activeToolNames: readonly string[],
): string[] {
  const activeToolNameSet = new Set(activeToolNames);
  return requestedActivatedToolNames.filter((toolName) => activeToolNameSet.has(toolName));
}

interface ToolSurfaceCounts {
  managedActiveCount: number;
  baseActiveCount: number;
  skillActiveCount: number;
  controlPlaneActiveCount: number;
  operatorActiveCount: number;
  externalActiveCount: number;
  hiddenSkillCount: number;
  hiddenControlPlaneCount: number;
  hiddenOperatorCount: number;
}

interface ResolvedToolSurface extends ToolSurfaceCounts {
  activeToolNames: string[];
  requestedToolNames: string[];
  requestedActivatedToolNames: string[];
  ignoredRequestedToolNames: string[];
  skillNames: string[];
  recommendedSkillNames: string[];
  skillActivationPosture: SkillRecommendationSet["activationPosture"];
  toolAvailabilityPosture: ToolAvailabilityPosture;
  taskSpecReady: boolean;
  operatorProfile: boolean;
  repairRequired: boolean;
  recommendationSet: SkillRecommendationSet;
}

function computeToolSurfaceCounts(input: {
  allToolNames: readonly string[];
  activeToolNames: readonly string[];
}): ToolSurfaceCounts {
  const activeToolNameSet = new Set(input.activeToolNames);
  const countActiveBySurface = (surface: ReturnType<typeof getBrewvaToolSurface>) =>
    input.activeToolNames.filter((toolName) => getBrewvaToolSurface(toolName) === surface).length;
  const countHiddenBySurface = (
    surface: Exclude<ReturnType<typeof getBrewvaToolSurface>, undefined>,
  ) =>
    input.allToolNames.filter(
      (toolName) => !activeToolNameSet.has(toolName) && getBrewvaToolSurface(toolName) === surface,
    ).length;

  return {
    managedActiveCount: input.activeToolNames.filter((toolName) =>
      isManagedBrewvaToolName(toolName),
    ).length,
    baseActiveCount: countActiveBySurface("base"),
    skillActiveCount: countActiveBySurface("skill"),
    controlPlaneActiveCount: countActiveBySurface("control_plane"),
    operatorActiveCount: countActiveBySurface("operator"),
    externalActiveCount: countActiveBySurface(undefined),
    hiddenSkillCount: countHiddenBySurface("skill"),
    hiddenControlPlaneCount: countHiddenBySurface("control_plane"),
    hiddenOperatorCount: countHiddenBySurface("operator"),
  };
}

function buildResolvedToolSurface(input: {
  allToolNames: readonly string[];
  activeToolNames: string[];
  knownToolNames: ReadonlySet<string>;
  requestedActivatedToolNames: string[];
  turnPlan: TurnSurfacePlan;
  repairRequired: boolean;
}): ResolvedToolSurface {
  const requestedToolNames = input.turnPlan.requestedToolNames.filter((toolName) =>
    input.knownToolNames.has(toolName),
  );
  const requestedActivatedToolNames = filterActivatedRequestedToolNames(
    input.requestedActivatedToolNames,
    input.activeToolNames,
  );

  return {
    activeToolNames: input.activeToolNames,
    ...computeToolSurfaceCounts({
      allToolNames: input.allToolNames,
      activeToolNames: input.activeToolNames,
    }),
    requestedToolNames,
    requestedActivatedToolNames,
    ignoredRequestedToolNames: requestedToolNames.filter(
      (toolName) => !requestedActivatedToolNames.includes(toolName),
    ),
    skillNames: input.turnPlan.skillNames,
    recommendedSkillNames: input.turnPlan.recommendedSkillNames,
    skillActivationPosture: input.turnPlan.skillActivationPosture,
    toolAvailabilityPosture: input.turnPlan.toolAvailabilityPosture,
    taskSpecReady: input.turnPlan.taskSpecReady,
    operatorProfile: input.turnPlan.operatorProfile,
    repairRequired: input.repairRequired,
    recommendationSet: input.turnPlan.recommendationSet,
  };
}

function resolveActiveToolNames(input: {
  allTools: ToolInfo[];
  activeToolNames: string[];
  turnPlan: TurnSurfacePlan;
  runtime: ToolSurfaceRuntime;
  dynamicToolDefinitions?: ReadonlyMap<string, ToolDefinition>;
}): ResolvedToolSurface {
  const allToolNames = input.allTools.map((tool) => normalizeToolName(tool.name));
  const knownToolNames = new Set(allToolNames);
  const active = new Set<string>();
  const turnPlan = input.turnPlan;
  for (const toolName of input.activeToolNames) {
    const normalized = normalizeToolName(toolName);
    if (!knownToolNames.has(normalized)) continue;
    if (!isManagedBrewvaToolName(normalized)) {
      if (
        !turnPlan.hasActiveSkill &&
        !isToolAllowedForPosture({
          runtime: input.runtime,
          toolName: normalized,
          posture: turnPlan.toolAvailabilityPosture,
          managed: false,
        })
      ) {
        continue;
      }
      active.add(normalized);
    }
  }

  const bootstrapManagedToolNames = new Set<string>(
    turnPlan.toolAvailabilityPosture === "contract_failed"
      ? FAILED_CONTRACT_CONTROL_PLANE_TOOL_NAMES
      : turnPlan.toolAvailabilityPosture === "require_execute"
        ? PRE_SKILL_CONTROL_PLANE_TOOL_NAMES
        : BOOTSTRAP_MANAGED_TOOL_NAMES,
  );
  const allowedRequestedManagedToolNames = resolveAllowedRequestedManagedToolNames({
    runtime: input.runtime,
    knownToolNames,
    turnPlan,
    dynamicToolDefinitions: input.dynamicToolDefinitions,
  });
  const requestedActivatedToolNames = resolveRequestedManagedToolNames(
    turnPlan.requestedToolNames,
    knownToolNames,
    allowedRequestedManagedToolNames,
  );

  if (turnPlan.toolAvailabilityPosture === "contract_failed") {
    for (const toolName of FAILED_CONTRACT_CONTROL_PLANE_TOOL_NAMES) {
      if (knownToolNames.has(toolName)) {
        active.add(toolName);
      }
    }

    const activeToolNames = resolveVisibleActiveToolNames({
      allToolNames,
      active,
      runtime: input.runtime,
      turnPlan,
      dynamicToolDefinitions: input.dynamicToolDefinitions,
    });

    return buildResolvedToolSurface({
      activeToolNames,
      allToolNames,
      knownToolNames,
      requestedActivatedToolNames,
      turnPlan,
      repairRequired: false,
    });
  }

  if (turnPlan.repairRequired) {
    active.clear();
    for (const toolName of requestedActivatedToolNames) {
      if (REPAIR_ALLOWED_TOOL_NAME_SET.has(toolName)) {
        active.add(toolName);
      }
    }
    for (const toolName of SKILL_REPAIR_ALLOWED_TOOL_NAMES) {
      if (knownToolNames.has(toolName)) {
        active.add(toolName);
      }
    }

    const activeToolNames = resolveVisibleActiveToolNames({
      allToolNames,
      active,
      runtime: input.runtime,
      turnPlan,
      dynamicToolDefinitions: input.dynamicToolDefinitions,
    });

    return buildResolvedToolSurface({
      activeToolNames,
      allToolNames,
      knownToolNames,
      requestedActivatedToolNames,
      turnPlan,
      repairRequired: true,
    });
  }

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
    for (const toolName of CONTROL_PLANE_BREWVA_TOOL_NAMES) {
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

  if (
    turnPlan.operatorProfile &&
    (turnPlan.toolAvailabilityPosture === "none" ||
      turnPlan.toolAvailabilityPosture === "recommend")
  ) {
    for (const toolName of OPERATOR_BREWVA_TOOL_NAMES) {
      if (knownToolNames.has(toolName)) {
        active.add(toolName);
      }
    }
  }

  const activeToolNames = resolveVisibleActiveToolNames({
    allToolNames,
    active,
    runtime: input.runtime,
    turnPlan,
    dynamicToolDefinitions: input.dynamicToolDefinitions,
  });

  return buildResolvedToolSurface({
    activeToolNames,
    allToolNames,
    knownToolNames,
    requestedActivatedToolNames,
    turnPlan,
    repairRequired: false,
  });
}

function computeSkillEnforcementKey(
  resolved: Pick<
    ResolvedToolSurface,
    "skillNames" | "recommendedSkillNames" | "skillActivationPosture"
  >,
): string {
  if (resolved.skillNames.length > 0) {
    return "";
  }
  if (
    resolved.skillActivationPosture.kind !== "require_skill_load" ||
    resolved.recommendedSkillNames.length === 0
  ) {
    return "";
  }
  return `require_skill_load:${resolved.recommendedSkillNames.join(",")}`;
}

export interface RegisterToolSurfaceOptions {
  dynamicToolDefinitions?: ReadonlyMap<string, ToolDefinition>;
  resolveClassificationHints?: (sessionId: string) => readonly SkillClassificationHint[];
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
  resolveClassificationHints?: (sessionId: string) => readonly SkillClassificationHint[];
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
    classificationHints: input.resolveClassificationHints?.(input.sessionId),
  });
  const knownToolNames = new Set(allTools.map((tool) => normalizeToolName(tool.name)));
  registerMissingManagedTools({
    extensionApi: input.extensionApi,
    runtime: input.runtime,
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
    runtime: input.runtime,
    dynamicToolDefinitions: input.dynamicToolDefinitions,
  });
  setActiveTools.call(input.extensionApi, resolved.activeToolNames);

  input.runtime.recordEvent({
    sessionId: input.sessionId,
    type: TOOL_SURFACE_RESOLVED_EVENT_TYPE,
    payload: {
      availableCount: refreshedTools.length,
      activeCount: resolved.activeToolNames.length,
      activeToolNames: resolved.activeToolNames,
      managedCount: MANAGED_BREWVA_TOOL_NAMES.length,
      managedActiveCount: resolved.managedActiveCount,
      requestedToolNames: resolved.requestedToolNames,
      requestedActivatedToolNames: resolved.requestedActivatedToolNames,
      ignoredRequestedToolNames: resolved.ignoredRequestedToolNames,
      skillNames: resolved.skillNames,
      recommendedSkillNames: resolved.recommendedSkillNames,
      skillActivationPosture: resolved.skillActivationPosture,
      toolAvailabilityPosture: resolved.toolAvailabilityPosture,
      taskSpecReady: resolved.taskSpecReady,
      operatorProfile: resolved.operatorProfile,
      repairRequired: resolved.repairRequired,
      baseActiveCount: resolved.baseActiveCount,
      skillActiveCount: resolved.skillActiveCount,
      controlPlaneActiveCount: resolved.controlPlaneActiveCount,
      operatorActiveCount: resolved.operatorActiveCount,
      externalActiveCount: resolved.externalActiveCount,
      hiddenSkillCount: resolved.hiddenSkillCount,
      hiddenControlPlaneCount: resolved.hiddenControlPlaneCount,
      hiddenOperatorCount: resolved.hiddenOperatorCount,
    },
  });

  return resolved;
}

function registerMissingManagedTools(input: {
  extensionApi: ExtensionAPI;
  runtime: ToolSurfaceRuntime;
  dynamicToolDefinitions?: ReadonlyMap<string, ToolDefinition>;
  knownToolNames: Set<string>;
  turnPlan: TurnSurfacePlan;
}): void {
  if (!input.dynamicToolDefinitions || input.dynamicToolDefinitions.size === 0) return;
  const knownOrDynamicToolNames = new Set([
    ...input.knownToolNames,
    ...input.dynamicToolDefinitions.keys(),
  ]);
  const allowedRequestedManagedToolNames = resolveAllowedRequestedManagedToolNames({
    runtime: input.runtime,
    knownToolNames: knownOrDynamicToolNames,
    turnPlan: input.turnPlan,
    dynamicToolDefinitions: input.dynamicToolDefinitions,
  });
  const namesToEnsure = input.turnPlan.repairRequired
    ? SKILL_REPAIR_ALLOWED_TOOL_NAMES.filter((toolName) => knownOrDynamicToolNames.has(toolName))
    : [
        ...input.turnPlan.requestedManagedToolNames.filter((toolName) =>
          allowedRequestedManagedToolNames.has(toolName),
        ),
        ...input.turnPlan.skillManagedToolNames.filter((toolName) =>
          isToolAllowedForPosture({
            runtime: input.runtime,
            toolName,
            posture: input.turnPlan.toolAvailabilityPosture,
            managed: true,
          }),
        ),
        ...input.turnPlan.lifecycleManagedToolNames.filter((toolName) =>
          isToolAllowedForPosture({
            runtime: input.runtime,
            toolName,
            posture: input.turnPlan.toolAvailabilityPosture,
            managed: true,
          }),
        ),
        ...input.turnPlan.operatorManagedToolNames.filter((toolName) =>
          isToolAllowedForPosture({
            runtime: input.runtime,
            toolName,
            posture: input.turnPlan.toolAvailabilityPosture,
            managed: true,
          }),
        ),
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
        resolveClassificationHints: options.resolveClassificationHints,
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

      const sessionId = getSessionId(ctx);
      if (!sessionId) {
        return undefined;
      }

      const toolName =
        typeof rawEvent.toolName === "string" ? normalizeToolName(rawEvent.toolName) : "";
      if (!TOOL_SURFACE_REFRESH_TOOL_NAMES.has(toolName)) {
        return undefined;
      }
      if (rawEvent.isError === true && !SKILL_LIFECYCLE_MUTATION_TOOL_NAMES.has(toolName)) {
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
        resolveClassificationHints: options.resolveClassificationHints,
      });
      if (!resolved) {
        return undefined;
      }

      const nextKey = computeSkillEnforcementKey(resolved);
      const previousKey = skillEnforcementKeyBySession.get(sessionId) ?? "";
      skillEnforcementKeyBySession.set(sessionId, nextKey);
      if (!TASK_CONTEXT_MUTATION_TOOL_NAMES.has(toolName)) {
        recommendationReceiptKeyBySession.set(
          sessionId,
          computeSkillRecommendationReceiptKey(resolved.recommendationSet),
        );
        return undefined;
      }
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
        recommendations.activationPosture.kind !== "require_skill_load" ||
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
