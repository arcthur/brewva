import type { CapabilityManifest, CapabilitySelectionReceipt } from "@brewva/brewva-capabilities";
import { carryCapabilitySelection } from "@brewva/brewva-capabilities";
import type { ToolActionClass } from "@brewva/brewva-runtime/security";
import type {
  BrewvaHostBeforeAgentStartResult,
  InternalHostPluginApi as ExtensionAPI,
  BrewvaHostToolInfo as ToolInfo,
  BrewvaHostToolResultEvent as ToolResultEvent,
} from "@brewva/brewva-substrate/host-api";
import { appendBrewvaSystemPromptTextSection } from "@brewva/brewva-substrate/prompt";
import type { BrewvaToolDefinition as ToolDefinition } from "@brewva/brewva-substrate/tools";
import {
  getBrewvaToolSurface,
  getBrewvaToolMetadata,
  MANAGED_BREWVA_TOOL_METADATA_BY_NAME,
  MANAGED_BREWVA_TOOL_NAMES,
  OPERATOR_BREWVA_TOOL_NAMES,
} from "@brewva/brewva-tools/registry";
import { recordRuntimeToolSurfaceResolved } from "../runtime-ports.js";
import {
  readLatestSkillSelectionReceipt,
  skillSelectionSummaryForTrace,
} from "../skills/skill-selection.js";
import {
  formatCapabilitySelectionSection,
  loadRuntimeCapabilityRegistry,
  recordCapabilitySelectionReceipt,
  readLatestCapabilitySelectionReceipt,
  resolveCapabilityAuthorityAccess,
  selectCapabilityReceiptForPrompt,
} from "./capability-selection.js";

const CAPABILITY_REQUEST_PATTERN = /\$([a-z][a-z0-9_]*)/g;

export interface ToolSurfaceRuntime {
  identity: {
    cwd: string;
    workspaceRoot: string;
  };
  config: {
    readonly capabilities: {
      readonly roots: readonly string[];
      readonly defaults: Readonly<Record<string, string>>;
      readonly policy: {
        readonly agentScope: readonly string[];
        readonly workspaceScope: readonly string[];
        readonly allowedAccounts: readonly string[];
      };
    };
  };
  ops: {
    skills: {
      selection: {
        latest(sessionId: string): object | undefined;
      };
    };
    tools: {
      capabilitySelection: {
        latest(sessionId: string): object | undefined;
        record(sessionId: string, receipt: object): unknown;
      };
      surface: {
        recordResolved(sessionId: string, payload: object): unknown;
      };
    };
    goal: {
      state: {
        get(sessionId: string): { readonly status?: string } | null;
      };
    };
  };
}

export interface RegisterToolSurfaceOptions {
  dynamicToolDefinitions?: ReadonlyMap<string, ToolDefinition>;
}

export interface ToolSurfaceLifecycle {
  beforeAgentStart: (event: unknown, ctx: unknown) => BrewvaHostBeforeAgentStartResult | undefined;
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
  skillSurfaceToolActiveCount: number;
  controlPlaneActiveCount: number;
  operatorActiveCount: number;
  externalActiveCount: number;
  hiddenSkillSurfaceToolCount: number;
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
  // TODO(capability-authority): reconnect durable operator profiles here if Brewva
  // adds a profile authority. Until then, selected capability receipts are the
  // only path that can expose operator-surface tools.
  void runtime;
  return false;
}

function isOperatorTool(toolName: string): boolean {
  return getBrewvaToolSurface(toolName) === "operator";
}

function isGoalTool(toolName: string): boolean {
  return toolName === "get_goal" || toolName === "update_goal";
}

function resolveToolActionClass(input: {
  toolName: string;
  dynamicToolDefinitions?: ReadonlyMap<string, ToolDefinition>;
}): ToolActionClass | undefined {
  return (
    getBrewvaToolMetadata(input.dynamicToolDefinitions?.get(input.toolName))?.actionClass ??
    MANAGED_BREWVA_TOOL_METADATA_BY_NAME[
      input.toolName as keyof typeof MANAGED_BREWVA_TOOL_METADATA_BY_NAME
    ]?.actionClass
  );
}

function resolveCapabilityAccessForTool(input: {
  toolName: string;
  actionClass?: ToolActionClass;
  selectedCapabilityReceipt?: CapabilitySelectionReceipt;
  capabilityManifests: readonly CapabilityManifest[];
}): ReturnType<typeof resolveCapabilityAuthorityAccess> {
  return resolveCapabilityAuthorityAccess({
    receipt: input.selectedCapabilityReceipt,
    manifests: input.capabilityManifests,
    toolName: input.toolName,
    actionClass: input.actionClass,
    forceCapabilityGate: isOperatorTool(input.toolName),
  });
}

