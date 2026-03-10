import type { BrewvaRuntime, SkillDocument } from "@brewva/brewva-runtime";
import {
  BASE_BREWVA_TOOL_NAMES,
  getBrewvaToolSurface,
  MANAGED_BREWVA_TOOL_NAMES,
  OPERATOR_BREWVA_TOOL_NAMES,
  isManagedBrewvaToolName,
} from "@brewva/brewva-tools";
import type { ExtensionAPI, ToolInfo } from "@mariozechner/pi-coding-agent";

const CAPABILITY_REQUEST_PATTERN = /\$([a-z][a-z0-9_]*)/g;
const BUILTIN_ALWAYS_ON_TOOL_NAMES = ["read", "edit", "write"] as const;
const TOOL_SURFACE_RESOLVED_EVENT_TYPE = "tool_surface_resolved";

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

function isOperatorProfile(runtime: BrewvaRuntime): boolean {
  const profile = runtime.config.skills.routing.profile;
  if (profile === "operator" || profile === "full") {
    return true;
  }
  const scopes = new Set(runtime.config.skills.routing.scopes);
  return scopes.has("operator") || scopes.has("meta");
}

function appendSkillName(names: string[], skillName: string | null | undefined): void {
  if (typeof skillName !== "string") return;
  const trimmed = skillName.trim();
  if (!trimmed || names.includes(trimmed)) return;
  names.push(trimmed);
}

function resolveSurfaceSkills(runtime: BrewvaRuntime, sessionId: string): SkillDocument[] {
  const names: string[] = [];
  const active = runtime.skills.getActive(sessionId);
  const pendingDispatch = runtime.skills.getPendingDispatch(sessionId);
  const cascadeIntent = runtime.skills.getCascadeIntent(sessionId);

  appendSkillName(names, active?.name);
  appendSkillName(names, pendingDispatch?.primary?.name);
  appendSkillName(names, pendingDispatch?.chain[0]);
  appendSkillName(names, cascadeIntent?.steps[cascadeIntent.cursor]?.skill);

  return names
    .map((name) => runtime.skills.get(name))
    .filter((skill): skill is SkillDocument => skill !== undefined);
}

function collectSkillToolNames(skills: SkillDocument[]): string[] {
  const names = new Set<string>();
  for (const skill of skills) {
    for (const toolName of skill.contract.tools.required) {
      names.add(normalizeToolName(toolName));
    }
    for (const toolName of skill.contract.tools.optional) {
      names.add(normalizeToolName(toolName));
    }
  }
  return [...names];
}

function resolveRequestedOperatorToolNames(
  requestedToolNames: string[],
  knownToolNames: Set<string>,
): string[] {
  return requestedToolNames.filter((toolName) => {
    if (!knownToolNames.has(toolName)) return false;
    return getBrewvaToolSurface(toolName) === "operator";
  });
}

function resolveActiveToolNames(input: {
  runtime: BrewvaRuntime;
  sessionId: string;
  prompt: string;
  allTools: ToolInfo[];
  activeToolNames: string[];
}): {
  activeToolNames: string[];
  managedActiveCount: number;
  requestedToolNames: string[];
  requestedOperatorToolNames: string[];
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

  for (const toolName of input.activeToolNames) {
    const normalized = normalizeToolName(toolName);
    if (!knownToolNames.has(normalized)) continue;
    if (!isManagedBrewvaToolName(normalized)) {
      active.add(normalized);
    }
  }

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

  const requestedToolNames = extractRequestedToolNames(input.prompt).filter((toolName) =>
    knownToolNames.has(toolName),
  );
  const requestedOperatorToolNames = resolveRequestedOperatorToolNames(
    requestedToolNames,
    knownToolNames,
  );
  for (const toolName of requestedOperatorToolNames) {
    active.add(toolName);
  }

  const surfaceSkills = resolveSurfaceSkills(input.runtime, input.sessionId);
  for (const toolName of collectSkillToolNames(surfaceSkills)) {
    if (knownToolNames.has(toolName)) {
      active.add(toolName);
    }
  }

  if (surfaceSkills.length > 0 && knownToolNames.has("skill_complete")) {
    active.add("skill_complete");
  }
  if (
    input.runtime.skills.getPendingDispatch(input.sessionId) &&
    knownToolNames.has("skill_route_override")
  ) {
    active.add("skill_route_override");
  }
  if (
    input.runtime.skills.getCascadeIntent(input.sessionId) &&
    knownToolNames.has("skill_chain_control")
  ) {
    active.add("skill_chain_control");
  }

  const operatorProfile = isOperatorProfile(input.runtime);
  if (operatorProfile) {
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
    requestedToolNames,
    requestedOperatorToolNames,
    ignoredRequestedToolNames: requestedToolNames.filter(
      (toolName) => !requestedOperatorToolNames.includes(toolName),
    ),
    skillNames: surfaceSkills.map((skill) => skill.name),
    operatorProfile,
    baseActiveCount,
    skillActiveCount,
    operatorActiveCount,
    externalActiveCount,
    hiddenSkillCount,
    hiddenOperatorCount,
  };
}

export function registerToolSurface(pi: ExtensionAPI, runtime: BrewvaRuntime): void {
  pi.on("before_agent_start", (event, ctx) => {
    const allToolsGetter = (pi as { getAllTools?: () => ToolInfo[] }).getAllTools;
    const activeToolsGetter = (pi as { getActiveTools?: () => string[] }).getActiveTools;
    const setActiveTools = (pi as { setActiveTools?: (toolNames: string[]) => void })
      .setActiveTools;
    if (
      typeof allToolsGetter !== "function" ||
      typeof activeToolsGetter !== "function" ||
      typeof setActiveTools !== "function"
    ) {
      return undefined;
    }

    const allTools = allToolsGetter.call(pi);
    if (!Array.isArray(allTools) || allTools.length === 0) {
      return undefined;
    }

    const prompt = typeof (event as { prompt?: unknown }).prompt === "string" ? event.prompt : "";
    const sessionId = ctx.sessionManager.getSessionId();
    const resolved = resolveActiveToolNames({
      runtime,
      sessionId,
      prompt,
      allTools,
      activeToolNames: activeToolsGetter.call(pi),
    });
    setActiveTools.call(pi, resolved.activeToolNames);

    runtime.events.record({
      sessionId,
      type: TOOL_SURFACE_RESOLVED_EVENT_TYPE,
      payload: {
        availableCount: allTools.length,
        activeCount: resolved.activeToolNames.length,
        managedCount: MANAGED_BREWVA_TOOL_NAMES.length,
        managedActiveCount: resolved.managedActiveCount,
        requestedToolNames: resolved.requestedToolNames,
        requestedOperatorToolNames: resolved.requestedOperatorToolNames,
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
  });
}
