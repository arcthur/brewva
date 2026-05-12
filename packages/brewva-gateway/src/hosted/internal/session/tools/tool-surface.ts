import { TOOL_SURFACE_RESOLVED_EVENT_TYPE } from "@brewva/brewva-runtime/events";
import type {
  InternalHostPluginApi as ExtensionAPI,
  BrewvaHostToolInfo as ToolInfo,
  BrewvaHostToolResultEvent as ToolResultEvent,
} from "@brewva/brewva-substrate/host-api";
import type { BrewvaToolDefinition as ToolDefinition } from "@brewva/brewva-substrate/tools";
import {
  getBrewvaToolSurface,
  MANAGED_BREWVA_TOOL_NAMES,
  OPERATOR_BREWVA_TOOL_NAMES,
} from "@brewva/brewva-tools/registry";

const CAPABILITY_REQUEST_PATTERN = /\$([a-z][a-z0-9_]*)/g;

export interface ToolSurfaceRuntime {
  config: {
    skills: {
      routing: {
        scopes: readonly string[];
      };
    };
  };
  recordEvent(input: { sessionId: string; type: string; payload?: object }): unknown;
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

type SurfaceCounts = {
  managedActiveCount: number;
  baseActiveCount: number;
  skillActiveCount: number;
  controlPlaneActiveCount: number;
  operatorActiveCount: number;
  externalActiveCount: number;
  hiddenSkillCount: number;
  hiddenControlPlaneCount: number;
  hiddenOperatorCount: number;
};

function normalizeToolName(name: string): string {
  return name.trim().toLowerCase();
}

function toolRequiresInteractiveUi(toolName: string): boolean {
  return toolName === "question";
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

function isOperatorTool(toolName: string): boolean {
  return getBrewvaToolSurface(toolName) === "operator";
}

function shouldExposeManagedTool(input: {
  toolName: string;
  operatorProfile: boolean;
  hasUI: boolean;
}): boolean {
  if (!input.hasUI && toolRequiresInteractiveUi(input.toolName)) {
    return false;
  }
  if (isOperatorTool(input.toolName)) {
    return input.operatorProfile;
  }
  return true;
}

function computeSurfaceCounts(input: {
  allToolNames: readonly string[];
  activeToolNames: readonly string[];
}): SurfaceCounts {
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
      MANAGED_BREWVA_TOOL_NAMES.includes(toolName),
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

function registerMissingManagedTools(input: {
  extensionApi: ExtensionAPI;
  dynamicToolDefinitions?: ReadonlyMap<string, ToolDefinition>;
  knownToolNames: Set<string>;
  operatorProfile: boolean;
  hasUI: boolean;
}): void {
  if (!input.dynamicToolDefinitions || input.dynamicToolDefinitions.size === 0) return;

  for (const [rawToolName, toolDefinition] of input.dynamicToolDefinitions) {
    const toolName = normalizeToolName(rawToolName);
    if (!MANAGED_BREWVA_TOOL_NAMES.includes(toolName)) {
      continue;
    }
    if (input.knownToolNames.has(toolName)) {
      continue;
    }
    if (
      !shouldExposeManagedTool({
        toolName,
        operatorProfile: input.operatorProfile,
        hasUI: input.hasUI,
      })
    ) {
      continue;
    }
    input.extensionApi.registerTool(toolDefinition);
    input.knownToolNames.add(toolName);
  }
}

function resolveAndActivateToolSurface(input: {
  extensionApi: ExtensionAPI;
  runtime: ToolSurfaceRuntime;
  sessionId: string;
  prompt: string;
  hasUI: boolean;
  dynamicToolDefinitions?: ReadonlyMap<string, ToolDefinition>;
}): void {
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
    return;
  }

  const operatorProfile = isOperatorProfile(input.runtime);
  const requestedToolNames = extractRequestedToolNames(input.prompt);
  const requestedToolNameSet = new Set(requestedToolNames);
  const initialTools = allToolsGetter.call(input.extensionApi);
  const knownToolNames = new Set(
    Array.isArray(initialTools) ? initialTools.map((tool) => normalizeToolName(tool.name)) : [],
  );

  registerMissingManagedTools({
    extensionApi: input.extensionApi,
    dynamicToolDefinitions: input.dynamicToolDefinitions,
    knownToolNames,
    operatorProfile,
    hasUI: input.hasUI,
  });

  const allTools = allToolsGetter.call(input.extensionApi);
  if (!Array.isArray(allTools) || allTools.length === 0) {
    return;
  }

  const allToolNames = allTools.map((tool) => normalizeToolName(tool.name));
  const allToolNameSet = new Set(allToolNames);
  const active = new Set<string>();

  for (const toolName of activeToolsGetter.call(input.extensionApi)) {
    const normalized = normalizeToolName(toolName);
    if (allToolNameSet.has(normalized) && getBrewvaToolSurface(normalized) === undefined) {
      active.add(normalized);
    }
  }

  for (const toolName of allToolNames) {
    if (getBrewvaToolSurface(toolName) === undefined) {
      continue;
    }
    if (
      shouldExposeManagedTool({
        toolName,
        operatorProfile,
        hasUI: input.hasUI,
      })
    ) {
      active.add(toolName);
    }
  }

  const activeToolNames = [...active].toSorted();
  setActiveTools.call(input.extensionApi, activeToolNames);

  const requestedActivatedToolNames = requestedToolNames.filter((toolName) =>
    activeToolNames.includes(toolName),
  );
  const ignoredRequestedToolNames = requestedToolNames.filter(
    (toolName) => allToolNameSet.has(toolName) && !activeToolNames.includes(toolName),
  );
  const counts = computeSurfaceCounts({ allToolNames, activeToolNames });

  input.runtime.recordEvent({
    sessionId: input.sessionId,
    type: TOOL_SURFACE_RESOLVED_EVENT_TYPE,
    payload: {
      availableCount: allToolNames.length,
      activeCount: activeToolNames.length,
      activeToolNames,
      managedCount: MANAGED_BREWVA_TOOL_NAMES.length,
      managedActiveCount: counts.managedActiveCount,
      requestedToolNames: requestedToolNames.filter((toolName) => allToolNameSet.has(toolName)),
      requestedActivatedToolNames,
      ignoredRequestedToolNames,
      operatorProfile,
      baseActiveCount: counts.baseActiveCount,
      skillActiveCount: counts.skillActiveCount,
      controlPlaneActiveCount: counts.controlPlaneActiveCount,
      operatorActiveCount: counts.operatorActiveCount,
      externalActiveCount: counts.externalActiveCount,
      hiddenSkillCount: counts.hiddenSkillCount,
      hiddenControlPlaneCount: counts.hiddenControlPlaneCount,
      hiddenOperatorCount: counts.hiddenOperatorCount,
      modelOperated: true,
      removedGates: ["task_spec", "active_skill", "repair_posture"],
      operatorRequested: requestedToolNames.filter((toolName) =>
        OPERATOR_BREWVA_TOOL_NAMES.includes(toolName),
      ),
      requestedUnknownToolNames: requestedToolNames.filter(
        (toolName) => !allToolNameSet.has(toolName),
      ),
      requestedVisibleToolNames: [...requestedToolNameSet].filter((toolName) =>
        activeToolNames.includes(toolName),
      ),
    },
  });
}

export function createToolSurfaceLifecycle(
  extensionApi: ExtensionAPI,
  runtime: ToolSurfaceRuntime,
  options: RegisterToolSurfaceOptions = {},
): ToolSurfaceLifecycle {
  return {
    beforeAgentStart(event, ctx) {
      const rawEvent = event as { prompt?: unknown };
      const prompt = typeof rawEvent.prompt === "string" ? rawEvent.prompt : "";
      const sessionId = getSessionId(ctx);
      if (!sessionId) {
        return undefined;
      }

      resolveAndActivateToolSurface({
        extensionApi,
        runtime,
        sessionId,
        prompt,
        hasUI: (ctx as { hasUI?: boolean }).hasUI === true,
        dynamicToolDefinitions: options.dynamicToolDefinitions,
      });
      return undefined;
    },
    toolResult(_event, _ctx) {
      return undefined;
    },
    sessionShutdown(_event, _ctx) {
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