function shouldExposeManagedTool(input: {
  toolName: string;
  operatorProfile: boolean;
  hasUI: boolean;
  goalActive: boolean;
  actionClass?: ToolActionClass;
  selectedCapabilityReceipt?: CapabilitySelectionReceipt;
  capabilityManifests: readonly CapabilityManifest[];
}): boolean {
  if (!input.hasUI && toolRequiresInteractiveUi(input.toolName)) {
    return false;
  }
  if (isGoalTool(input.toolName) && !input.goalActive) {
    return false;
  }
  const capabilityAccess = resolveCapabilityAccessForTool({
    toolName: input.toolName,
    actionClass: input.actionClass,
    selectedCapabilityReceipt: input.selectedCapabilityReceipt,
    capabilityManifests: input.capabilityManifests,
  });
  if (!capabilityAccess.allowed) {
    return false;
  }
  const explicitlyAuthorized = capabilityAccess.advisory?.startsWith(
    "selected_capability_authorized:",
  );
  if (isOperatorTool(input.toolName)) {
    return input.operatorProfile || explicitlyAuthorized === true;
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
    skillSurfaceToolActiveCount: countActiveBySurface("skill"),
    controlPlaneActiveCount: countActiveBySurface("control_plane"),
    operatorActiveCount: countActiveBySurface("operator"),
    externalActiveCount: countActiveBySurface(undefined),
    hiddenSkillSurfaceToolCount: countHiddenBySurface("skill"),
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
  goalActive: boolean;
  selectedCapabilityReceipt?: CapabilitySelectionReceipt;
  capabilityManifests: readonly CapabilityManifest[];
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
        goalActive: input.goalActive,
        actionClass: resolveToolActionClass({
          toolName,
          dynamicToolDefinitions: input.dynamicToolDefinitions,
        }),
        selectedCapabilityReceipt: input.selectedCapabilityReceipt,
        capabilityManifests: input.capabilityManifests,
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
  selectedCapabilityReceipt?: CapabilitySelectionReceipt;
  capabilityManifests: readonly CapabilityManifest[];
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
  const goalActive = input.runtime.ops.goal.state.get(input.sessionId)?.status === "active";
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
    goalActive,
    selectedCapabilityReceipt: input.selectedCapabilityReceipt,
    capabilityManifests: input.capabilityManifests,
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
        goalActive,
        actionClass: resolveToolActionClass({
          toolName,
          dynamicToolDefinitions: input.dynamicToolDefinitions,
        }),
        selectedCapabilityReceipt: input.selectedCapabilityReceipt,
        capabilityManifests: input.capabilityManifests,
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
  const skillSelection = skillSelectionSummaryForTrace(
    readLatestSkillSelectionReceipt({
      runtime: input.runtime,
      sessionId: input.sessionId,
    }),
  );

  recordRuntimeToolSurfaceResolved(input.runtime, input.sessionId, {
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
    skillSurfaceToolActiveCount: counts.skillSurfaceToolActiveCount,
    controlPlaneActiveCount: counts.controlPlaneActiveCount,
    operatorActiveCount: counts.operatorActiveCount,
    externalActiveCount: counts.externalActiveCount,
    hiddenSkillSurfaceToolCount: counts.hiddenSkillSurfaceToolCount,
    hiddenControlPlaneCount: counts.hiddenControlPlaneCount,
    hiddenOperatorCount: counts.hiddenOperatorCount,
    modelOperated: true,
    removedGates: ["task_spec", "repair_posture"],
    operatorRequested: requestedToolNames.filter((toolName) =>
      OPERATOR_BREWVA_TOOL_NAMES.includes(toolName),
    ),
    ...skillSelection,
    selectedCapabilityNames:
      input.selectedCapabilityReceipt?.selected_capabilities.map((entry) => entry.name) ?? [],
    capabilitySelectionId: input.selectedCapabilityReceipt?.selection_id ?? null,
    requestedUnknownToolNames: requestedToolNames.filter(
      (toolName) => !allToolNameSet.has(toolName),
    ),
    requestedVisibleToolNames: [...requestedToolNameSet].filter((toolName) =>
      activeToolNames.includes(toolName),
    ),
  });
}

export function createToolSurfaceLifecycle(
  extensionApi: ExtensionAPI,
  runtime: ToolSurfaceRuntime,
  options: RegisterToolSurfaceOptions = {},
): ToolSurfaceLifecycle {
  return {
    beforeAgentStart(event, ctx) {
      const rawEvent = event as { prompt?: unknown; systemPrompt?: unknown };
      const prompt = typeof rawEvent.prompt === "string" ? rawEvent.prompt : "";
      const sessionId = getSessionId(ctx);
      if (!sessionId) {
        return undefined;
      }
      const previousReceipt = readLatestCapabilitySelectionReceipt({ runtime, sessionId });
      const carried = prompt.trim().length === 0 && previousReceipt !== undefined;
      const selection = carried
        ? {
            registry: loadRuntimeCapabilityRegistry(runtime),
            receipt: carryCapabilitySelection({ previous: previousReceipt }),
          }
        : selectCapabilityReceiptForPrompt({
            runtime,
            prompt,
          });
      const { registry, receipt } = selection;
      recordCapabilitySelectionReceipt({
        runtime,
        sessionId,
        receipt,
      });

      resolveAndActivateToolSurface({
        extensionApi,
        runtime,
        sessionId,
        prompt,
        hasUI: (ctx as { hasUI?: boolean }).hasUI === true,
        dynamicToolDefinitions: options.dynamicToolDefinitions,
        selectedCapabilityReceipt: receipt,
        capabilityManifests: registry.manifests,
      });
      const capabilitySection = formatCapabilitySelectionSection({
        receipt,
        manifests: registry.manifests,
      });
      if (!capabilitySection) {
        return undefined;
      }
      const systemPrompt = typeof rawEvent.systemPrompt === "string" ? rawEvent.systemPrompt : "";
      return {
        systemPrompt: appendBrewvaSystemPromptTextSection({
          systemPrompt,
          section: capabilitySection,
        }),
      };
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
